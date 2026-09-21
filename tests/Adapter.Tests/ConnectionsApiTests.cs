using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
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
        Assert.Equal("not_checked", value.ObservationStatus);

        var fetched = await client.GetFromJsonAsync<ConnectionResponse>($"/api/connections/{value.Id}");
        Assert.Equal(value.Id, fetched!.Id);
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
            ["InternalAuth:Token"] = "test-secret"
        }));
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IConnectionRepository>();
            services.RemoveAll<ICentrifugoPublisher>();
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
    public Task ReplaceAsync(Connection connection, CancellationToken ct) { _values[connection.Id] = connection; return Task.CompletedTask; }
    public Task PingAsync(CancellationToken ct) => Task.CompletedTask;
}
public sealed class NoopPublisher : ICentrifugoPublisher { public Task PublishSavedAsync(string connectionId, string kind, CancellationToken cancellationToken) => Task.CompletedTask; }
