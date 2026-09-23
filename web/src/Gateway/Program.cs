using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
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
builder.Services.AddAuthorization(options => options.AddPolicy("connections.manage", policy =>
    policy.RequireAuthenticatedUser().RequireAssertion(context => ConnectionPermissions.CanManage(context.User))));
builder.Logging.AddFilter("System.Net.Http.HttpClient.adapter", LogLevel.Warning);
builder.Services.AddHttpClient("adapter", client =>
{
    client.BaseAddress = new Uri(adapterBaseUrl);
    client.DefaultRequestHeaders.Add("X-Internal-Token", adapterToken);
}).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false });
builder.Services.AddHealthChecks().AddCheck<AdapterHealthCheck>("adapter", tags: ["ready"]);

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.Use(async (context, next) =>
{
    var sensitive = context.Request.Path.Value?.Contains("/provider-auth", StringComparison.OrdinalIgnoreCase) == true ||
        context.Request.Path.Value?.Contains("/node-settings", StringComparison.OrdinalIgnoreCase) == true;
    if (sensitive)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        var size = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        var limit = context.Request.Path.Value?.Contains("/node-settings", StringComparison.OrdinalIgnoreCase) == true ? 262144 : 32768;
        if (size is { IsReadOnly: false }) size.MaxRequestBodySize = limit;
        if (context.Request.ContentLength > limit)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return;
        }
    }
    if (context.Request.Path.StartsWithSegments("/api/connections") &&
        (sensitive || context.Request.Method != "GET") &&
        context.User.Identity?.IsAuthenticated == true && !ConnectionPermissions.CanManage(context.User))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    await next(context);
});

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = r => r.Tags.Contains("ready") });

app.MapGet("/api/session", (ClaimsPrincipal user) => Results.Ok(new
{
    subject = user.FindFirstValue("sub"),
    name = user.FindFirstValue("preferred_username") ?? user.Identity?.Name,
    canManageConnections = ConnectionPermissions.CanManage(user)
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

app.MapMethods("/api/connections/{id}/provider-auth/{**authPath}", ["GET", "POST"],
    (HttpContext context, IHttpClientFactory factory, string id, string? authPath) =>
        ProxyToAdapter(context, factory, $"{id}/provider-auth" + (string.IsNullOrEmpty(authPath) ? "" : $"/{authPath}")))
    .RequireAuthorization("connections.manage");
app.MapMethods("/api/connections/{id}/node-settings/{**settingsPath}", ["GET", "POST", "PUT"],
    (HttpContext context, IHttpClientFactory factory, string id, string? settingsPath) =>
        ProxyToAdapter(context, factory, $"{id}/node-settings" + (string.IsNullOrEmpty(settingsPath) ? "" : $"/{settingsPath}")))
    .RequireAuthorization("connections.manage");
app.MapMethods("/api/connections/{**path}", ["GET", "POST", "PUT", "DELETE"], ProxyToAdapter)
    .RequireAuthorization();
app.MapMethods("/api/connections", ["GET", "POST"], ProxyToAdapter)
    .RequireAuthorization();
app.MapGet("/api/projections/nodes", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/nodes")).RequireAuthorization();
app.MapGet("/api/projections/work", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/work")).RequireAuthorization();
app.MapGet("/api/projections/history", (HttpContext context, IHttpClientFactory factory) => ProxyToAdapter(context, factory, "projections/history")).RequireAuthorization();
app.MapMethods("/api/dialogs/{**path}", ["GET", "POST"],
    (HttpContext context, IHttpClientFactory factory, string path) => ProxyToAdapter(context, factory, $"dialogs/{path}"))
    .RequireAuthorization();

app.Run();

async Task ProxyToAdapter(HttpContext context, IHttpClientFactory factory, string? path = null)
{
    var target = string.IsNullOrEmpty(path) ? "api/connections" :
        path.StartsWith("projections/", StringComparison.Ordinal) || path.StartsWith("dialogs/", StringComparison.Ordinal)
            ? $"api/{path}" : $"api/connections/{path}";
    var nodeSettings = target.Contains("/node-settings", StringComparison.Ordinal);
    if (target.StartsWith("api/dialogs/", StringComparison.Ordinal) || nodeSettings) context.Response.Headers.CacheControl = "no-store";
    using var request = new HttpRequestMessage(new HttpMethod(context.Request.Method), target + context.Request.QueryString);
    if (target.StartsWith("api/dialogs/", StringComparison.Ordinal) && HttpMethods.IsPost(context.Request.Method))
        foreach (var header in new[] { "X-Harness-Expected-Node-ID", "X-Harness-Expected-Registry-Version", "X-Harness-Expected-Identity-Epoch", "X-Harness-Expected-Adapter-Kind", "X-Harness-Expected-Adapter-Version" })
            if (context.Request.Headers.TryGetValue(header, out var values)) request.Headers.TryAddWithoutValidation(header, values.ToArray());

    if (context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
    {
        var boundedLimit = nodeSettings ? 262144 :
            context.Request.Path.Value?.Contains("/provider-auth", StringComparison.OrdinalIgnoreCase) == true ? 32768 : 0;
        if (boundedLimit > 0)
        {
            // Read at most one bounded command before forwarding anything upstream.
            // This is transient memory, never request logging or persistent storage.
            using var bounded = new MemoryStream();
            var chunk = new byte[4096];
            try
            {
                int length;
                while ((length = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
                {
                    if (bounded.Length + length > boundedLimit)
                    {
                        context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                        return;
                    }
                    bounded.Write(chunk, 0, length);
                }
            }
            catch (BadHttpRequestException error)
            {
                context.Response.StatusCode = error.StatusCode;
                return;
            }
            request.Content = new ByteArrayContent(bounded.ToArray());
        }
        else request.Content = new StreamContent(context.Request.Body);
        if (!string.IsNullOrWhiteSpace(context.Request.ContentType))
            request.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(context.Request.ContentType);
    }

    using var response = await factory.CreateClient("adapter").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, context.RequestAborted);
    context.Response.StatusCode = (int)response.StatusCode;
    context.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
    if (response.Headers.CacheControl?.NoStore == true) context.Response.Headers.CacheControl = "no-store";
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

public static class ConnectionPermissions
{
    public static bool CanManage(ClaimsPrincipal user)
    {
        foreach (var claim in user.FindAll("realm_access"))
        {
            try
            {
                using var json = JsonDocument.Parse(claim.Value);
                if (json.RootElement.TryGetProperty("roles", out var roles) && roles.ValueKind == JsonValueKind.Array &&
                    roles.EnumerateArray().Any(role => role.ValueKind == JsonValueKind.String && role.GetString() == "connections.manage"))
                    return true;
            }
            catch (JsonException) { }
        }
        return false;
    }
}
