using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

public interface IConnectionRepository
{
    Task<IReadOnlyList<Connection>> ListAsync(CancellationToken cancellationToken);
    Task<Connection?> GetAsync(string id, CancellationToken cancellationToken);
    Task CreateAsync(Connection connection, CancellationToken cancellationToken);
    Task<bool> ReplaceAsync(Connection connection, long expectedEpoch, CancellationToken cancellationToken);
    Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken cancellationToken);
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
    public async Task<bool> ReplaceAsync(Connection value, long expectedEpoch, CancellationToken ct)
    {
        var epoch = Builders<ConnectionDocument>.Filter.Eq(x => x.ConfigEpoch, expectedEpoch);
        if (expectedEpoch == 1) epoch |= Builders<ConnectionDocument>.Filter.Exists(x => x.ConfigEpoch, false);
        var filter = Builders<ConnectionDocument>.Filter.Eq(x => x.Id, value.Id) & epoch;
        var result = await _connections.ReplaceOneAsync(filter, ConnectionDocument.From(value), cancellationToken: ct);
        return result.ModifiedCount == 1;
    }
    public async Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken ct)
    {
        var result = await _connections.UpdateOneAsync(x => x.Id == id && x.ConfigEpoch == epoch,
            Builders<ConnectionDocument>.Update.Set(x => x.Observation, observation), cancellationToken: ct);
        return result.ModifiedCount == 1;
    }
    public async Task PingAsync(CancellationToken ct) => await _database.RunCommandAsync<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("ping", 1), cancellationToken: ct);
}

public sealed class ConnectionDocument
{
    [BsonId] public string Id { get; init; } = null!;
    [BsonElement("name")] public string Name { get; init; } = null!;
    [BsonElement("baseUri")] public string BaseUri { get; init; } = null!;
    [BsonElement("configEpoch")] public long ConfigEpoch { get; init; }
    [BsonElement("observationSettings")] public ObservationSettings? Settings { get; init; }
    [BsonElement("observation")] public Observation? Observation { get; init; }
    [BsonElement("createdAt")] public DateTimeOffset CreatedAt { get; init; }
    [BsonElement("updatedAt")] public DateTimeOffset UpdatedAt { get; init; }
    public Connection ToModel() => new(Id, Name, BaseUri, ConfigEpoch < 1 ? 1 : ConfigEpoch,
        Settings ?? ObservationSettings.Default, Observation ?? global::Observation.Unknown, CreatedAt, UpdatedAt);
    public static ConnectionDocument From(Connection value) => new()
    {
        Id = value.Id, Name = value.Name, BaseUri = value.BaseUri, ConfigEpoch = value.ConfigEpoch,
        Settings = value.Settings, Observation = value.Observation, CreatedAt = value.CreatedAt, UpdatedAt = value.UpdatedAt
    };
}

public sealed class MongoReadinessHealthCheck(IConnectionRepository repository) : Microsoft.Extensions.Diagnostics.HealthChecks.IHealthCheck
{
    public async Task<Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckResult> CheckHealthAsync(
        Microsoft.Extensions.Diagnostics.HealthChecks.HealthCheckContext context, CancellationToken ct = default)
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
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
            System.Text.Encoding.UTF8.GetBytes(supplied), System.Text.Encoding.UTF8.GetBytes(options.Value.Token))
            ? next(context) : ValueTask.FromResult<object?>(Results.Unauthorized());
    }
}
public static class AuthEndpointExtensions
{
    public static RouteGroupBuilder RequireInternalToken(this RouteGroupBuilder group) => group.AddEndpointFilter<InternalTokenFilter>();
}

public interface ICentrifugoPublisher
{
    Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken cancellationToken);
}
public sealed class CentrifugoPublisher(HttpClient client, IOptions<CentrifugoOptions> options, ILogger<CentrifugoPublisher> logger) : ICentrifugoPublisher
{
    public async Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken ct)
    {
        var config = options.Value;
        if (!Uri.TryCreate(config.PublishUrl, UriKind.Absolute, out var url)) return;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(new { channel = "connections", data = new { resource, connectionId, kind } })
            };
            if (!string.IsNullOrWhiteSpace(config.ApiKey)) request.Headers.TryAddWithoutValidation("X-API-Key", config.ApiKey);
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
                logger.LogWarning("Centrifugo publish failed for connection {ConnectionId}: HTTP {StatusCode}", connectionId, (int)response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning("Centrifugo publish failed for connection {ConnectionId}: {ErrorType}", connectionId, ex.GetType().Name);
        }
    }
}
