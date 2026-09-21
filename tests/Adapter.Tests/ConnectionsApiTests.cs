using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using System.Net.Http.Json;
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
    public Task<IReadOnlyList<Connection>> ListAsync(CancellationToken ct) => Task.FromResult<IReadOnlyList<Connection>>(_values.Values.ToList());
    public Task<Connection?> GetAsync(string id, CancellationToken ct) => Task.FromResult(_values.GetValueOrDefault(id));
    public Task CreateAsync(Connection connection, CancellationToken ct) { _values.Add(connection.Id, connection); return Task.CompletedTask; }
    public Task<bool> ReplaceAsync(Connection connection, long expectedEpoch, CancellationToken ct)
    {
        if (!_values.TryGetValue(connection.Id, out var old) || old.ConfigEpoch != expectedEpoch) return Task.FromResult(false);
        _values[connection.Id] = connection;
        return Task.FromResult(true);
    }
    public Task<bool> UpdateObservationAsync(string id, long epoch, Observation observation, CancellationToken ct)
    {
        if (!_values.TryGetValue(id, out var old) || old.ConfigEpoch != epoch) return Task.FromResult(false);
        _values[id] = old with { Observation = observation };
        return Task.FromResult(true);
    }
    public Task PingAsync(CancellationToken ct) => Task.CompletedTask;
}
public sealed class NoopPublisher : ICentrifugoPublisher
{
    public Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken cancellationToken) => Task.CompletedTask;
}
