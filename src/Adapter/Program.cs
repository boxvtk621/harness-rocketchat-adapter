using System.Net.Http.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

var builder = WebApplication.CreateBuilder(args);

LoadSecret("Mongo:ConnectionString", "MONGODB_CONNECTION_STRING_FILE");
LoadSecret("InternalAuth:Token", "ADAPTER_INTERNAL_TOKEN_FILE");
LoadSecret("Centrifugo:ApiKey", "CENTRIFUGO_API_KEY_FILE");

builder.Services.AddOptions<MongoOptions>().BindConfiguration("Mongo").ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<InternalAuthOptions>().BindConfiguration("InternalAuth").ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddOptions<CentrifugoOptions>().BindConfiguration("Centrifugo");
builder.Services.AddSingleton<IMongoClient>(sp => new MongoClient(sp.GetRequiredService<IOptions<MongoOptions>>().Value.ConnectionString));
builder.Services.AddSingleton<IConnectionRepository, MongoConnectionRepository>();
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
connections.MapPost("/", async (ConnectionRequest input, IConnectionRepository store, ICentrifugoPublisher publisher, ILoggerFactory logs, CancellationToken ct) =>
{
    var validation = ConnectionInput.Validate(input);
    if (validation.Error is not null) return Results.ValidationProblem(validation.Error);
    var now = DateTimeOffset.UtcNow;
    var item = new Connection(Guid.NewGuid().ToString("N"), validation.Name!, validation.BaseUri!, now, now);
    await store.CreateAsync(item, ct);
    await publisher.PublishSavedAsync(item.Id, "created", ct);
    logs.CreateLogger("Connections").LogInformation("Connection {ConnectionId} created", item.Id);
    return Results.Created($"/api/connections/{item.Id}", ConnectionResponse.From(item));
});
connections.MapPut("/{id}", async (string id, ConnectionRequest input, IConnectionRepository store, ICentrifugoPublisher publisher, ILoggerFactory logs, CancellationToken ct) =>
{
    var validation = ConnectionInput.Validate(input);
    if (validation.Error is not null) return Results.ValidationProblem(validation.Error);
    var old = await store.GetAsync(id, ct);
    if (old is null) return Results.NotFound();
    var item = old with { Name = validation.Name!, BaseUri = validation.BaseUri!, UpdatedAt = DateTimeOffset.UtcNow };
    await store.ReplaceAsync(item, ct);
    await publisher.PublishSavedAsync(item.Id, "updated", ct);
    logs.CreateLogger("Connections").LogInformation("Connection {ConnectionId} updated", item.Id);
    return Results.Ok(ConnectionResponse.From(item));
});

app.Run();

void LoadSecret(string configurationKey, string fileSetting)
{
    var path = builder.Configuration[fileSetting];
    if (!string.IsNullOrWhiteSpace(path)) builder.Configuration[configurationKey] = File.ReadAllText(path).Trim();
}

public partial class Program;

public sealed record ConnectionRequest(string? Name, string? BaseUri);
public sealed record Connection(string Id, string Name, string BaseUri, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);
public sealed record ConnectionResponse(string Id, string Name, string BaseUri, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string ObservationStatus)
{
    public static ConnectionResponse From(Connection value) => new(value.Id, value.Name, value.BaseUri, value.CreatedAt, value.UpdatedAt, "not_checked");
}

public static class ConnectionInput
{
    public static (string? Name, string? BaseUri, Dictionary<string, string[]>? Error) Validate(ConnectionRequest input)
    {
        var errors = new Dictionary<string, string[]>();
        var name = input.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200) errors["name"] = ["Name is required and must be at most 200 characters."];
        var baseUri = input.BaseUri?.Trim();
        if (!Uri.TryCreate(baseUri, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            errors["baseUri"] = ["BaseUri must be an absolute http or https URI."];
        else baseUri = uri.AbsoluteUri;
        return (name, baseUri, errors.Count == 0 ? null : errors);
    }
}

public interface IConnectionRepository
{
    Task<IReadOnlyList<Connection>> ListAsync(CancellationToken cancellationToken);
    Task<Connection?> GetAsync(string id, CancellationToken cancellationToken);
    Task CreateAsync(Connection connection, CancellationToken cancellationToken);
    Task ReplaceAsync(Connection connection, CancellationToken cancellationToken);
    Task PingAsync(CancellationToken cancellationToken);
}

public sealed class MongoConnectionRepository : IConnectionRepository
{
    private readonly IMongoCollection<ConnectionDocument> _connections;
    private readonly IMongoDatabase _database;
    public MongoConnectionRepository(IMongoClient client, IOptions<MongoOptions> options)
    {
        _database = client.GetDatabase(options.Value.Database);
        _connections = _database.GetCollection<ConnectionDocument>("connections");
    }
    public async Task<IReadOnlyList<Connection>> ListAsync(CancellationToken ct) =>
        (await _connections.Find(FilterDefinition<ConnectionDocument>.Empty).SortBy(x => x.Name).ToListAsync(ct)).Select(x => x.ToModel()).ToList();
    public async Task<Connection?> GetAsync(string id, CancellationToken ct) =>
        (await _connections.Find(x => x.Id == id).FirstOrDefaultAsync(ct))?.ToModel();
    public Task CreateAsync(Connection value, CancellationToken ct) => _connections.InsertOneAsync(ConnectionDocument.From(value), cancellationToken: ct);
    public Task ReplaceAsync(Connection value, CancellationToken ct) => _connections.ReplaceOneAsync(x => x.Id == value.Id, ConnectionDocument.From(value), cancellationToken: ct);
    public async Task PingAsync(CancellationToken ct) => await _database.RunCommandAsync<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("ping", 1), cancellationToken: ct);
}

public sealed class ConnectionDocument
{
    [BsonId] public string Id { get; init; } = null!;
    [BsonElement("name")] public string Name { get; init; } = null!;
    [BsonElement("baseUri")] public string BaseUri { get; init; } = null!;
    [BsonElement("createdAt")] public DateTimeOffset CreatedAt { get; init; }
    [BsonElement("updatedAt")] public DateTimeOffset UpdatedAt { get; init; }
    public Connection ToModel() => new(Id, Name, BaseUri, CreatedAt, UpdatedAt);
    public static ConnectionDocument From(Connection value) => new() { Id = value.Id, Name = value.Name, BaseUri = value.BaseUri, CreatedAt = value.CreatedAt, UpdatedAt = value.UpdatedAt };
}

public sealed class MongoOptions
{
    [System.ComponentModel.DataAnnotations.Required] public string ConnectionString { get; init; } = null!;
    [System.ComponentModel.DataAnnotations.Required] public string Database { get; init; } = null!;
}
public sealed class InternalAuthOptions { [System.ComponentModel.DataAnnotations.Required] public string Token { get; init; } = null!; }
public sealed class CentrifugoOptions { public string? PublishUrl { get; init; } public string? ApiKey { get; init; } }

public sealed class MongoReadinessHealthCheck(IConnectionRepository repository) : Microsoft.Extensions.Diagnostics.HealthChecks.IHealthCheck
{
    public async Task<Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult> CheckHealthAsync(Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckContext context, CancellationToken ct = default)
    {
        try { await repository.PingAsync(ct); return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Healthy(); }
        catch { return Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult.Unhealthy("MongoDB is unavailable"); }
    }
}

public sealed class InternalTokenFilter(IOptions<InternalAuthOptions> options) : IEndpointFilter
{
    public ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var supplied = context.HttpContext.Request.Headers["X-Internal-Token"].ToString();
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(supplied), System.Text.Encoding.UTF8.GetBytes(options.Value.Token))
            ? next(context) : ValueTask.FromResult<object?>(Results.Unauthorized());
    }
}
public static class AuthEndpointExtensions
{
    public static RouteGroupBuilder RequireInternalToken(this RouteGroupBuilder group) => group.AddEndpointFilter<InternalTokenFilter>();
}

public interface ICentrifugoPublisher { Task PublishSavedAsync(string connectionId, string kind, CancellationToken cancellationToken); }
public sealed class CentrifugoPublisher(HttpClient client, IOptions<CentrifugoOptions> options, ILogger<CentrifugoPublisher> logger) : ICentrifugoPublisher
{
    public async Task PublishSavedAsync(string connectionId, string kind, CancellationToken ct)
    {
        var config = options.Value;
        if (!Uri.TryCreate(config.PublishUrl, UriKind.Absolute, out var url)) return;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(new { channel = "connections", data = new { connectionId, kind } })
            };
            if (!string.IsNullOrWhiteSpace(config.ApiKey)) request.Headers.TryAddWithoutValidation("X-API-Key", config.ApiKey);
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) logger.LogWarning("Centrifugo publish failed for connection {ConnectionId}: HTTP {StatusCode}", connectionId, (int)response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Centrifugo publish failed for connection {ConnectionId}", connectionId);
        }
    }
}
