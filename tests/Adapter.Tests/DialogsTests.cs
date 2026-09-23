using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Xunit;

public sealed class DialogsTests
{
    const string Node = "11111111-1111-4111-8111-111111111111";
    const string Dialog = "22222222-2222-4222-8222-222222222222";
    const string Command = "33333333-3333-4333-8333-333333333333";
    const string Root = "/api/dialogs/connection/nodes/" + Node;

    [Fact]
    public void Retry_is_exact_effect_free_and_receipt_is_bound_to_prior_attempt()
    {
        var command = JsonSerializer.SerializeToElement(new { protocolVersion=1, schemaId="harness-wire-v2", commandId=Command,
            kind="attempt.retry", target=new {nodeId=Node,attemptId=Dialog}, expected=new {attemptGeneration=1}, payload=new {acknowledgeKnownEffects=false} });
        Assert.True(DialogEndpoints.ValidCommand(command,Node));
        foreach (var changed in new[] { command.GetRawText().Replace("false","true"), command.GetRawText().Replace("\"attemptGeneration\":1","\"attemptGeneration\":\"bad\""), command.GetRawText().Replace("\"acknowledgeKnownEffects\":false","\"acknowledgeKnownEffects\":false,\"extra\":true") })
            Assert.False(DialogEndpoints.ValidCommand(JsonDocument.Parse(changed).RootElement,Node));
        var receipt=JsonSerializer.SerializeToElement(new { protocolVersion=1,schemaId="harness-wire-v2",nodeId=Node,commandId=Command,
            commandKind="attempt.retry",receiptId=Command,acceptedAt="2026-09-23T00:00:00Z",eventSeq=1,result="admitted",references=new {priorAttemptId=Dialog,requestId=Command,secret="hidden"} });
        var projected=DialogPublicDto.Project(Node,["commands"],new Dictionary<string,string?>(),receipt,command);
        Assert.NotNull(projected); Assert.DoesNotContain("hidden",projected.Value.GetRawText());
        Assert.Equal(Dialog,projected.Value.GetProperty("references").GetProperty("priorAttemptId").GetString());
        var mismatch=JsonDocument.Parse(receipt.GetRawText().Replace("\"priorAttemptId\":\""+Dialog,"\"priorAttemptId\":\""+Node)).RootElement;
        Assert.Null(DialogPublicDto.Project(Node,["commands"],new Dictionary<string,string?>(),mismatch,command));
    }

    [Fact]
    public void Historical_failure_events_are_scoped_bounded_and_never_relay_provider_text()
    {
        var body=JsonSerializer.SerializeToElement(new { protocolVersion=1,schemaId="harness-wire-v2",nodeId=Node,dialogId=Dialog,attemptId=Command,
            epoch=1,snapshotStateVersion=1,lastEventSeq=9,pageType="events",nextCursor=(string?)null,
            items=new[] {new {nodeId=Node,dialogId=Dialog,attemptId=Command,seq=9,type="attempt.failed",payload=new {generation=1,effectStatus="none",errorCode="codex_model_unsupported",safeMessage="SECRET provider prompt"}}} });
        var projected=DialogPublicDto.Project(Node,["attempts",Command,"events"],new Dictionary<string,string?>(),body,null);
        Assert.NotNull(projected); Assert.DoesNotContain("SECRET",projected.Value.GetRawText());
        Assert.Equal("codex_model_unsupported",projected.Value.GetProperty("items")[0].GetProperty("errorCode").GetString());
        Assert.Null(DialogPublicDto.Project(Node,["attempts",Dialog,"events"],new Dictionary<string,string?>(),body,null));
    }

    [Fact]
    public async Task Auth_and_target_fencing_precede_any_Harness_call()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await http.GetAsync(Root + "/dialogs?configEpoch=1")).StatusCode);
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync(Root + "/dialogs")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync(Root + "/dialogs?configEpoch=2")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await http.GetAsync(Root.Replace(Node, Dialog) + "/dialogs?configEpoch=1")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(Root + "/attempts/" + Dialog + "/raw-events?configEpoch=1")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync(Root + "/dialogs?configEpoch=1&limit=101")).StatusCode);
        Assert.Empty(app.Relay.Calls);
    }

    [Fact]
    public async Task History_is_bounded_and_keeps_public_dto_and_keyset_cursor()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app);
        app.Relay.Response = new(200, JsonSerializer.SerializeToElement(new { protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = Node, dialogId = Dialog, epoch = 1, snapshotStateVersion = 1, lastEventSeq = 1, pageType = "history", items = new[] { new { messageId = Command, dialogId = Dialog, role = "user", sequence = 1, version = 1, createdAt = "2026-09-21T00:00:00Z", text = "test", disposition = "queued", commandId = Command, requestId = Command } }, nextCursor = "opaque" }));
        using var response = await http.GetAsync(Root + $"/dialogs/{Dialog}/history?configEpoch=1&order=latest&limit=30&cursor=opaque");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var call = Assert.Single(app.Relay.Calls);
        Assert.Equal(new[] { "dialogs", Dialog, "messages" }, call.Path);
        Assert.Equal("latest", call.Query["order"]);
        Assert.Equal("30", call.Query["limit"]);
        Assert.False(call.Query.ContainsKey("configEpoch"));
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
    }

    [Fact]
    public async Task Lost_ack_is_unknown_and_no_automatic_second_submission_occurs()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app);
        app.Relay.Response = new(504, null);
        using var response = await http.PostAsJsonAsync(Root + "/commands?configEpoch=1", Enqueue());
        Assert.Equal(HttpStatusCode.GatewayTimeout, response.StatusCode);
        Assert.Contains("command_outcome_unknown", await response.Content.ReadAsStringAsync());
        var sent = Assert.Single(app.Relay.Calls).Command!.Value;
        Assert.Equal(Command, sent.GetProperty("commandId").GetString());
        Assert.Equal("hello", sent.GetProperty("payload").GetProperty("text").GetString());
        Assert.Equal(7, sent.GetProperty("expected").GetProperty("dialogVersion").GetInt32());
    }

    [Fact]
    public async Task Disallowed_control_and_target_mismatch_are_rejected_server_side()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app);
        foreach (var command in new[] { Enqueue("request.cancel"), Enqueue(node: Dialog), Enqueue(text: " ") })
            Assert.Equal(HttpStatusCode.BadRequest, (await http.PostAsJsonAsync(Root + "/commands?configEpoch=1", command)).StatusCode);
        Assert.Empty(app.Relay.Calls);
    }

    [Fact]
    public async Task Unready_node_allows_readback_but_does_not_admit_new_work()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app, false);
        app.Relay.Response = new(404, null);
        using var response = await http.PostAsJsonAsync(Root + "/commands?configEpoch=1", Enqueue());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(new[] { "commands", Command }, Assert.Single(app.Relay.Calls).Path);
        Assert.Null(app.Relay.Calls[0].Command);
        using var history = await http.GetAsync(Root + $"/dialogs/{Dialog}/history?configEpoch=1");
        Assert.Equal(HttpStatusCode.NotFound, history.StatusCode);
        Assert.Equal(2, app.Relay.Calls.Count);
    }

    [Fact]
    public async Task Transport_preserves_prefix_sends_no_credentials_and_checks_response_identity()
    {
        var handler = new CaptureHandler();
        var options = Options.Create(new HarnessOptions { AllowedHosts = "node.test" });
        using var http = new HttpClient(handler);
        var client = new DialogHarnessClient(http, new HarnessAddressPolicy(options));
        var connection = Connection(true);
        var command = JsonSerializer.SerializeToElement(Enqueue());
        var reply = await client.SendAsync(connection, Node, ["commands"], new Dictionary<string, string?>(), command, default, new(Node, 1, 1, "generic", "1"));
        Assert.Equal(200, reply.StatusCode);
        Assert.Equal("/prefix/v1/nodes/" + Node + "/commands", handler.Uri!.AbsolutePath);
        Assert.Equal("?tenant=x", handler.Uri.Query);
        Assert.DoesNotContain(handler.Headers!, x => x.Key is "Authorization" or "Cookie" or "X-Internal-Token");
        Assert.All(DialogIdentityFence.Headers, name => Assert.True(handler.Headers!.ContainsKey(name)));
        Assert.Contains(Command, handler.Body);
        handler.NodeId = Dialog;
        Assert.Equal(502, (await client.SendAsync(connection, Node, ["dialogs"], new Dictionary<string, string?>(), null, default)).StatusCode);
    }

    static object Enqueue(string kind = "message.enqueue", string node = Node, string text = "hello") => new
    {
        protocolVersion = 1, schemaId = "harness-wire-v2", commandId = Command, kind,
        target = new { nodeId = node, dialogId = Dialog }, expected = new { dialogVersion = 7 }, payload = new { text }
    };
    static void AddFence(HttpClient http)
    {
        var fence = new DialogIdentityFence(Node, 1, 1, "generic", "1");
        for (var i = 0; i < DialogIdentityFence.Headers.Length; i++) http.DefaultRequestHeaders.Add(DialogIdentityFence.Headers[i], fence.Values[i]);
    }

    [Fact]
    public void Public_projection_removes_private_fields_and_rejects_cross_dialog_history()
    {
        var body = JsonSerializer.SerializeToElement(new
        {
            protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = Node, dialogId = Dialog,
            epoch = 1, snapshotStateVersion = 1, lastEventSeq = 1, pageType = "history", hiddenReasoning = "must not reach browser", credentials = "must not reach browser",
            items = new[] { new { messageId = Command, dialogId = Dialog, role = "assistant", sequence = 1, version = 1, createdAt = "2026-09-21T00:00:00Z", attemptId = Command, finishReason = "complete", content = new
            { kind = "inline", content = "public result", redaction = "applied", truncated = false, privateToken = "must not reach browser" } } }, nextCursor = (string?)null
        });
        var projected = DialogPublicDto.Project(Node, ["dialogs", Dialog, "history"], new Dictionary<string, string?>(), body, null);
        Assert.NotNull(projected);
        Assert.DoesNotContain("must not reach browser", projected.Value.GetRawText());
        Assert.Contains("public result", projected.Value.GetRawText());
        Assert.Null(DialogPublicDto.Project(Node, ["dialogs", Command, "history"], new Dictionary<string, string?>(), body, null));
    }

    [Fact]
    public async Task Attempts_alias_addresses_exact_request_and_omits_unsupported_upstream_query()
    {
        await using var app = new DialogFactory();
        using var http = app.CreateClient();
        http.DefaultRequestHeaders.Add("X-Internal-Token", "test-secret"); AddFence(http);
        await Seed(app);
        app.Relay.Response = new(200, JsonSerializer.SerializeToElement(new { protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = Node, dialogId = Dialog, requestId = Command, epoch = 1, snapshotStateVersion = 1, lastEventSeq = 1, pageType = "attempts", items = Array.Empty<object>(), nextCursor = (string?)null }));
        using var response = await http.GetAsync(Root + $"/attempts?configEpoch=1&requestId={Command}&limit=30");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var call = Assert.Single(app.Relay.Calls);
        Assert.Equal(new[] { "requests", Command, "attempts" }, call.Path);
        Assert.False(call.Query.ContainsKey("requestId"));
    }

    [Theory]
    [InlineData("epoch")]
    [InlineData("snapshotStateVersion")]
    [InlineData("lastEventSeq")]
    [InlineData("nextCursor")]
    [InlineData("items")]
    public void Incomplete_page_is_not_success(string omitted)
    {
        var fields = new Dictionary<string, object?> { ["protocolVersion"] = 1, ["schemaId"] = "harness-wire-v2", ["nodeId"] = Node,
            ["epoch"] = 1, ["snapshotStateVersion"] = 1, ["lastEventSeq"] = 1, ["nextCursor"] = null, ["pageType"] = "dialogs", ["items"] = Array.Empty<object>() };
        Assert.NotNull(DialogPublicDto.Project(Node, ["dialogs"], new Dictionary<string, string?>(), JsonSerializer.SerializeToElement(fields), null));
        fields.Remove(omitted);
        Assert.Null(DialogPublicDto.Project(Node, ["dialogs"], new Dictionary<string, string?>(), JsonSerializer.SerializeToElement(fields), null));
    }
    static Connection Connection(bool ready)
    {
        var now = DateTimeOffset.UtcNow;
        return new("connection", "Test", "https://node.test/prefix?tenant=x", 1, ObservationSettings.Default,
            new(now, now, true, true, ready, "10", now, Dialog, Node, 1, "harness-wire-v2", "compatible", null), now, now);
    }
    static async Task Seed(DialogFactory app, bool ready = true) => await app.Services.GetRequiredService<IConnectionRepository>().CreateOrGetAsync(Connection(ready), default);

    sealed class DialogFactory : WebApplicationFactory<Program>
    {
        public FakeRelay Relay { get; } = new();
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration(c => c.AddInMemoryCollection(new Dictionary<string, string?>
            { ["Mongo:ConnectionString"] = "mongodb://unused", ["Mongo:Database"] = "test", ["InternalAuth:Token"] = "test-secret" }));
            builder.ConfigureServices(s =>
            {
                s.RemoveAll<IConnectionRepository>(); s.RemoveAll<ICentrifugoPublisher>(); s.RemoveAll<IHostedService>(); s.RemoveAll<IDialogHarnessClient>();
                s.AddSingleton<IConnectionRepository, MemoryConnectionRepository>(); s.AddSingleton<ICentrifugoPublisher, NoopPublisher>(); s.AddSingleton<IDialogHarnessClient>(Relay);
            });
        }
    }
    sealed class FakeRelay : IDialogHarnessClient
    {
        public DialogRelayReply Response { get; set; } = new(200, JsonSerializer.SerializeToElement(new { nodeId = Node }));
        public List<(string[] Path, IReadOnlyDictionary<string, string?> Query, JsonElement? Command)> Calls { get; } = [];
        public Task<DialogRelayReply> SendAsync(Connection connection, string nodeId, string[] path, IReadOnlyDictionary<string, string?> query, JsonElement? command, CancellationToken ct, DialogIdentityFence? fence = null)
        { Calls.Add((path, query, command)); return Task.FromResult(Response); }
    }
    sealed class CaptureHandler : HttpMessageHandler
    {
        public string NodeId { get; set; } = Node;
        public Uri? Uri; public string? Body; public Dictionary<string, string[]>? Headers;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Uri = request.RequestUri; Headers = request.Headers.ToDictionary(x => x.Key, x => x.Value.ToArray()); Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { nodeId = NodeId }), Encoding.UTF8, "application/json") };
        }
    }
}
