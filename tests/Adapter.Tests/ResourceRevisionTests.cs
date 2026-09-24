using Microsoft.Extensions.Options;
using MongoDB.Driver;
using Xunit;

public sealed class ResourceRevisionTests
{
    [MongoFact]
    [Trait("Category", "MongoIntegration")]
    public async Task Event_cursor_survives_restart_and_is_scoped_to_boot_id()
    {
        var connectionString = MongoTestSettings.ConnectionString!;
        var options = Options.Create(new MongoOptions { ConnectionString = connectionString, Database = "hl320_revision_tests" });
        var id = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var connection = new Connection(id, "node", "https://example.test/", 7, ObservationSettings.Default,
            Observation.Unknown with { NodeId = "11111111-1111-4111-8111-111111111111", BootId = "boot-a" }, now, now);
        var first = new MongoEventCursors(new MongoClient(connectionString), options);
        await first.AdvanceAsync(connection, 42, default);
        var restarted = new MongoEventCursors(new MongoClient(connectionString), options);
        Assert.Equal(42, await restarted.ReadAsync(connection, default));
        await restarted.AdvanceAsync(connection, 40, default);
        Assert.Equal(42, await restarted.ReadAsync(connection, default));
        Assert.Equal(0, await restarted.ReadAsync(connection with
            { Observation = connection.Observation with { BootId = "boot-b" } }, default));
    }

    [MongoFact]
    [Trait("Category", "MongoIntegration")]
    public async Task Identical_semantic_marker_advances_once_under_concurrency()
    {
        var connectionString = MongoTestSettings.ConnectionString!;
        var store = new MongoResourceRevisions(new MongoClient(connectionString),
            Options.Create(new MongoOptions { ConnectionString = connectionString, Database = "hl320_revision_tests" }));
        var id = Guid.NewGuid().ToString("N");
        var writes = await Task.WhenAll(Enumerable.Range(0, 24).Select(_ =>
            store.AdvanceAsync("history", id, 7, "request-1", "same-event", default)));
        Assert.Single(writes, x => x is not null);
        Assert.Equal(1, await store.ReadAsync("history", id, 7, "request-1", default));
        Assert.Equal(2L, await store.AdvanceAsync("history", id, 7, "request-1", "next-event", default));
    }
}
