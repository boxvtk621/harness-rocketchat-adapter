using Microsoft.Extensions.Options;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using System.Text.Json;

public sealed class OperationWatchDocument
{
    [BsonId] public string Id { get; set; } = "";
    public string Resource { get; set; } = "";
    public string ConnectionId { get; set; } = "";
    public string NodeId { get; set; } = "";
    public long ConfigEpoch { get; set; }
    public string OperationId { get; set; } = "";
    public DateTimeOffset DeadlineAt { get; set; }
    public bool Active { get; set; }
    public string Status { get; set; } = "watching";
}

public interface IOperationWatches
{
    Task RegisterAsync(string resource, Connection connection, string nodeId, string operationId, CancellationToken ct);
    Task<IReadOnlyList<OperationWatchDocument>> ActiveAsync(CancellationToken ct);
    Task<string?> StatusAsync(string resource, string connectionId, long epoch, string operationId, CancellationToken ct);
    Task CompleteAsync(string id, string status, CancellationToken ct);
}

public sealed class MongoOperationWatches(IMongoClient client, IOptions<MongoOptions> options) : IOperationWatches
{
    private readonly IMongoCollection<OperationWatchDocument> _collection =
        client.GetDatabase(options.Value.Database).GetCollection<OperationWatchDocument>("operation_watches");

    public async Task RegisterAsync(string resource, Connection connection, string nodeId, string operationId, CancellationToken ct)
    {
        var id = $"{resource}:{connection.Id}:{connection.ConfigEpoch}:{operationId}";
        var value = new OperationWatchDocument { Id = id, Resource = resource, ConnectionId = connection.Id,
            ConfigEpoch = connection.ConfigEpoch, NodeId = nodeId, OperationId = operationId,
            DeadlineAt = DateTimeOffset.UtcNow.AddMinutes(5), Active = true, Status = "watching" };
        await _collection.ReplaceOneAsync(x => x.Id == id, value, new ReplaceOptions { IsUpsert = true }, ct);
    }

    public async Task<IReadOnlyList<OperationWatchDocument>> ActiveAsync(CancellationToken ct) =>
        await _collection.Find(x => x.Active).Limit(64).ToListAsync(ct);

    public async Task<string?> StatusAsync(string resource, string connectionId, long epoch, string operationId, CancellationToken ct) =>
        (await _collection.Find(x => x.Id == $"{resource}:{connectionId}:{epoch}:{operationId}").FirstOrDefaultAsync(ct))?.Status;

    public async Task CompleteAsync(string id, string status, CancellationToken ct) =>
        await _collection.UpdateOneAsync(x => x.Id == id,
            Builders<OperationWatchDocument>.Update.Combine(
                Builders<OperationWatchDocument>.Update.Set(x => x.Active, false),
                Builders<OperationWatchDocument>.Update.Set(x => x.Status, status)), cancellationToken: ct);
}

public sealed class OperationWatchService(IOperationWatches watches, IConnectionRepository connections,
    IProviderAuthClient auth, INodeSettingsClient settings, IResourceRevisions revisions,
    ICentrifugoPublisher publisher, ILogger<OperationWatchService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        try
        {
            do
            {
                var active = await watches.ActiveAsync(stoppingToken);
                await Parallel.ForEachAsync(active, new ParallelOptions
                    { MaxDegreeOfParallelism = 8, CancellationToken = stoppingToken }, async (watch, token) =>
                {
                    try { await ObserveAsync(watch, token); }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch (Exception error)
                    {
                        logger.LogWarning("Operation observation failed for {ConnectionId}: {ErrorType}",
                            watch.ConnectionId, error.GetType().Name);
                    }
                });
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    private async Task ObserveAsync(OperationWatchDocument watch, CancellationToken ct)
    {
        var connection = await connections.GetAsync(watch.ConnectionId, ct);
        if (connection is null || connection.ConfigEpoch != watch.ConfigEpoch ||
            connection.Observation.NodeId != watch.NodeId)
        { await watches.CompleteAsync(watch.Id, "scope_changed", ct); return; }
        if (DateTimeOffset.UtcNow >= watch.DeadlineAt)
        {
            await PublishAsync(watch, "timeout_unknown", "timeout_unknown", ct);
            await watches.CompleteAsync(watch.Id, "timeout_unknown", ct);
            return;
        }
        if (watch.Resource == "provider_auth")
        {
            var response = await auth.SendAsync(connection, watch.NodeId, "", watch.OperationId, null, ct);
            var operation = response.Snapshot?.Operation;
            if (operation is null || operation.OperationId != watch.OperationId) return;
            await PublishAsync(watch, $"{response.Snapshot!.Revision}:{operation.Status}:{operation.UpdatedAt:O}", operation.Status, ct);
            if (operation.Status is "succeeded" or "failed" or "cancelled" or "expired")
                await watches.CompleteAsync(watch.Id, "terminal", ct);
            return;
        }
        var result = await settings.SendAsync(connection, watch.NodeId, HttpMethod.Get,
            ["operations", watch.OperationId], new Dictionary<string, string?>(), null, ct);
        if (result.Status != 200 || result.Payload is not { } payload ||
            !payload.TryGetProperty("operation", out var value) || value.ValueKind != JsonValueKind.Object) return;
        var id = value.TryGetProperty("operationId", out var opId) ? opId.GetString() : null;
        if (id != watch.OperationId) return;
        var phase = value.TryGetProperty("phase", out var phaseValue) ? phaseValue.GetString() : null;
        var status = value.TryGetProperty("status", out var statusValue) ? statusValue.GetString() : null;
        var revision = payload.TryGetProperty("appliedRevision", out var applied) && applied.TryGetInt64(out var n) ? n : 0;
        await PublishAsync(watch, $"{revision}:{status}:{phase}", status ?? "unknown", ct);
        if (status is "succeeded" or "failed" or "cancelled" or "expired")
            await watches.CompleteAsync(watch.Id, "terminal", ct);
    }

    private async Task PublishAsync(OperationWatchDocument watch, string marker, string kind, CancellationToken ct)
    {
        var revision = await revisions.AdvanceAsync(watch.Resource, watch.ConnectionId, watch.ConfigEpoch,
            watch.NodeId, $"{watch.OperationId}:{marker}", ct);
        if (revision is not null)
            await publisher.PublishInvalidationAsync(new Invalidation(1, watch.Resource, watch.ConnectionId,
                watch.NodeId, watch.ConfigEpoch, watch.NodeId, watch.OperationId, revision.Value, kind), ct);
    }
}
