using System.Net.Http.Headers;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using MongoDB.Driver;

var builder = WebApplication.CreateBuilder(args);

LoadSecret("Mongo:ConnectionString", "MONGODB_CONNECTION_STRING_FILE");
LoadSecret("InternalAuth:Token", "ADAPTER_INTERNAL_TOKEN_FILE");
LoadSecret("Centrifugo:ApiKey", "CENTRIFUGO_API_KEY_FILE");

builder.Services.AddOptions<MongoOptions>().BindConfiguration("Mongo").ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<InternalAuthOptions>().BindConfiguration("InternalAuth").ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<CentrifugoOptions>().BindConfiguration("Centrifugo");
builder.Services.AddOptions<HarnessOptions>().BindConfiguration("Harness").ValidateOnStart();
builder.Services.AddSingleton<IMongoClient>(sp => new MongoClient(sp.GetRequiredService<IOptions<MongoOptions>>().Value.ConnectionString));
builder.Services.AddSingleton<IConnectionRepository, MongoConnectionRepository>();
builder.Services.AddSingleton<HarnessAddressPolicy>();
builder.Services.AddDialogServices();
builder.Logging.AddFilter("System.Net.Http.HttpClient.IDialogHarnessClient", LogLevel.Warning);
builder.Services.AddHttpClient<IHarnessClient, HarnessClient>(client =>
{
    client.Timeout = Timeout.InfiniteTimeSpan;
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
}).ConfigurePrimaryHttpMessageHandler(sp => HarnessTls.CreateHandler(sp.GetRequiredService<IOptions<HarnessOptions>>()));
builder.Logging.AddFilter("System.Net.Http.HttpClient.IHarnessClient", LogLevel.Warning);
builder.Logging.AddFilter("System.Net.Http.HttpClient.HarnessClient", LogLevel.Warning);
builder.Services.AddHostedService<HarnessObservationService>();
builder.Services.AddHostedService<HarnessEventInvalidationService>();
builder.Services.AddHttpClient<ICentrifugoPublisher, CentrifugoPublisher>();
builder.Services.AddHealthChecks().AddCheck<MongoReadinessHealthCheck>("mongodb-ready", tags: ["ready"]);

var app = builder.Build();

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = check => check.Tags.Contains("ready") });

var connections = app.MapGroup("/api/connections").RequireInternalToken();
connections.MapGet("/", async (IConnectionRepository store, CancellationToken ct) =>
{
    var items = await store.ListAsync(ct);
    var identities = ConnectionIdentity.Analyze(items);
    return Results.Ok(items.Select(x => ConnectionResponse.From(x, identities[x.Id])));
});
connections.MapGet("/{id}", async (string id, IConnectionRepository store, CancellationToken ct) =>
{
    var item = await store.GetAsync(id, ct);
    if (item is null) return Results.NotFound();
    var identities = ConnectionIdentity.Analyze(await store.ListAsync(ct));
    identities.TryGetValue(item.Id, out var identity);
    return Results.Ok(ConnectionResponse.From(item, identity));
});
connections.MapPost("/", async (ConnectionRequest input, IConnectionRepository store, HarnessAddressPolicy addresses,
    ICentrifugoPublisher publisher, ILoggerFactory logs, HttpContext context, CancellationToken ct) =>
{
    var validation = ConnectionInput.Validate(input, addresses);
    if (validation.Error is not null) return Results.ValidationProblem(validation.Error);
    var now = DateTimeOffset.UtcNow;
    var item = new Connection(Guid.NewGuid().ToString("N"), validation.Name!, validation.BaseUri!, 1,
        validation.Settings!, Observation.Unknown, now, now);
    var result = await store.CreateOrGetAsync(item, ct);
    var all = await store.ListAsync(ct);
    var identities = ConnectionIdentity.Analyze(all);
    identities.TryGetValue(result.Connection.Id, out var identity);
    var response = ConnectionResponse.From(result.Connection, identity);
    if (!result.Created)
    {
        context.Response.Headers["X-Connection-Reused"] = "true";
        return Results.Ok(response);
    }
    await publisher.PublishInvalidationAsync("connections", result.Connection.Id, "created", ct);
    logs.CreateLogger("Connections").LogInformation("Connection {ConnectionId} created", result.Connection.Id);
    return Results.Created($"/api/connections/{result.Connection.Id}", response);
});
connections.MapPut("/{id}", async (string id, ConnectionRequest input, IConnectionRepository store,
    HarnessAddressPolicy addresses, ICentrifugoPublisher publisher, ILoggerFactory logs, CancellationToken ct) =>
{
    var validation = ConnectionInput.Validate(input, addresses);
    if (validation.Error is not null) return Results.ValidationProblem(validation.Error);
    var old = await store.GetAsync(id, ct);
    if (old is null) return Results.NotFound();
    var uriChanged = !string.Equals(old.BaseUri, validation.BaseUri, StringComparison.Ordinal);
    var item = old with
    {
        Name = validation.Name!, BaseUri = validation.BaseUri!, Settings = validation.Settings!,
        ConfigEpoch = checked(old.ConfigEpoch + 1),
        Observation = uriChanged ? Observation.Unknown : old.Observation,
        UpdatedAt = DateTimeOffset.UtcNow
    };
    if (!await store.ReplaceAsync(item, old.ConfigEpoch, ct)) return Results.Conflict(new { detail = "Connection changed concurrently; reload and retry." });
    await publisher.PublishInvalidationAsync("connections", item.Id, "updated", ct);
    logs.CreateLogger("Connections").LogInformation("Connection {ConnectionId} updated at epoch {ConfigEpoch}", item.Id, item.ConfigEpoch);
    var all = await store.ListAsync(ct);
    var identities = ConnectionIdentity.Analyze(all);
    identities.TryGetValue(item.Id, out var identity);
    return Results.Ok(ConnectionResponse.From(item, identity));
});

var projections = app.MapGroup("/api/projections").RequireInternalToken();
projections.MapGet("/nodes", async (IConnectionRepository store, CancellationToken ct) =>
{
    var items = await store.ListAsync(ct);
    var identities = ConnectionIdentity.Analyze(items);
    var result = items
        .GroupBy(x => x.Observation.Compatibility == "compatible" && Guid.TryParse(x.Observation.NodeId, out var id)
            ? $"node:{id:D}" : $"endpoint:{ConnectionIdentity.EndpointKey(x)}", StringComparer.Ordinal)
        .Select(group => group.OrderBy(x => x.Id, StringComparer.Ordinal).First())
        .Select(x => NodeProjection.From(x, identities[x.Id]));
    return Results.Ok(result);
});
projections.MapGet("/work", async (IConnectionRepository store, IHarnessClient client, CancellationToken ct) =>
{
    var items = await store.ListAsync(ct);
    var conflicts = ConnectionIdentity.FindConflicts(items);
    if (conflicts.Count > 0) return Results.Conflict(new { code = "node_id_conflict", conflicts });
    try { return Results.Ok(await HarnessProjectionReader.ReadWorkAsync(items, client, ct)); }
    catch (ProjectionUnavailableException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
});
projections.MapGet("/history", async (IConnectionRepository store, IHarnessClient client, CancellationToken ct) =>
{
    var items = await store.ListAsync(ct);
    var conflicts = ConnectionIdentity.FindConflicts(items);
    if (conflicts.Count > 0) return Results.Conflict(new { code = "node_id_conflict", conflicts });
    try { return Results.Ok(await HarnessProjectionReader.ReadHistoryAsync(items, client, ct)); }
    catch (ProjectionUnavailableException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
});

app.MapDialogs();
app.Run();

void LoadSecret(string configurationKey, string fileSetting)
{
    var path = builder.Configuration[fileSetting];
    if (!string.IsNullOrWhiteSpace(path)) builder.Configuration[configurationKey] = File.ReadAllText(path).Trim();
}

public partial class Program;
