using System.Net;
using System.Text;
using Microsoft.Extensions.Options;
using Xunit;

public class HarnessClientTests
{
    [Fact]
    public void Uri_join_preserves_prefix_and_base_query_and_escapes_ids()
    {
        var uri = HarnessUri.Build("https://node.test/root/harness?tenant=alpha", ["v1", "nodes", "id/with space", "requests"],
            new Dictionary<string, string?> { ["limit"] = "100", ["cursor"] = "a+b" });
        Assert.Equal("/root/harness/v1/nodes/id%2Fwith%20space/requests", uri.AbsolutePath);
        Assert.Equal("?tenant=alpha&limit=100&cursor=a%2Bb", uri.Query);
    }

    [Theory]
    [InlineData("http://127.0.0.1:8080/")]
    [InlineData("http://localhost:8080/")]
    [InlineData("http://node.test/")]
    [InlineData("https://user:secret@node.test/")]
    [InlineData("https://node.test/#secret")]
    [InlineData("ftp://node.test/")]
    public void Unsafe_base_uri_is_rejected(string value) => Assert.False(HarnessUri.IsSafeBase(new Uri(value)));

    [Fact]
    public async Task Legacy_plaintext_connection_is_isolated_as_unreachable()
    {
        var result = await Create(new ScriptedHandler(_ => throw new InvalidOperationException("must not send")))
            .ProbeAsync(Connection("http://node.test/"), default);
        Assert.False(result.Observation.HttpReachable);
        Assert.False(result.Observation.Ready);
        Assert.Equal("unreachable", result.Observation.ErrorCode);
    }

    [Fact]
    public async Task Probe_reads_independent_heartbeat_and_leaks_no_credentials()
    {
        var observedAt = DateTimeOffset.UtcNow.ToString("O");
        var handler = new ScriptedHandler(request =>
        {
            Assert.False(request.Headers.Contains("Authorization"));
            Assert.False(request.Headers.Contains("Cookie"));
            Assert.False(request.Headers.Contains("X-Internal-Token"));
            var path = request.RequestUri!.AbsolutePath;
            return path switch
            {
                "/prefix/v1/identity" => Json("{\"protocolVersion\":1,\"schemaId\":\"harness-wire-v2\",\"nodeId\":\"11111111-1111-4111-8111-111111111111\"}"),
                "/prefix/health/live" => Json("{\"status\":\"live\"}"),
                "/prefix/v1/executor/heartbeat" => Json($"{{\"nodeId\":\"11111111-1111-4111-8111-111111111111\",\"bootId\":\"22222222-2222-4222-8222-222222222222\",\"observedAt\":\"{observedAt}\",\"health\":\"live\",\"readiness\":\"ready\",\"capacity\":100}}"),
                "/prefix/health/ready" => Json("{\"readiness\":\"ready\"}"),
                _ => new(HttpStatusCode.NotFound)
            };
        });
        var client = Create(handler);
        var result = await client.ProbeAsync(Connection("https://node.test/prefix?tenant=a"), default);
        Assert.True(result.Observation.HttpReachable);
        Assert.True(result.Observation.ExecutorHealthy);
        Assert.True(result.Observation.Ready);
        Assert.Equal("22222222-2222-4222-8222-222222222222", result.Observation.BootId);
        Assert.Equal("100", result.Observation.Capacity);
        Assert.Equal("compatible", result.Observation.Compatibility);
        Assert.All(handler.Requests, x => Assert.Equal("tenant=a", x.Query.TrimStart('?')));
    }

    [Theory]
    [InlineData("{\"nodeId\":\"11111111-1111-4111-8111-111111111111\",\"observedAt\":\"2026-09-21T10:00:00Z\",\"health\":\"live\",\"readiness\":\"ready\"}")]
    [InlineData("{\"nodeId\":\"11111111-1111-4111-8111-111111111111\",\"bootId\":\"22222222-2222-4222-8222-222222222222\",\"health\":\"live\",\"readiness\":\"ready\"}")]
    public async Task Missing_heartbeat_identity_or_timestamp_is_incompatible_and_not_ready(string heartbeat)
    {
        var handler = new ScriptedHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/v1/identity" => Json("{\"protocolVersion\":1,\"schemaId\":\"harness-wire-v2\",\"nodeId\":\"11111111-1111-4111-8111-111111111111\"}"),
            "/health/live" => Json("{\"status\":\"live\"}"),
            "/v1/executor/heartbeat" => Json(heartbeat),
            "/health/ready" => Json("{\"readiness\":\"ready\"}"),
            _ => new(HttpStatusCode.NotFound)
        });
        var result = await Create(handler).ProbeAsync(Connection("https://node.test/"), default);
        Assert.Equal("incompatible", result.Observation.Compatibility);
        Assert.Equal("heartbeat_contract_mismatch", result.Observation.ErrorCode);
        Assert.False(result.Observation.Ready);
    }

    [Theory]
    [InlineData("missing-health")]
    [InlineData("future")]
    [InlineData("stale")]
    public async Task Invalid_or_non_fresh_heartbeat_is_never_ready(string kind)
    {
        var timestamp = kind switch
        {
            "future" => DateTimeOffset.UtcNow.AddHours(1),
            "stale" => DateTimeOffset.UtcNow.AddHours(-1),
            _ => DateTimeOffset.UtcNow
        };
        var health = kind == "missing-health" ? "" : ",\"health\":\"live\"";
        var heartbeat = $"{{\"nodeId\":\"11111111-1111-4111-8111-111111111111\",\"bootId\":\"22222222-2222-4222-8222-222222222222\",\"observedAt\":\"{timestamp:O}\"{health},\"readiness\":\"ready\"}}";
        var result = await ProbeWithHeartbeat(heartbeat);
        Assert.False(result.Observation.Ready);
        if (kind == "missing-health") Assert.Equal("incompatible", result.Observation.Compatibility);
    }

    [Fact]
    public async Task Malformed_http_response_is_reachable_but_incompatible()
    {
        var result = await Create(new ScriptedHandler(_ => Json("{"))).ProbeAsync(Connection("https://node.test/"), default);
        Assert.True(result.Observation.HttpReachable);
        Assert.Equal("incompatible", result.Observation.Compatibility);
        Assert.False(result.Observation.Ready);
        Assert.Equal("invalid_response", result.Observation.ErrorCode);
    }

    [Fact]
    public async Task Event_stream_ignores_keepalive_and_yields_only_durable_sequences()
    {
        var handler = new ScriptedHandler(_ => new(HttpStatusCode.OK)
        {
            Content = new StringContent(": keep-alive\n\nid: 7\ndata: {\"seq\":7,\"type\":\"request.created\"}\n\n", Encoding.UTF8, "text/event-stream")
        });
        var connection = Connection("https://node.test/") with
            { Observation = Observation.Unknown with { NodeId = "11111111-1111-4111-8111-111111111111", Compatibility = "compatible" } };
        var sequences = new List<long>();
        await foreach (var sequence in Create(handler).WatchEventsAsync(connection, 0, default)) sequences.Add(sequence);
        Assert.Equal([7L], sequences);
    }

    [Fact]
    public void Missing_or_unreachable_heartbeat_never_remains_ready()
    {
        var now = DateTimeOffset.UtcNow;
        var neverObserved = Connection("https://node.test/");
        Assert.Null(ObservationResponse.From(neverObserved).Ready);

        var unreachable = neverObserved with { Observation = new(now, now, false, null, true, null,
            now, "22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111",
            1, "harness-wire-v2", "compatible", "unreachable") };
        Assert.False(ObservationResponse.From(unreachable).Ready);
    }

    private static Task<HarnessProbeResult> ProbeWithHeartbeat(string heartbeat)
    {
        var handler = new ScriptedHandler(request => request.RequestUri!.AbsolutePath switch
        {
            "/v1/identity" => Json("{\"protocolVersion\":1,\"schemaId\":\"harness-wire-v2\",\"nodeId\":\"11111111-1111-4111-8111-111111111111\"}"),
            "/health/live" => Json("{\"status\":\"live\"}"),
            "/v1/executor/heartbeat" => Json(heartbeat),
            "/health/ready" => Json("{\"readiness\":\"ready\"}"),
            _ => new(HttpStatusCode.NotFound)
        });
        return Create(handler).ProbeAsync(Connection("https://node.test/"), default);
    }

    [Fact]
    public async Task Redirect_is_rejected_and_never_followed()
    {
        var handler = new ScriptedHandler(_ => new(HttpStatusCode.Found) { Headers = { Location = new Uri("https://evil.test/steal") } });
        var result = await Create(handler).ProbeAsync(Connection("https://node.test/prefix"), default);
        Assert.Equal("redirect_rejected", result.Observation.ErrorCode);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Wrong_contract_is_incompatible_not_ready()
    {
        var handler = new ScriptedHandler(_ => Json("{\"protocolVersion\":9,\"schemaId\":\"other\",\"nodeId\":\"11111111-1111-4111-8111-111111111111\"}"));
        var result = await Create(handler).ProbeAsync(Connection("https://node.test/prefix"), default);
        Assert.Equal("incompatible", result.Observation.Compatibility);
        Assert.False(result.Observation.Ready);
    }

    private static HarnessClient Create(HttpMessageHandler handler)
    {
        var options = Options.Create(new HarnessOptions { AllowedHosts = "node.test", MaximumResponseBytes = 64 * 1024 });
        return new(new HttpClient(handler), options, new HarnessAddressPolicy(options));
    }
    private static Connection Connection(string uri) => new("c1", "node", uri, 1,
        new ObservationSettings(2, 2, 5), Observation.Unknown, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
    private static HttpResponseMessage Json(string value) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(value, Encoding.UTF8, "application/json")
    };
    private sealed class ScriptedHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(callback(request));
        }
    }
}

public class EpochFencingTests
{
    [Fact]
    public async Task Late_observation_from_old_uri_cannot_overwrite_new_epoch()
    {
        var store = new MemoryConnectionRepository();
        var now = DateTimeOffset.UtcNow;
        var old = new Connection("c1", "one", "https://old.test/", 1, ObservationSettings.Default, Observation.Unknown, now, now);
        await store.CreateAsync(old, default);
        var current = old with { BaseUri = "https://new.test/", ConfigEpoch = 2, Observation = Observation.Unknown };
        Assert.True(await store.ReplaceAsync(current, 1, default));
        var stale = Observation.Unknown with { AttemptedAt = now, HttpReachable = true, Compatibility = "compatible" };
        Assert.False(await store.UpdateObservationAsync("c1", 1, stale, default));
        Assert.Equal(2, (await store.GetAsync("c1", default))!.ConfigEpoch);
        Assert.Null((await store.GetAsync("c1", default))!.Observation.HttpReachable);
    }
}
