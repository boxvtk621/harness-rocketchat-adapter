using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using Microsoft.Extensions.Options;

public sealed record Invalidation(int SchemaVersion, string Resource, string ConnectionId, string? NodeId,
    long ConfigEpoch, string? EntityId, string? OperationId, long Revision, string Kind, long? ListRevision = null);

public interface IResourceRevisions
{
    Task<long> ReadAsync(string resource, string connectionId, long epoch, string? entityId, CancellationToken ct);
    Task<long?> AdvanceAsync(string resource, string connectionId, long epoch, string? entityId,
        string marker, CancellationToken ct);
}

public sealed class MongoResourceRevisions : IResourceRevisions
{
    private readonly IMongoCollection<ResourceRevisionDocument> _collection;
    public MongoResourceRevisions(IMongoClient client, IOptions<MongoOptions> options) =>
        _collection = client.GetDatabase(options.Value.Database).GetCollection<ResourceRevisionDocument>("resource_revisions");

    private static string Key(string resource, string connectionId, long epoch, string? entityId) =>
        $"{connectionId.Length}:{connectionId}:{epoch}:{resource.Length}:{resource}:{entityId?.Length ?? 0}:{entityId}";

    public async Task<long> ReadAsync(string resource, string connectionId, long epoch, string? entityId, CancellationToken ct) =>
        (await _collection.Find(x => x.Id == Key(resource, connectionId, epoch, entityId))
            .FirstOrDefaultAsync(ct))?.Revision ?? 0;

    public async Task<long?> AdvanceAsync(string resource, string connectionId, long epoch, string? entityId,
        string marker, CancellationToken ct)
    {
        var key = Key(resource, connectionId, epoch, entityId);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var old = await _collection.Find(x => x.Id == key).FirstOrDefaultAsync(ct);
            if (old?.Marker == marker) return null;
            var filter = old is null
                ? Builders<ResourceRevisionDocument>.Filter.Eq(x => x.Id, key) &
                  Builders<ResourceRevisionDocument>.Filter.Exists(x => x.Revision, false)
                : Builders<ResourceRevisionDocument>.Filter.Eq(x => x.Id, key) &
                  Builders<ResourceRevisionDocument>.Filter.Eq(x => x.Revision, old.Revision);
            var update = Builders<ResourceRevisionDocument>.Update.Combine(
                Builders<ResourceRevisionDocument>.Update.SetOnInsert(x => x.Id, key),
                Builders<ResourceRevisionDocument>.Update.Set(x => x.Marker, marker),
                Builders<ResourceRevisionDocument>.Update.Inc(x => x.Revision, 1));
            try
            {
                var next = await _collection.FindOneAndUpdateAsync(filter, update,
                    new FindOneAndUpdateOptions<ResourceRevisionDocument>
                    { IsUpsert = old is null, ReturnDocument = ReturnDocument.After }, ct);
                if (next is not null) return next.Revision;
            }
            catch (MongoWriteException error) when (error.WriteError?.Category == ServerErrorCategory.DuplicateKey) { }
        }
        throw new InvalidOperationException("Resource revision contention exceeded retry limit.");
    }
}

public sealed class ResourceRevisionDocument
{
    [BsonId] public string Id { get; set; } = "";
    public long Revision { get; set; }
    public string Marker { get; set; } = "";
}

public interface IEventRelations
{
    Task RememberAsync(string connectionId, long epoch, string attemptId, string requestId, CancellationToken ct);
    Task<string?> RequestAsync(string connectionId, long epoch, string attemptId, CancellationToken ct);
}

public sealed class MongoEventRelations(IMongoClient client, IOptions<MongoOptions> options) : IEventRelations
{
    private readonly IMongoCollection<EventRelationDocument> _collection =
        client.GetDatabase(options.Value.Database).GetCollection<EventRelationDocument>("event_relations");
    private static string Key(string connectionId, long epoch, string attemptId) => $"{connectionId}:{epoch}:{attemptId}";
    public async Task RememberAsync(string connectionId, long epoch, string attemptId, string requestId, CancellationToken ct) =>
        await _collection.ReplaceOneAsync(x => x.Id == Key(connectionId, epoch, attemptId),
            new EventRelationDocument { Id = Key(connectionId, epoch, attemptId), RequestId = requestId },
            new ReplaceOptions { IsUpsert = true }, ct);
    public async Task<string?> RequestAsync(string connectionId, long epoch, string attemptId, CancellationToken ct) =>
        (await _collection.Find(x => x.Id == Key(connectionId, epoch, attemptId)).FirstOrDefaultAsync(ct))?.RequestId;
}

public sealed class EventRelationDocument
{
    [BsonId] public string Id { get; set; } = "";
    public string RequestId { get; set; } = "";
}

public interface IEventCursors
{
    Task<long> ReadAsync(Connection connection, CancellationToken ct);
    Task AdvanceAsync(Connection connection, long seq, CancellationToken ct);
}

public sealed class MongoEventCursors(IMongoClient client, IOptions<MongoOptions> options) : IEventCursors
{
    private readonly IMongoCollection<EventCursorDocument> _collection =
        client.GetDatabase(options.Value.Database).GetCollection<EventCursorDocument>("event_cursors");
    private static string Key(Connection connection) =>
        $"{connection.Id}:{connection.ConfigEpoch}:{connection.Observation.NodeId}:{connection.Observation.BootId}";

    public async Task<long> ReadAsync(Connection connection, CancellationToken ct) =>
        (await _collection.Find(x => x.Id == Key(connection)).FirstOrDefaultAsync(ct))?.Seq ?? 0;

    public async Task AdvanceAsync(Connection connection, long seq, CancellationToken ct) =>
        await _collection.UpdateOneAsync(x => x.Id == Key(connection),
            Builders<EventCursorDocument>.Update.Combine(
                Builders<EventCursorDocument>.Update.SetOnInsert(x => x.Id, Key(connection)),
                Builders<EventCursorDocument>.Update.Max(x => x.Seq, seq)),
            new UpdateOptions { IsUpsert = true }, ct);
}

public sealed class EventCursorDocument
{
    [BsonId] public string Id { get; set; } = "";
    public long Seq { get; set; }
}
