using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using Xunit;

public sealed class ProviderAuthTests
{
    private const string NodeId = "11111111-1111-4111-8111-111111111111";
    private const string CommandId = "22222222-2222-4222-8222-222222222222";
    private const string OperationId = "33333333-3333-4333-8333-333333333333";
    private static Connection Connection() => new("connection", "test", "https://example.test/prefix?tenant=a", 4,
        ObservationSettings.Default, Observation.Unknown with { NodeId = NodeId, Compatibility = "compatible" },
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);

    [Fact]
    public async Task Secret_is_write_only_and_transport_preserves_prefix_without_caller_headers()
    {
        var handler = new Handler(async request =>
        {
            Assert.Equal("/prefix/v1/provider-auth/operations", request.RequestUri!.AbsolutePath);
            Assert.Equal("?tenant=a", request.RequestUri.Query);
            Assert.False(request.Headers.Contains("Authorization"));
            Assert.False(request.Headers.Contains("X-Internal-Token"));
            Assert.False(request.Headers.Contains("Cookie"));
            using var input = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
            Assert.Equal("synthetic-write-only", input.RootElement.GetProperty("secret").GetString());
            return Reply(SnapshotJson(extra: ",\"secret\":\"do-not-reflect\""));
        });
        var result = await Client(handler).SendAsync(Connection(), NodeId, "operations", null,
            new() { NodeId = NodeId, CommandId = CommandId, Method = "secret", Secret = "synthetic-write-only" }, default);
        Assert.Equal(200, result.Status);
        Assert.DoesNotContain("do-not-reflect", JsonSerializer.Serialize(result));
        Assert.DoesNotContain("synthetic-write-only", JsonSerializer.Serialize(result));
    }

    [Theory]
    [InlineData("http://provider.test/login")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://name:secret@provider.test/login")]
    public async Task Rejects_unsafe_verification_links(string url)
    {
        var result = await Client(new Handler(_ => Task.FromResult(Reply(SnapshotJson(url)))))
            .SendAsync(Connection(), NodeId, "", null, null, default);
        Assert.Equal(502, result.Status); Assert.Null(result.Snapshot);
    }

    [Fact]
    public async Task Terminal_code_is_removed_and_wrong_operation_is_rejected()
    {
        var client = Client(new Handler(_ => Task.FromResult(Reply(SnapshotJson("https://provider.test/login", "succeeded")))));
        var result = await client.SendAsync(Connection(), NodeId, "", null, null, default);
        Assert.Null(result.Snapshot!.Operation!.UserCode);
        Assert.Null(result.Snapshot.Operation.VerificationUrl);
        result = await client.SendAsync(Connection(), NodeId, "", CommandId, null, default);
        Assert.Equal(502, result.Status);
    }

    [Fact]
    public async Task Untrusted_error_details_never_escape_and_redirects_are_rejected()
    {
        var client = Client(new Handler(_ => Task.FromResult(Reply("{\"code\":\"sensitive-value\",\"detail\":\"secret\"}", HttpStatusCode.Conflict))));
        var result = await client.SendAsync(Connection(), NodeId, "", null, null, default);
        Assert.Equal(409, result.Status); Assert.Equal("provider_error", result.Code);
        client = Client(new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect))));
        result = await client.SendAsync(Connection(), NodeId, "", null, null, default);
        Assert.Equal(502, result.Status); Assert.Equal("redirect_rejected", result.Code);
    }

    [Fact]
    public async Task Routes_require_internal_token_exact_identity_epoch_and_strict_input_without_persistence()
    {
        var spy = new Spy();
        using var factory = new AdapterFactory().WithWebHostBuilder(builder => builder.ConfigureServices(services =>
        {
            services.RemoveAll<IProviderAuthClient>(); services.AddSingleton<IProviderAuthClient>(spy);
        }));
        var store = factory.Services.GetRequiredService<IConnectionRepository>();
        await store.CreateOrGetAsync(Connection(), default);
        var http = factory.CreateClient();
        var url = $"/api/connections/connection/provider-auth?nodeId={NodeId}&configEpoch=4";
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.GetAsync(url)).StatusCode);
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        var response = await http.GetAsync(url);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.NoStore);
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync(url.Replace("configEpoch=4", "configEpoch=3"))).StatusCode);
        var commandUrl = "/api/connections/connection/provider-auth/operations?configEpoch=4";
        foreach (var body in new[] {
            new { nodeId = NodeId, commandId = CommandId, method = "secret", secret = "" },
            new { nodeId = NodeId, commandId = CommandId, method = "device_code", secret = "synthetic" }
        }) Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync(commandUrl, body)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync(commandUrl,
            new { nodeId = NodeId, commandId = CommandId, method = "secret", secret = "synthetic", unexpected = true })).StatusCode);
        Assert.Equal(1, spy.Calls);
        var before = await store.GetAsync("connection", default);
        response = await http.PostAsJsonAsync(commandUrl, new { nodeId = NodeId, commandId = CommandId, method = "secret", secret = "synthetic" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(before, await store.GetAsync("connection", default));
        Assert.Equal(2, spy.Calls);
    }

    [Fact]
    public async Task Changed_connection_discards_late_response()
    {
        using var baseline = new AdapterFactory();
        var spy = new Spy();
        using var factory = baseline.WithWebHostBuilder(builder => builder.ConfigureServices(services =>
        { services.RemoveAll<IProviderAuthClient>(); services.AddSingleton<IProviderAuthClient>(spy); }));
        var store = factory.Services.GetRequiredService<IConnectionRepository>();
        await store.CreateOrGetAsync(Connection(), default);
        spy.BeforeReply = async () => await store.ReplaceAsync(Connection() with { ConfigEpoch = 5 }, 4, default);
        var http = factory.CreateClient(); http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret");
        var response = await http.GetAsync($"/api/connections/connection/provider-auth?nodeId={NodeId}&configEpoch=4");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.DoesNotContain("userCode", await response.Content.ReadAsStringAsync());
    }

    private static string SnapshotJson(string? url = null, string status = "pending", string extra = "") =>
        $$"""{"schemaId":"harness-provider-auth-v1","nodeId":"{{NodeId}}","revision":1,"state":"unauthenticated","checkedAt":null,"reasonCode":null,"capabilities":{"methods":["device_code","secret"],"canCheck":true,"canLogout":true},"operation":{"operationId":"{{OperationId}}","commandId":"{{CommandId}}","method":"device_code","status":"{{status}}","createdAt":"2026-09-21T00:00:00Z","updatedAt":"2026-09-21T00:00:00Z","verificationUrl":{{JsonSerializer.Serialize(url)}},"userCode":"SYNTHETIC-CODE","expiresAt":null,"timeoutAt":null}{{extra}}}""";
    private static HttpResponseMessage Reply(string value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
    private static ProviderAuthClient Client(HttpMessageHandler handler) => new(new HttpClient(handler),
        new HarnessAddressPolicy(Options.Create(new HarnessOptions { AllowedHosts = "example.test" })));
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => send(request); }
    private sealed class Spy : IProviderAuthClient
    {
        public int Calls; public Func<Task>? BeforeReply;
        public async Task<ProviderAuthResult> SendAsync(Connection connection, string nodeId, string action, string? operationId, ProviderAuthCommand? input, CancellationToken ct)
        {
            Calls++; if (BeforeReply is not null) await BeforeReply();
            return new(200, new("harness-provider-auth-v1", nodeId, 1, "unauthenticated", null, null, new(["secret"], true, true), null));
        }
    }
}
