using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

public interface IConnectionRepository
{
    Task<IReadOnlyList<Connection>> ListAsync(CancellationToken cancellationToken);
    Task<Connection?> GetAsync(string id, CancellationToken cancellationToken);
    Task<ConnectionCreateResult> CreateOrGetAsync(Connection connection, CancellationToken cancellationToken);
    Task<bool> ReplaceAsync(Connection connection, long expectedEpoch, CancellationToken cancellationToken);
    Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken cancellationToken);
    Task PingAsync(CancellationToken cancellationToken);
}

public sealed record ConnectionCreateResult(Connection Connection, bool Created);

public sealed class MongoConnectionRepository : IConnectionRepository
{
    private readonly IMongoCollection<ConnectionDocument> _connections;
    private readonly IMongoDatabase _database;
    private readonly Lazy<Task> _indexes;
    public MongoConnectionRepository(IMongoClient client, IOptions<MongoOptions> options)
    {
        _database = client.GetDatabase(options.Value.Database);
        _connections = _database.GetCollection<ConnectionDocument>("connections");
        _indexes = new Lazy<Task>(CreateIndexesAsync);
    }
    public async Task<IReadOnlyList<Connection>> ListAsync(CancellationToken ct) =>
        (await _connections.Find(FilterDefinition<ConnectionDocument>.Empty).SortBy(x => x.Name).ToListAsync(ct))
            .Select(x => x.ToModel())
            .GroupBy(ConnectionIdentity.EndpointKey, StringComparer.Ordinal)
            .Select(x => x.OrderBy(y => y.CreatedAt).ThenBy(y => y.Id, StringComparer.Ordinal).First())
            .OrderBy(x => x.Name, StringComparer.Ordinal)
            .ToList();
    public async Task<Connection?> GetAsync(string id, CancellationToken ct) =>
        (await _connections.Find(x => x.Id == id).FirstOrDefaultAsync(ct))?.ToModel();
    public async Task<ConnectionCreateResult> CreateOrGetAsync(Connection value, CancellationToken ct)
    {
        await _indexes.Value.WaitAsync(ct);
        var endpointKey = ConnectionIdentity.EndpointKey(value);
        var filter = Builders<ConnectionDocument>.Filter.Eq(x => x.EndpointKey, endpointKey) |
                     (Builders<ConnectionDocument>.Filter.Exists(x => x.EndpointKey, false) &
                      Builders<ConnectionDocument>.Filter.Eq(x => x.BaseUri, value.BaseUri));
        var document = ConnectionDocument.From(value);
        var update = Builders<ConnectionDocument>.Update
            .SetOnInsert(x => x.Id, document.Id)
            .SetOnInsert(x => x.Name, document.Name)
            .SetOnInsert(x => x.BaseUri, document.BaseUri)
            .SetOnInsert(x => x.ConfigEpoch, document.ConfigEpoch)
            .SetOnInsert(x => x.Settings, document.Settings)
            .SetOnInsert(x => x.Observation, document.Observation)
            .SetOnInsert(x => x.CreatedAt, document.CreatedAt)
            .SetOnInsert(x => x.UpdatedAt, document.UpdatedAt)
            .Set(x => x.EndpointKey, endpointKey);
        try
        {
            var stored = await _connections.FindOneAndUpdateAsync(filter, update,
                new FindOneAndUpdateOptions<ConnectionDocument>
                {
                    IsUpsert = true,
                    ReturnDocument = ReturnDocument.After,
                    Sort = Builders<ConnectionDocument>.Sort.Ascending(x => x.CreatedAt).Ascending(x => x.Id)
                }, ct);
            return new(stored.ToModel(), stored.Id == value.Id);
        }
        catch (Exception ex) when (IsDuplicateKey(ex))
        {
            var stored = await _connections.Find(x => x.EndpointKey == endpointKey).FirstAsync(ct);
            return new(stored.ToModel(), false);
        }
    }
    public async Task<bool> ReplaceAsync(Connection value, long expectedEpoch, CancellationToken ct)
    {
        await _indexes.Value.WaitAsync(ct);
        var endpointKey = ConnectionIdentity.EndpointKey(value);
        var current = await _connections.Find(x => x.Id == value.Id).Project(x => x.BaseUri).FirstOrDefaultAsync(ct);
        if (current is null) return false;
        if (!string.Equals(current, value.BaseUri, StringComparison.Ordinal))
        {
            var occupied = Builders<ConnectionDocument>.Filter.Ne(x => x.Id, value.Id) &
                           (Builders<ConnectionDocument>.Filter.Eq(x => x.EndpointKey, endpointKey) |
                            (Builders<ConnectionDocument>.Filter.Exists(x => x.EndpointKey, false) &
                             Builders<ConnectionDocument>.Filter.Eq(x => x.BaseUri, value.BaseUri)));
            if (await _connections.Find(occupied).AnyAsync(ct)) return false;
        }
        var epoch = Builders<ConnectionDocument>.Filter.Eq(x => x.ConfigEpoch, expectedEpoch);
        if (expectedEpoch == 1) epoch |= Builders<ConnectionDocument>.Filter.Exists(x => x.ConfigEpoch, false);
        var filter = Builders<ConnectionDocument>.Filter.Eq(x => x.Id, value.Id) & epoch;
        try
        {
            var result = await _connections.ReplaceOneAsync(filter, ConnectionDocument.From(value), cancellationToken: ct);
            return result.ModifiedCount == 1;
        }
        catch (Exception ex) when (IsDuplicateKey(ex)) { return false; }
    }
    public async Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken ct)
    {
        var result = await _connections.UpdateOneAsync(x => x.Id == id && x.ConfigEpoch == epoch,
            Builders<ConnectionDocument>.Update.Set(x => x.Observation, observation), cancellationToken: ct);
        return result.ModifiedCount == 1;
    }
    public async Task PingAsync(CancellationToken ct) => await _database.RunCommandAsync<MongoDB.Bson.BsonDocument>(new MongoDB.Bson.BsonDocument("ping", 1), cancellationToken: ct);

    private Task CreateIndexesAsync()
    {
        var keys = Builders<ConnectionDocument>.IndexKeys.Ascending(x => x.EndpointKey);
        var options = new CreateIndexOptions<ConnectionDocument>
        {
            Name = "ux_connections_endpoint_key",
            Unique = true,
            PartialFilterExpression = Builders<ConnectionDocument>.Filter.Type(x => x.EndpointKey, MongoDB.Bson.BsonType.String)
        };
        return _connections.Indexes.CreateOneAsync(new CreateIndexModel<ConnectionDocument>(keys, options));
    }

    private static bool IsDuplicateKey(Exception ex) =>
        ex is MongoWriteException write && write.WriteError?.Category == ServerErrorCategory.DuplicateKey ||
        ex is MongoCommandException command && command.Code == 11000;
}

public sealed class ConnectionDocument
{
    [BsonId] public string Id { get; init; } = null!;
    [BsonElement("name")] public string Name { get; init; } = null!;
    [BsonElement("baseUri")] public string BaseUri { get; init; } = null!;
    [BsonElement("endpointKey"), BsonIgnoreIfNull] public string? EndpointKey { get; init; }
    [BsonElement("configEpoch")] public long ConfigEpoch { get; init; }
    [BsonElement("observationSettings")] public ObservationSettings? Settings { get; init; }
    [BsonElement("observation")] public Observation? Observation { get; init; }
    [BsonElement("createdAt")] public DateTimeOffset CreatedAt { get; init; }
    [BsonElement("updatedAt")] public DateTimeOffset UpdatedAt { get; init; }
    public Connection ToModel()
    {
        var observation = Observation ?? global::Observation.Unknown;
        if (observation.Occupancy is not ("idle" or "active" or "unknown"))
            observation = observation with { Occupancy = "unknown" };
        if (Guid.TryParse(observation.NodeId, out var nodeId))
            observation = observation with { NodeId = nodeId.ToString("D") };
        return new(Id, Name, BaseUri, ConfigEpoch < 1 ? 1 : ConfigEpoch,
            Settings ?? ObservationSettings.Default, observation, CreatedAt, UpdatedAt);
    }
    public static ConnectionDocument From(Connection value) => new()
    {
        Id = value.Id, Name = value.Name, BaseUri = value.BaseUri,
        EndpointKey = ConnectionIdentity.EndpointKey(value), ConfigEpoch = value.ConfigEpoch,
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
