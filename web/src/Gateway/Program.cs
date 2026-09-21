using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

var adapterBaseUrl = Required("ADAPTER_BASE_URL");
var adapterToken = ReadSecret("ADAPTER_INTERNAL_TOKEN");
var oidcMetadataAddress = Required("OIDC_METADATA_ADDRESS");
var oidcIssuer = Required("OIDC_ISSUER");
var oidcAudience = builder.Configuration["OIDC_AUDIENCE"] ?? "harness-web";
var centrifugoClientSecret = ReadSecret("CENTRIFUGO_CLIENT_TOKEN_SECRET");

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;
        options.MetadataAddress = oidcMetadataAddress;
        options.RequireHttpsMetadata = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = oidcIssuer,
            ValidateAudience = true,
            ValidAudience = oidcAudience,
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30)
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddHttpClient("adapter", client =>
{
    client.BaseAddress = new Uri(adapterBaseUrl);
    client.DefaultRequestHeaders.Add("X-Internal-Token", adapterToken);
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHealthChecks().AddCheck<AdapterHealthCheck>("adapter", tags: ["ready"]);

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = r => r.Tags.Contains("ready") });

app.MapGet("/api/session", (ClaimsPrincipal user) => Results.Ok(new
{
    subject = user.FindFirstValue("sub"),
    name = user.FindFirstValue("preferred_username") ?? user.Identity?.Name
})).RequireAuthorization();

app.MapGet("/api/realtime/token", (ClaimsPrincipal user) =>
{
    var subject = user.FindFirstValue("sub") ?? throw new InvalidOperationException("Authenticated token has no subject.");
    var now = DateTimeOffset.UtcNow;
    var descriptor = new SecurityTokenDescriptor
    {
        Subject = new ClaimsIdentity([new Claim(JwtRegisteredClaimNames.Sub, subject)]),
        Expires = now.AddMinutes(5).UtcDateTime,
        IssuedAt = now.UtcDateTime,
        SigningCredentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(centrifugoClientSecret)),
            SecurityAlgorithms.HmacSha256)
    };
    var handler = new JwtSecurityTokenHandler();
    return Results.Ok(new { token = handler.WriteToken(handler.CreateToken(descriptor)) });
}).RequireAuthorization();

app.MapMethods("/api/connections/{**path}", ["GET", "POST", "PUT", "DELETE"], ProxyToAdapter)
    .RequireAuthorization();
app.MapMethods("/api/connections", ["GET", "POST"], ProxyToAdapter)
    .RequireAuthorization();
app.MapGet("/api/projections/nodes", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/nodes")).RequireAuthorization();
app.MapGet("/api/projections/work", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/work")).RequireAuthorization();
app.MapGet("/api/projections/history", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/history")).RequireAuthorization();

app.Run();

async Task ProxyToAdapter(HttpContext context, IHttpClientFactory factory, string? path = null)
{
    var target = string.IsNullOrEmpty(path) ? "api/connections" :
        path.StartsWith("projections/", StringComparison.Ordinal) ? $"api/{path}" : $"api/connections/{path}";
    using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), target + context.Request.QueryString);

    if (context.Request.ContentLength is > 0)
    {
        request.Content = new StreamContent(context.Request.Body);
        if (!string.IsNullOrWhiteSpace(context.Request.ContentType))
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(context.Request.ContentType);
    }

    using var response = await factory.CreateClient("adapter").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
    context.Response.StatusCode = (int)response.StatusCode;
    context.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
    if (response.Headers.TryGetValues("X-Connection-Reused", out var reused))
        context.Response.Headers["X-Connection-Reused"] = reused.ToArray();
    await response.Content.CopyToAsync(context.Response.Body, context.RequestAborted);
}

string Required(string name) => builder.Configuration[name]
    ?? throw new InvalidOperationException($"Required infrastructure setting {name} is missing.");

string ReadSecret(string name)
{
    var file = builder.Configuration[$"{name}_FILE"];
    if (!string.IsNullOrWhiteSpace(file)) return File.ReadAllText(file).Trim();
    return Required(name);
}

sealed class AdapterHealthCheck(IHttpClientFactory clients) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await clients.CreateClient("adapter").GetAsync("health/ready", cancellationToken);
            return response.IsSuccessStatusCode ? HealthCheckResult.Healthy() : HealthCheckResult.Unhealthy($"Adapter returned {(int)response.StatusCode}.");
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("Adapter is unavailable.", ex);
        }
    }
}

public partial class Program;
