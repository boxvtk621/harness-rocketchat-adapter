using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

public class ConnectionsApiTests : IClassFixture<AdapterFactory>
{
    private readonly AdapterFactory _factory;
    public ConnectionsApiTests(AdapterFactory factory) => _factory = factory;

    [Fact]
    public async Task Create_then_get_requires_token_and_keeps_uri_path()
    {
        var client = _factory.CreateClient();
        var denied = await client.GetAsync("/api/connections/");
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, denied.StatusCode);

        client.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        var created = await client.PostAsJsonAsync("/api/connections/", new { name = "Demo", baseUri = "https://example.test/api/v2" });
        Assert.Equal(System.Net.HttpStatusCode.Created, created.StatusCode);
        var value = await created.Content.ReadFromJsonAsync<ConnectionResponse>();
        Assert.NotNull(value);
        Assert.Equal("https://example.test/api/v2", value!.BaseUri);
        Assert.Equal("unknown", value.Observation.Compatibility);
        Assert.Null(value.Observation.HttpReachable);

        var fetched = await client.GetFromJsonAsync<ConnectionResponse>($"/api/connections/{value.Id}");
        Assert.Equal(value.Id, fetched!.Id);

        var updated = await client.PutAsJsonAsync($"/api/connections/{value.Id}", new
            { name = "Renamed", baseUri = "https://example.test/api/v2" });
        Assert.Equal(System.Net.HttpStatusCode.OK, updated.StatusCode);
        Assert.Equal(2, (await updated.Content.ReadFromJsonAsync<ConnectionResponse>())!.ConfigEpoch);
    }

    [Fact]
    public async Task Concurrent_duplicate_registration_reuses_one_connection()
    {
        var endpoint = $"https://example.test/case/{Guid.NewGuid():N}?tenant=alpha&mode=full";
        var clients = Enumerable.Range(0, 12).Select(_ =>
        {
            var client = _factory.CreateClient();
            client.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
            return client;
        }).ToArray();

        var responses = await Task.WhenAll(clients.Select((client, index) => client.PostAsJsonAsync(
            "/api/connections/", new { name = $"Duplicate {index}", baseUri = endpoint })));
        var values = await Task.WhenAll(responses.Select(x => x.Content.ReadFromJsonAsync<ConnectionResponse>()));

        Assert.Single(values.Select(x => x!.Id).Distinct(StringComparer.Ordinal));
        Assert.Single(responses, x => x.StatusCode == System.Net.HttpStatusCode.Created);
        Assert.Equal(11, responses.Count(x => x.StatusCode == System.Net.HttpStatusCode.OK));
        Assert.All(responses.Where(x => x.StatusCode == System.Net.HttpStatusCode.OK),
            x => Assert.Equal("true", x.Headers.GetValues("X-Connection-Reused").Single()));
    }

    [Fact]
    public async Task Endpoint_identity_preserves_path_case_escaping_and_query_order()
    {
        var suffix = Guid.NewGuid().ToString("N");
        var endpoints = new[]
        {
            $"https://example.test/{suffix}/Path?first=1&second=2",
            $"https://example.test/{suffix}/path?first=1&second=2",
            $"https://example.test/{suffix}/Path?second=2&first=1",
            $"https://example.test/{suffix}/Path%2Fpart?first=1&second=2"
        };
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");

        var responses = new List<HttpResponseMessage>();
        foreach (var endpoint in endpoints)
            responses.Add(await client.PostAsJsonAsync("/api/connections/", new { name = endpoint, baseUri = endpoint }));

        Assert.All(responses, x => Assert.Equal(System.Net.HttpStatusCode.Created, x.StatusCode));
        var values = await Task.WhenAll(responses.Select(x => x.Content.ReadFromJsonAsync<ConnectionResponse>()));
        Assert.Equal(4, values.Select(x => x!.Id).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(4, values.Select(x => x!.EndpointKey).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(endpoints.Order(StringComparer.Ordinal), values.Select(x => x!.EndpointKey).Order(StringComparer.Ordinal));
        var nodes = await client.GetFromJsonAsync<List<NodeProjection>>("/api/projections/nodes");
        Assert.Equal(4, nodes!.Count(x => x.BaseUri.Contains(suffix, StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Node_identity_collision_is_one_diagnostic_node_and_projection_conflict()
    {
        var store = _factory.Services.GetRequiredService<IConnectionRepository>();
        var suffix = Guid.NewGuid().ToString("N");
        var nodeId = Guid.NewGuid().ToString("D");
        var now = DateTimeOffset.UtcNow;
        var observation = Observation.Unknown with { Compatibility = "compatible", NodeId = nodeId,
            AttemptedAt = now, HttpReachable = true };
        var left = new Connection(Guid.NewGuid().ToString("N"), "left", $"https://example.test/{suffix}/left", 1,
            ObservationSettings.Default, observation, now, now);
        var right = new Connection(Guid.NewGuid().ToString("N"), "right", $"https://example.test/{suffix}/right", 1,
            ObservationSettings.Default, observation, now, now);
        await store.CreateOrGetAsync(left, default);
        await store.CreateOrGetAsync(right, default);
        var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");

        var nodes = await client.GetFromJsonAsync<List<NodeProjection>>("/api/projections/nodes");
        var collision = Assert.Single(nodes!, x => x.Observation.NodeId == nodeId);
        Assert.Equal(ConnectionIdentity.NodeIdConflict, collision.IdentityStatus);
        Assert.Equal(2, collision.ConflictingConnectionIds.Count);

        foreach (var route in new[] { "/api/projections/work", "/api/projections/history" })
        {
            using var response = await client.GetAsync(route);
            Assert.Equal(System.Net.HttpStatusCode.Conflict, response.StatusCode);
            using var payload = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync());
            Assert.Equal("node_id_conflict", payload.RootElement.GetProperty("code").GetString());
            Assert.Equal(nodeId, payload.RootElement.GetProperty("conflicts")[0].GetProperty("nodeId").GetString());
        }
    }
}

public sealed class AdapterFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration(config => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Mongo:ConnectionString"] = "mongodb://unused",
            ["Mongo:Database"] = "adapter_tests",
            ["InternalAuth:Token"] = "test-secret",
            ["Harness:AllowedHosts"] = "example.test"
        }));
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IConnectionRepository>();
            services.RemoveAll<ICentrifugoPublisher>();
            services.RemoveAll<IHostedService>();
            services.AddSingleton<IConnectionRepository, MemoryConnectionRepository>();
            services.AddSingleton<ICentrifugoPublisher, NoopPublisher>();
        });
    }
}

public sealed class MemoryConnectionRepository : IConnectionRepository
{
    private readonly Dictionary<string, Connection> _values = [];
    private readonly object _gate = new();
    public Task<IReadOnlyList<Connection>> ListAsync(CancellationToken ct)
    {
        lock (_gate) return Task.FromResult<IReadOnlyList<Connection>>(_values.Values
            .GroupBy(ConnectionIdentity.EndpointKey, StringComparer.Ordinal).Select(x => x.First()).ToList());
    }
    public Task<Connection?> GetAsync(string id, CancellationToken ct)
    {
        lock (_gate) return Task.FromResult(_values.GetValueOrDefault(id));
    }
    public Task<ConnectionCreateResult> CreateOrGetAsync(Connection connection, CancellationToken ct)
    {
        lock (_gate)
        {
            var existing = _values.Values.FirstOrDefault(x =>
                string.Equals(ConnectionIdentity.EndpointKey(x), ConnectionIdentity.EndpointKey(connection), StringComparison.Ordinal));
            if (existing is not null) return Task.FromResult(new ConnectionCreateResult(existing, false));
            _values.Add(connection.Id, connection);
            return Task.FromResult(new ConnectionCreateResult(connection, true));
        }
    }
    public Task<bool> ReplaceAsync(Connection connection, long expectedEpoch, CancellationToken ct)
    {
        lock (_gate)
        {
            if (!_values.TryGetValue(connection.Id, out var old) || old.ConfigEpoch != expectedEpoch) return Task.FromResult(false);
            if (_values.Values.Any(x => x.Id != connection.Id && ConnectionIdentity.EndpointKey(x) == ConnectionIdentity.EndpointKey(connection)))
                return Task.FromResult(false);
            _values[connection.Id] = connection;
            return Task.FromResult(true);
        }
    }
    public Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken ct)
    {
        lock (_gate)
        {
            if (!_values.TryGetValue(id, out var old) || old.ConfigEpoch != epoch) return Task.FromResult(false);
            _values[id] = old with { Observation = observation };
            return Task.FromResult(true);
        }
    }
    public Task PingAsync(CancellationToken ct) => Task.CompletedTask;
}
public sealed class NoopPublisher : ICentrifugoPublisher
{
    public Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken cancellationToken) => Task.CompletedTask;
}
