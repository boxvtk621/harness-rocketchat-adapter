using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Xunit;

public sealed class NodeSettingsTests
{
    private const string NodeId = "11111111-1111-4111-8111-111111111111";
    private static Connection Connection() => new("connection", "test", "https://example.test/prefix?tenant=a", 7,
        ObservationSettings.Default, Observation.Unknown with { NodeId = NodeId, Compatibility = "compatible" },
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);

    [Fact]
    public async Task Client_preserves_contract_json_prefix_and_catalog_cursor_without_forwarding_caller_auth()
    {
        var handler = new Handler(async request =>
        {
            Assert.Equal(HttpMethod.Post, request.Method);
            Assert.Equal($"/prefix/v1/nodes/{NodeId}/settings/model-catalog", request.RequestUri!.AbsolutePath);
            Assert.Equal("?tenant=a&cursor=next%2F1", request.RequestUri.Query);
            Assert.False(request.Headers.Contains("Authorization"));
            Assert.False(request.Headers.Contains("Cookie"));
            Assert.Equal("{\"providerShape\":true}", await request.Content!.ReadAsStringAsync());
            return Reply("{\"items\":[{\"id\":\"provider/model\",\"futureField\":42}]}");
        });
        var result = await Client(handler).SendAsync(Connection(), NodeId, HttpMethod.Post, ["model-catalog"],
            new Dictionary<string, string?> { ["cursor"] = "next/1" }, Encoding.UTF8.GetBytes("{\"providerShape\":true}"), default);
        Assert.Equal(200, result.Status);
        Assert.Equal(42, result.Payload!.Value.GetProperty("items")[0].GetProperty("futureField").GetInt32());
    }

    [Theory]
    [InlineData("secret")]
    [InlineData("accessToken")]
    [InlineData("authorization")]
    [InlineData("apiKey")]
    [InlineData("clientSecret")]
    [InlineData("password")]
    [InlineData("credential")]
    [InlineData("x-api-key")]
    public async Task Client_rejects_recursive_secret_material_from_harness(string property)
    {
        var handler = new Handler(_ => Task.FromResult(Reply($"{{\"draft\":{{\"nested\":{{\"{property}\":\"must-not-escape\"}}}}}}")));
        var result = await Client(handler).SendAsync(Connection(), NodeId, HttpMethod.Get, [],
            new Dictionary<string, string?>(), null, default);
        Assert.Equal(502, result.Status);
        Assert.Null(result.Payload);
        Assert.Equal("invalid_response", result.Code);
    }

    [Fact]
    public async Task Routes_require_internal_token_exact_node_epoch_and_leave_connection_unmodified()
    {
        var spy = new Spy();
        using var factory = new AdapterFactory().WithWebHostBuilder(builder => builder.ConfigureServices(services =>
        {
            services.RemoveAll<INodeSettingsClient>();
            services.AddSingleton<INodeSettingsClient>(spy);
        }));
        var store = factory.Services.GetRequiredService<IConnectionRepository>();
        await store.CreateOrGetAsync(Connection(), default);
        var http = factory.CreateClient();
        var url = $"/api/connections/connection/node-settings?nodeId={NodeId}&configEpoch=7";
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.GetAsync(url)).StatusCode);
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync(url.Replace(NodeId, "not-a-node"))).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync(url.Replace("configEpoch=7", "configEpoch=6"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync(url + "&unexpected=true")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync(url)).StatusCode);
        var before = await store.GetAsync("connection", default);
        var response = await http.PutAsync(url, new StringContent("{\"expectedRevision\":3,\"draft\":{}}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(before, await store.GetAsync("connection", default));
        Assert.Equal(2, spy.Calls);
        Assert.Equal("{\"expectedRevision\":3,\"draft\":{}}", Encoding.UTF8.GetString(spy.LastBody!));
    }

    [Fact]
    public async Task Late_reply_is_discarded_when_adapter_connection_epoch_changes()
    {
        var spy = new Spy();
        using var factory = new AdapterFactory().WithWebHostBuilder(builder => builder.ConfigureServices(services =>
        {
            services.RemoveAll<INodeSettingsClient>(); services.AddSingleton<INodeSettingsClient>(spy);
        }));
        var store = factory.Services.GetRequiredService<IConnectionRepository>();
        await store.CreateOrGetAsync(Connection(), default);
        spy.BeforeReply = async () => await store.ReplaceAsync(Connection() with { ConfigEpoch = 8 }, 7, default);
        var http = factory.CreateClient(); http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        var response = await http.GetAsync($"/api/connections/connection/node-settings?nodeId={NodeId}&configEpoch=7");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Queued_stale_request_is_rejected_before_upstream_admission()
    {
        var spy = new Spy();
        using var factory = new AdapterFactory().WithWebHostBuilder(builder => builder.ConfigureServices(services =>
        {
            services.RemoveAll<INodeSettingsClient>(); services.AddSingleton<INodeSettingsClient>(spy);
        }));
        var store = factory.Services.GetRequiredService<IConnectionRepository>();
        await store.CreateOrGetAsync(Connection(), default);
        var fence = factory.Services.GetRequiredService<ConnectionDispatchFence>();
        var lease = await fence.EnterAsync("connection", default);
        var http = factory.CreateClient(); http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        var pending = http.GetAsync($"/api/connections/connection/node-settings?nodeId={NodeId}&configEpoch=7");
        await Task.Delay(50);
        Assert.Equal(0, spy.Calls);
        Assert.True(await store.ReplaceAsync(Connection() with { ConfigEpoch = 8 }, 7, default));
        await lease.DisposeAsync();
        var response = await pending;
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(0, spy.Calls);
    }

    private static HttpResponseMessage Reply(string value, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    private static NodeSettingsClient Client(HttpMessageHandler handler) => new(new HttpClient(handler),
        new HarnessAddressPolicy(Options.Create(new HarnessOptions { AllowedHosts = "example.test" })));
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => send(request); }
    private sealed class Spy : INodeSettingsClient
    {
        public int Calls; public byte[]? LastBody; public Func<Task>? BeforeReply;
        public async Task<NodeSettingsResult> SendAsync(Connection connection, string nodeId, HttpMethod method,
            IReadOnlyList<string> suffix, IReadOnlyDictionary<string, string?> query, byte[]? body, CancellationToken ct)
        {
            Calls++; LastBody = body; if (BeforeReply is not null) await BeforeReply();
            using var json = JsonDocument.Parse("{\"schemaId\":\"harness-node-settings-v1\",\"revision\":3}");
            return new(200, json.RootElement.Clone());
        }
    }
}
