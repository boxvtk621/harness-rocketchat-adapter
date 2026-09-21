using Microsoft.Extensions.Options;
using MongoDB.Bson;
using MongoDB.Driver;
using Xunit;

public sealed class MongoConnectionRepositoryTests
{
    [MongoFact]
    [Trait("Category", "MongoIntegration")]
    public async Task Concurrent_create_is_atomic_in_mongodb()
    {
        var connectionString = MongoTestSettings.ConnectionString!;

        var repository = new MongoConnectionRepository(new MongoClient(connectionString),
            Options.Create(new MongoOptions { ConnectionString = connectionString, Database = "hl305_identity_tests" }));
        var endpoint = $"https://node.test/identity/{Guid.NewGuid():N}?tenant=alpha&mode=full";
        var now = DateTimeOffset.UtcNow;
        var candidates = Enumerable.Range(0, 24).Select(index => new Connection(
            Guid.NewGuid().ToString("N"), $"candidate-{index}", endpoint, 1, ObservationSettings.Default,
            Observation.Unknown, now.AddTicks(index), now.AddTicks(index))).ToArray();

        var results = await Task.WhenAll(candidates.Select(x => repository.CreateOrGetAsync(x, default)));

        Assert.Single(results, x => x.Created);
        Assert.Single(results.Select(x => x.Connection.Id).Distinct(StringComparer.Ordinal));
        Assert.Single(await repository.ListAsync(default), x => x.BaseUri == endpoint);
    }

    [MongoFact]
    [Trait("Category", "MongoIntegration")]
    public async Task Legacy_endpoint_is_claimed_without_deletion_and_keeps_observation_on_rename()
    {
        var connectionString = MongoTestSettings.ConnectionString!;
        const string databaseName = "hl305_identity_tests";
        var client = new MongoClient(connectionString);
        var collection = client.GetDatabase(databaseName).GetCollection<BsonDocument>("connections");
        var endpoint = $"https://node.test/legacy/{Guid.NewGuid():N}?tenant=alpha";
        var legacyId = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        var legacyObservation = Observation.Unknown with { AttemptedAt = now, HttpReachable = true,
            Compatibility = "compatible", NodeId = Guid.NewGuid().ToString("D") };
        var legacyDocument = ConnectionDocument.From(new Connection(legacyId, "legacy", endpoint, 1,
            ObservationSettings.Default, legacyObservation, now, now)).ToBsonDocument();
        legacyDocument.Remove("endpointKey");
        legacyDocument["observation"].AsBsonDocument.Remove("Occupancy");
        await collection.InsertOneAsync(legacyDocument);
        var repository = new MongoConnectionRepository(client,
            Options.Create(new MongoOptions { ConnectionString = connectionString, Database = databaseName }));
        var candidates = Enumerable.Range(0, 12).Select(index => new Connection(Guid.NewGuid().ToString("N"),
            $"candidate-{index}", endpoint, 1, ObservationSettings.Default, Observation.Unknown, now, now));

        var results = await Task.WhenAll(candidates.Select(x => repository.CreateOrGetAsync(x, default)));
        var legacy = await repository.GetAsync(legacyId, default);

        Assert.All(results, x => { Assert.False(x.Created); Assert.Equal(legacyId, x.Connection.Id); });
        Assert.NotNull(legacy);
        Assert.True(await repository.ReplaceAsync(legacy! with { Name = "renamed", ConfigEpoch = 2, UpdatedAt = now.AddMinutes(1) }, 1, default));
        var renamed = await repository.GetAsync(legacyId, default);
        Assert.Equal("renamed", renamed!.Name);
        Assert.Equal(legacyObservation.NodeId, renamed.Observation.NodeId);
        Assert.Equal("compatible", renamed.Observation.Compatibility);
        Assert.Equal("unknown", renamed.Observation.Occupancy);
    }

    [MongoFact]
    [Trait("Category", "MongoIntegration")]
    public async Task Legacy_duplicate_documents_collapse_to_stable_oldest_connection()
    {
        var connectionString = MongoTestSettings.ConnectionString!;
        const string databaseName = "hl305_identity_tests";
        var client = new MongoClient(connectionString);
        var collection = client.GetDatabase(databaseName).GetCollection<BsonDocument>("connections");
        var endpoint = $"https://node.test/legacy-duplicates/{Guid.NewGuid():N}?tenant=alpha";
        var oldestId = Guid.NewGuid().ToString("N");
        var newestId = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow;
        await collection.InsertManyAsync([
            LegacyDocument(oldestId, "oldest", endpoint, now.AddMinutes(-1)),
            LegacyDocument(newestId, "newest", endpoint, now)
        ]);
        var repository = new MongoConnectionRepository(client,
            Options.Create(new MongoOptions { ConnectionString = connectionString, Database = databaseName }));
        var candidate = new Connection(Guid.NewGuid().ToString("N"), "candidate", endpoint, 1,
            ObservationSettings.Default, Observation.Unknown, now, now);

        var first = await repository.CreateOrGetAsync(candidate, default);
        var second = await repository.CreateOrGetAsync(candidate with { Id = Guid.NewGuid().ToString("N") }, default);

        Assert.False(first.Created);
        Assert.Equal(oldestId, first.Connection.Id);
        Assert.Equal(oldestId, second.Connection.Id);
        Assert.Single(await repository.ListAsync(default), x => x.BaseUri == endpoint);
        Assert.NotNull(await repository.GetAsync(newestId, default));
    }

    private static BsonDocument LegacyDocument(string id, string name, string endpoint, DateTimeOffset timestamp) => new()
    {
        ["_id"] = id,
        ["name"] = name,
        ["baseUri"] = endpoint,
        ["configEpoch"] = 1,
        ["createdAt"] = timestamp.UtcDateTime,
        ["updatedAt"] = timestamp.UtcDateTime
    };
}

public sealed class MongoFactAttribute : FactAttribute
{
    public MongoFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(MongoTestSettings.ConnectionString))
            Skip = "Set ADAPTER_TEST_MONGO_CONNECTION_STRING or its _FILE counterpart to run the isolated MongoDB integration tests.";
    }
}

internal static class MongoTestSettings
{
    public static string? ConnectionString
    {
        get
        {
            var value = Environment.GetEnvironmentVariable("ADAPTER_TEST_MONGO_CONNECTION_STRING");
            if (!string.IsNullOrWhiteSpace(value)) return value;
            var path = Environment.GetEnvironmentVariable("ADAPTER_TEST_MONGO_CONNECTION_STRING_FILE");
            return string.IsNullOrWhiteSpace(path) || !File.Exists(path) ? null : File.ReadAllText(path).Trim();
        }
    }
}
