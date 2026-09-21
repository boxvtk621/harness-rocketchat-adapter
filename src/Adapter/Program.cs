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
    Results.Ok((await store.ListAsync(ct)).Select(ConnectionResponse.From)));
connections.MapGet("/{id}", async (string id, IConnectionRepository store, CancellationToken ct) =>
{
    var item = await store.GetAsync(id, ct);
    return item is null ? Results.NotFound() : Results.Ok(ConnectionResponse.From(item));
});
connections.MapPost("/", async (ConnectionRequest input, IConnectionRepository store, HarnessAddressPolicy addresses,
    ICentrifugoPublisher publisher, ILoggerFactory logs, CancellationToken ct) =>
{
    var validation = ConnectionInput.Validate(input, addresses);
    if (validation.Error is not null) return Results.ValidationProblem(validation.Error);
    var now = DateTimeOffset.UtcNow;
    var item = new Connection(Guid.NewGuid().ToString("N"), validation.Name!, validation.BaseUri!, 1,
        validation.Settings!, Observation.Unknown, now, now);
    await store.CreateAsync(item, ct);
    await publisher.PublishInvalidationAsync("connections", item.Id, "created", ct);
    logs.CreateLogger("Connections").LogInformation("Connection {ConnectionId} created", item.Id);
    return Results.Created($"/api/connections/{item.Id}", ConnectionResponse.From(item));
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
    return Results.Ok(ConnectionResponse.From(item));
});

var projections = app.MapGroup("/api/projections").RequireInternalToken();
projections.MapGet("/nodes", async (IConnectionRepository store, CancellationToken ct) =>
    Results.Ok((await store.ListAsync(ct)).Select(NodeProjection.From)));
projections.MapGet("/work", async (IConnectionRepository store, IHarnessClient client, CancellationToken ct) =>
{
    try { return Results.Ok(await HarnessProjectionReader.ReadWorkAsync(await store.ListAsync(ct), client, ct)); }
    catch (ProjectionUnavailableException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
});
projections.MapGet("/history", async (IConnectionRepository store, IHarnessClient client, CancellationToken ct) =>
{
    try { return Results.Ok(await HarnessProjectionReader.ReadHistoryAsync(await store.ListAsync(ct), client, ct)); }
    catch (ProjectionUnavailableException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
});

app.Run();

void LoadSecret(string configurationKey, string fileSetting)
{
    var path = builder.Configuration[fileSetting];
    if (!string.IsNullOrWhiteSpace(path)) builder.Configuration[configurationKey] = File.ReadAllText(path).Trim();
}

public partial class Program;
