using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

public class ProjectionTests
{
    private const string NodeId = "11111111-1111-4111-8111-111111111111";
    private const string TerminalDialog = "30000000-0000-4000-8000-000000000001";
    private const string ActiveDialog = "30000000-0000-4000-8000-000000000002";

    [Fact]
    public async Task Work_reads_every_page_and_excludes_terminal_requests()
    {
        var calls = 0;
        var client = new ProjectionClient((path, query) =>
        {
            if (path[^1] == "snapshot") return Document("{\"activeAttempt\":null}");
            calls++;
            if (query!["cursor"] is null)
                return Page(Enumerable.Range(0, 100).Select(i => Request(i, "queued", TerminalDialog)), "next", "requests");
            return Page([Request(100, "active", TerminalDialog), Request(101, "completed", TerminalDialog)], null, "requests");
        });

        var result = await HarnessProjectionReader.ReadWorkAsync([Connection()], client, default);

        Assert.Equal(101, result.Count);
        Assert.Equal(2, calls);
        Assert.DoesNotContain(result, x => x.RequestId.EndsWith("000000000101", StringComparison.Ordinal));
    }

    [Fact]
    public async Task History_contains_only_terminal_dialogs_and_reads_all_message_pages()
    {
        var messageCalls = 0;
        var client = new ProjectionClient((path, query) =>
        {
            if (path[^1] == "requests")
                return Page([Request(1, "completed", TerminalDialog), Request(2, "active", ActiveDialog)], null, "requests");
            if (path[^1] == "dialogs")
                return Page([Dialog(TerminalDialog), Dialog(ActiveDialog)], null, "dialogs");
            messageCalls++;
            if (query!["cursor"] is null)
                return Page(Enumerable.Range(0, 100).Select(i => Message(i, i + 1)), "more", "history", TerminalDialog);
            return Page([Message(100, 101)], null, "history", TerminalDialog);
        });

        var result = await HarnessProjectionReader.ReadHistoryAsync([Connection()], client, default);

        var history = Assert.Single(result);
        Assert.Equal(TerminalDialog, history.DialogId);
        Assert.Equal(101, history.Messages.Count);
        Assert.Equal(2, messageCalls);
    }

    [Fact]
    public async Task Event_worker_starts_at_snapshot_cursor_and_publishes_new_event_only()
    {
        var store = new MemoryConnectionRepository();
        await store.CreateAsync(Connection(), default);
        var client = new EventClient();
        var publisher = new RecordingPublisher();
        var service = new HarnessEventInvalidationService(store, client, publisher,
            NullLogger<HarnessEventInvalidationService>.Instance);
        await service.StartAsync(default);
        await publisher.EventPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await service.StopAsync(default);

        Assert.Equal(42, client.StartedAfter);
        Assert.Contains(publisher.Calls, x => x.Kind == "event-stream-start");
        Assert.Contains(publisher.Calls, x => x.Kind == "event");
    }

    [Fact]
    public async Task Pagination_restarts_from_first_page_after_stale_cursor()
    {
        var client = new StaleOnceClient();
        var result = await HarnessProjectionReader.ReadWorkAsync([Connection()], client, default);
        Assert.Equal(2, result.Count);
        Assert.Equal(2, client.FirstPageReads);
    }

    [Fact]
    public async Task Cross_node_page_is_rejected()
    {
        var page = JsonSerializer.SerializeToDocument(new { protocolVersion = 1, schemaId = "harness-wire-v2",
            nodeId = "99999999-9999-4999-8999-999999999999", epoch = 1, snapshotStateVersion = 1,
            lastEventSeq = 1, nextCursor = (string?)null, pageType = "requests", items = Array.Empty<object>() });
        var client = new ProjectionClient((path, _) => path[^1] == "snapshot" ? Document("{\"activeAttempt\":null}") : page);
        await Assert.ThrowsAsync<ProjectionUnavailableException>(() =>
            HarnessProjectionReader.ReadWorkAsync([Connection()], client, default));
    }

    [Fact]
    public async Task Repeated_stale_cursor_becomes_projection_unavailable()
    {
        var client = new AlwaysStaleClient();
        await Assert.ThrowsAsync<ProjectionUnavailableException>(() =>
            HarnessProjectionReader.ReadWorkAsync([Connection()], client, default));
        Assert.Equal(3, client.FirstPageReads);
    }

    private static Connection Connection() => new("c1", "node", "https://node.test/", 1,
        ObservationSettings.Default, Observation.Unknown with { Compatibility = "compatible", NodeId = NodeId },
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
    private static object Request(int id, string status, string dialog) => new
        { requestId = $"50000000-0000-4000-8000-{id:D12}", dialogId = dialog,
          inputMessageId = $"40000000-0000-4000-8000-{id:D12}", status, version = 1, queueSequence = id + 1 };
    private static object Dialog(string id) => new { dialogId = id, title = id, version = 1, createdAt = "2026-09-21T00:00:00Z" };
    private static object Message(int id, int sequence) => new
        { messageId = $"60000000-0000-4000-8000-{id:D12}", dialogId = TerminalDialog,
          role = "assistant", sequence, version = 1, createdAt = "2026-09-21T00:00:00Z", text = id.ToString() };
    private static JsonDocument Page(IEnumerable<object> items, string? nextCursor, string pageType, string? dialogId = null) =>
        JsonSerializer.SerializeToDocument(new { protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = NodeId,
            epoch = 1, snapshotStateVersion = 1, lastEventSeq = 1, nextCursor, pageType, dialogId, items });
    private static JsonDocument Document(string json) => JsonDocument.Parse(json);

    private sealed class ProjectionClient(Func<IReadOnlyList<string>, IReadOnlyDictionary<string, string?>?, JsonDocument?> response) : IHarnessClient
    {
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) => Task.FromResult(response(path, query));
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken) { await Task.CompletedTask; yield break; }
    }

    private sealed class EventClient : IHarnessClient
    {
        public long? StartedAfter { get; private set; }
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) =>
            Task.FromResult<JsonDocument?>(JsonDocument.Parse("{\"lastEventSeq\":42}"));
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            StartedAfter = after;
            yield return after + 1;
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class StaleOnceClient : IHarnessClient
    {
        private bool _staled;
        public int FirstPageReads { get; private set; }
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) =>
            Task.FromResult<JsonDocument?>(path[^1] == "snapshot" ? Document("{\"activeAttempt\":null}") : null);
        public Task<HarnessGetResult> GetResultAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken)
        {
            if (path[^1] == "snapshot") return Task.FromResult(new HarnessGetResult(200, Document("{\"activeAttempt\":null}")));
            if (query!["cursor"] is null)
            {
                FirstPageReads++;
                return Task.FromResult(new HarnessGetResult(200, Page([Request(1, "queued", TerminalDialog)], "next", "requests")));
            }
            if (!_staled)
            {
                _staled = true;
                return Task.FromResult(new HarnessGetResult(409, null));
            }
            return Task.FromResult(new HarnessGetResult(200, Page([Request(2, "active", TerminalDialog)], null, "requests")));
        }
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken) { await Task.CompletedTask; yield break; }
    }

    private sealed class RecordingPublisher : ICentrifugoPublisher
    {
        public List<(string Resource, string Kind)> Calls { get; } = [];
        public TaskCompletionSource EventPublished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken cancellationToken)
        {
            Calls.Add((resource, kind));
            if (kind == "event") EventPublished.TrySetResult();
            return Task.CompletedTask;
        }
    }

    private sealed class AlwaysStaleClient : IHarnessClient
    {
        public int FirstPageReads { get; private set; }
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) => Task.FromResult<JsonDocument?>(null);
        public Task<HarnessGetResult> GetResultAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken)
        {
            if (query!["cursor"] is null)
            {
                FirstPageReads++;
                return Task.FromResult(new HarnessGetResult(200,
                    Page([Request(1, "queued", TerminalDialog)], "next", "requests")));
            }
            return Task.FromResult(new HarnessGetResult(409, null));
        }
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken) { await Task.CompletedTask; yield break; }
    }
}
