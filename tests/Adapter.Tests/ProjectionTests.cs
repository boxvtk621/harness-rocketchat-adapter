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
    public void Timestamp_only_probe_does_not_change_node_semantics_but_deadline_does()
    {
        var now = DateTimeOffset.UtcNow;
        var connection = Connection() with { Observation = Observation.Unknown with
        {
            AttemptedAt = now, SuccessfulAt = now, HeartbeatAt = now, HttpReachable = true,
            ExecutorHealthy = true, Ready = true, Compatibility = "compatible", BootId = NodeId,
            NodeId = NodeId, HeartbeatFresh = true
        } };
        var timestampOnly = connection with { Observation = connection.Observation with
        { AttemptedAt = now.AddSeconds(1), SuccessfulAt = now.AddSeconds(1), HeartbeatAt = now.AddSeconds(1) } };
        Assert.Equal(ObservationSemantics.Key(connection), ObservationSemantics.Key(timestampOnly));
        var stale = connection with { Observation = ObservationSemantics.WithFreshness(connection.Observation,
            connection.Settings, now.AddSeconds(connection.Settings.StaleThresholdSeconds + 1)) };
        Assert.NotEqual(ObservationSemantics.Key(connection), ObservationSemantics.Key(stale));
        Assert.Equal("stale", ObservationResponse.From(stale).Availability);
    }

    [Theory]
    [InlineData("later", 2)]
    [InlineData("cap", 5)]
    [InlineData("throw", 1)]
    [InlineData("cursor", 1)]
    public async Task History_failure_diagnostics_paginate_and_preserve_history_when_incomplete(string mode, int expectedReads)
    {
        var reads = 0;
        var client = new ProjectionClient((path, query) =>
        {
            if (path[^1] == "events")
            {
                reads++;
                if (mode == "throw") throw new HttpRequestException("diagnostics unavailable");
                var after = long.Parse(query!["after"]!);
                Assert.Equal((reads - 1) * 100, after);
                return JsonSerializer.SerializeToDocument(new { protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = NodeId,
                    dialogId = TerminalDialog, attemptId = AttemptId(1), epoch = 1, snapshotStateVersion = 1, lastEventSeq = 600,
                    pageType = "events", nextCursor = mode == "later" && reads == 2 ? null : (mode == "cursor" ? after : after + 100).ToString(),
                    items = reads == 2 ? new object[] { new { nodeId = NodeId, dialogId = TerminalDialog, attemptId = AttemptId(1), seq = 101,
                        type = "attempt.failed", payload = new { generation = 1, effectStatus = "none", errorCode = "codex_model_unsupported" } } } : [] });
            }
            return path[^1] switch
            {
                "requests" => Page([Request(1, "failed", TerminalDialog)], null, "requests"),
                "dialogs" => Page([Dialog(TerminalDialog)], null, "dialogs"),
                "attempts" => Page([new { attemptId = AttemptId(1), dialogId = TerminalDialog, requestId = RequestId(1), generation = 1,
                    version = 1, state = "failed", effectStatus = "none", startedAt = "2026-09-21T00:01:00Z", finishedAt = "2026-09-21T00:02:00Z" }], null, "attempts", TerminalDialog, RequestId(1)),
                _ => Page([UserInput(1, 1)], null, "history", TerminalDialog)
            };
        });
        var result = Assert.Single(await HarnessProjectionReader.ReadHistoryAsync([Connection()], client, default));
        Assert.Single(result.Messages);
        Assert.Equal(expectedReads, reads);
        Assert.Contains(mode == "later" ? "Модель Codex" : "Диагностика неполная", result.FailureReason);
    }

    [Theory]
    [InlineData("completed")]
    [InlineData("queued")]
    public async Task History_groups_distinct_retry_requests_by_original_input_and_keeps_prior_attempts(string latestStatus)
    {
        const string input = "40000000-0000-4000-8000-000000000001";
        var client = new ProjectionClient((path, _) => path[^1] switch
        {
            "requests" => Page([Request(1, "failed", TerminalDialog), new {requestId=RequestId(2),dialogId=TerminalDialog,inputMessageId=input,status=latestStatus,version=1,queueSequence=3}],null,"requests"),
            "dialogs" => Page([Dialog(TerminalDialog)],null,"dialogs"),
            "attempts" when path[^2]==RequestId(1) => Page([Attempt(1,1,TerminalDialog)],null,"attempts",TerminalDialog,RequestId(1)),
            "attempts" => Page(latestStatus=="queued" ? [] : [Attempt(2,2,TerminalDialog)],null,"attempts",TerminalDialog,RequestId(2)),
            _ => Page([UserInput(1,1),Message(1,2,1,1),Message(2,3,2,2)],null,"history",TerminalDialog)
        });
        var result=Assert.Single(await HarnessProjectionReader.ReadHistoryAsync([Connection()],client,default));
        Assert.Equal(input,result.InputMessageId);
        Assert.Equal(RequestId(2),result.RequestId);
        Assert.Equal(latestStatus,result.Status);
        Assert.Equal(latestStatus=="queued" ? 1 : 2,result.Attempts.Count);
        Assert.Single(result.Messages,message=>message.Role=="user");
        Assert.Null(result.FailureReason);
    }

    [Fact]
    public async Task Work_reads_every_page_and_excludes_terminal_requests()
    {
        var calls = 0;
        var client = new ProjectionClient((path, query) =>
        {
            if (path[^1] == "snapshot") return Document("{\"activeAttempt\":null}");
            if (path[^1] == "dialogs") return Page([Dialog(TerminalDialog)], null, "dialogs");
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
            if (path[^1] == "attempts")
                return Page([Attempt(1, 1, TerminalDialog)], null, "attempts", TerminalDialog, RequestId(1));
            messageCalls++;
            if (query!["cursor"] is null)
                return Page(Enumerable.Range(0, 100).Select(i => Message(i, i + 1)), "more", "history", TerminalDialog);
            return Page([Message(100, 101)], null, "history", TerminalDialog);
        });

        var result = await HarnessProjectionReader.ReadHistoryAsync([Connection()], client, default);

        var history = Assert.Single(result);
        Assert.Equal(TerminalDialog, history.DialogId);
        Assert.Equal(RequestId(1), history.RequestId);
        Assert.Equal("2026-09-21T00:02:00Z", history.CompletedAt);
        Assert.Equal(101, history.Messages.Count);
        Assert.Equal(2, messageCalls);
    }

    [Fact]
    public async Task History_reads_all_request_pages_and_deduplicates_overlapping_requests()
    {
        var requestPages = 0;
        var client = new ProjectionClient((path, query) =>
        {
            if (path[^1] == "requests")
            {
                requestPages++;
                return query!["cursor"] is null
                    ? Page([Request(1, "completed", TerminalDialog)], "more", "requests")
                    : Page([Request(1, "completed", TerminalDialog), Request(2, "completed", TerminalDialog)], null, "requests");
            }
            if (path[^1] == "dialogs") return Page([Dialog(TerminalDialog)], null, "dialogs");
            if (path[^1] == "attempts")
            {
                var id = path[^2] == RequestId(1) ? 1 : 2;
                return Page([Attempt(id, id, TerminalDialog)], null, "attempts", TerminalDialog, RequestId(id));
            }
            return Page([UserInput(1, 1), Message(1, 2, 1, 1), UserInput(2, 3), Message(2, 4, 2, 2)], null, "history", TerminalDialog);
        });

        var result = await HarnessProjectionReader.ReadHistoryAsync([Connection()], client, default);

        Assert.Equal(2, requestPages);
        Assert.Equal(new[] { RequestId(1), RequestId(2) }, result.Select(x => x.RequestId));
    }

    [Fact]
    public async Task History_retains_distinct_terminal_requests_in_one_dialog_without_fake_completion_time()
    {
        var client = new ProjectionClient((path, _) => path[^1] switch
        {
            "requests" => Page([Request(1, "completed", TerminalDialog), Request(2, "failed", TerminalDialog)], null, "requests"),
            "dialogs" => Page([Dialog(TerminalDialog)], null, "dialogs"),
            "attempts" when path[^2] == RequestId(1) =>
                Page([Attempt(1, 1, TerminalDialog)], null, "attempts", TerminalDialog, RequestId(1)),
            "attempts" => Page([Attempt(2, 2, TerminalDialog, finishedAt: null)], null, "attempts", TerminalDialog, RequestId(2)),
            _ => Page([UserInput(1, 1), Message(1, 2, 1, 1), UserInput(2, 3), Message(2, 4, 2, 2)],
                null, "history", TerminalDialog)
        });

        var result = await HarnessProjectionReader.ReadHistoryAsync([Connection()], client, default);

        Assert.Equal(2, result.Count);
        Assert.Equal(2, result.Select(x => x.RequestId).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(2, result.Single(x => x.RequestId == RequestId(1)).Messages.Count);
        Assert.Equal(2, result.Single(x => x.RequestId == RequestId(2)).Messages.Count);
        Assert.Equal("2026-09-21T00:00:00Z", result.Single(x => x.RequestId == RequestId(1)).CreatedAt);
        Assert.Null(result.Single(x => x.RequestId == RequestId(2)).CompletedAt);
    }

    [Fact]
    public async Task Unknown_request_is_visible_as_attention_work()
    {
        var client = new ProjectionClient((path, _) => path[^1] switch
        {
            "snapshot" => Document("{\"activeAttempt\":null}"),
            "dialogs" => Page([Dialog(TerminalDialog)], null, "dialogs"),
            _ => Page([Request(9, "unknown", TerminalDialog)], null, "requests")
        });

        var item = Assert.Single(await HarnessProjectionReader.ReadWorkAsync([Connection()], client, default));
        Assert.True(item.AttentionRequired);
        Assert.Equal("unknown", item.Status);
        Assert.Equal(TerminalDialog, item.DialogId);
    }

    [Fact]
    public async Task Event_worker_replays_from_zero_when_no_cursor_is_persisted()
    {
        var store = new MemoryConnectionRepository();
        await store.CreateOrGetAsync(Connection(), default);
        var client = new EventClient();
        var publisher = new RecordingPublisher();
        var service = new HarnessEventInvalidationService(store, client, new MemoryResourceRevisions(),
            new MemoryEventRelations(), new MemoryEventCursors(), publisher,
            NullLogger<HarnessEventInvalidationService>.Instance);
        await service.StartAsync(default);
        await publisher.EventPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await service.StopAsync(default);

        Assert.Equal(0, client.StartedAfter);
        Assert.DoesNotContain(publisher.Calls, x => x.Kind == "event-stream-start");
        Assert.Contains(publisher.Calls, x => x.Resource == "work" && x.Kind == "request.created");
        Assert.DoesNotContain(publisher.Calls, x => x.Resource == "history");
    }

    [Fact]
    public async Task Attempt_terminal_uses_persisted_request_relation_for_exact_history()
    {
        var store = new MemoryConnectionRepository();
        await store.CreateOrGetAsync(Connection(), default);
        var publisher = new RecordingPublisher();
        var service = new HarnessEventInvalidationService(store, new AttemptEventClient(),
            new MemoryResourceRevisions(), new MemoryEventRelations(), new MemoryEventCursors(), publisher,
            NullLogger<HarnessEventInvalidationService>.Instance);
        await service.StartAsync(default);
        await publisher.HistoryPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await service.StopAsync(default);
        Assert.Contains(publisher.Calls, x => x.Resource == "history" && x.Kind == "attempt.completed");
    }

    [Fact]
    public async Task Restart_resumes_persisted_cursor_and_ignores_duplicate_event()
    {
        var store = new MemoryConnectionRepository();
        await store.CreateOrGetAsync(Connection(), default);
        var cursors = new MemoryEventCursors();
        var revisions = new MemoryResourceRevisions();
        var relations = new MemoryEventRelations();
        var publisher = new RecordingPublisher();
        var firstClient = new ReplayEventClient(false);
        var first = new HarnessEventInvalidationService(store, firstClient, revisions, relations, cursors, publisher,
            NullLogger<HarnessEventInvalidationService>.Instance);
        await first.StartAsync(default);
        await publisher.EventPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cursors.FirstAdvance.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await first.StopAsync(default);

        var secondClient = new ReplayEventClient(true);
        var second = new HarnessEventInvalidationService(store, secondClient, revisions, relations, cursors, publisher,
            NullLogger<HarnessEventInvalidationService>.Instance);
        await second.StartAsync(default);
        await publisher.SecondWorkPublished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await cursors.SecondAdvance.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await second.StopAsync(default);

        Assert.Equal(0, firstClient.StartedAfter);
        Assert.Equal(1, secondClient.StartedAfter);
        Assert.Equal(2, publisher.Calls.Count(x => x.Resource == "work"));
        Assert.Equal(2, await cursors.ReadAsync(Connection(), default));
    }

    [Fact]
    public async Task Event_worker_replacement_waits_for_retired_stream()
    {
        var store = new MemoryConnectionRepository();
        var original = Connection();
        await store.CreateOrGetAsync(original, default);
        var client = new ConcurrencyEventClient();
        var service = new HarnessEventInvalidationService(store, client, new MemoryResourceRevisions(),
            new MemoryEventRelations(), new MemoryEventCursors(), new RecordingPublisher(),
            NullLogger<HarnessEventInvalidationService>.Instance);
        await service.StartAsync(default);
        await client.FirstStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(await store.ReplaceAsync(original with { ConfigEpoch = 2 }, 1, default));
        await client.SecondStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await service.StopAsync(default);

        Assert.Equal(1, client.MaximumConcurrent);
        Assert.Equal(0, client.Current);
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
    private static string RequestId(int id) => $"50000000-0000-4000-8000-{id:D12}";
    private static string AttemptId(int id) => $"70000000-0000-4000-8000-{id:D12}";
    private static object Request(int id, string status, string dialog) => new
        { requestId = RequestId(id), dialogId = dialog,
          inputMessageId = $"40000000-0000-4000-8000-{id:D12}", status, version = 1, queueSequence = id + 1 };
    private static object Dialog(string id) => new { dialogId = id, title = id, version = 1, createdAt = "2026-09-21T00:00:00Z" };
    private static object Message(int id, int sequence, int request = 1, int attempt = 1) => new
        { messageId = $"60000000-0000-4000-8000-{id:D12}", dialogId = TerminalDialog,
          role = "assistant", sequence, version = 1, createdAt = "2026-09-21T00:00:00Z", text = id.ToString(),
          requestId = RequestId(request), attemptId = AttemptId(attempt) };
    private static object UserInput(int request, int sequence) => new
        { messageId = $"40000000-0000-4000-8000-{request:D12}", dialogId = TerminalDialog,
          role = "user", sequence, version = 1, createdAt = "2026-09-21T00:00:00Z", text = request.ToString() };
    private static object Attempt(int id, int request, string dialog, string? finishedAt = "2026-09-21T00:02:00Z") => new
        { attemptId = AttemptId(id), dialogId = dialog, requestId = RequestId(request), generation = 1,
          version = 1, state = "completed", effectStatus = "known", startedAt = "2026-09-21T00:01:00Z", finishedAt };
    private static JsonDocument Page(IEnumerable<object> items, string? nextCursor, string pageType,
        string? dialogId = null, string? requestId = null) =>
        JsonSerializer.SerializeToDocument(new { protocolVersion = 1, schemaId = "harness-wire-v2", nodeId = NodeId,
            epoch = 1, snapshotStateVersion = 1, lastEventSeq = 1, nextCursor, pageType, dialogId, requestId, items });
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
        public async IAsyncEnumerable<HarnessEvent> WatchDetailedEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            StartedAfter = after;
            // The event already existed before the worker started; bootstrapping from the snapshot
            // cursor (42) would skip it and leave an open Work view stale.
            yield return new HarnessEvent(43, "request.created", NodeId, RequestId(1), ActiveDialog, RequestId(1));
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class AttemptEventClient : IHarnessClient
    {
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) =>
            Task.FromResult<JsonDocument?>(Document("{\"lastEventSeq\":42}"));
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        { await Task.CompletedTask; yield break; }
        public async IAsyncEnumerable<HarnessEvent> WatchDetailedEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var attempt = AttemptId(1);
            yield return new HarnessEvent(43, "attempt.dispatching", NodeId, attempt, ActiveDialog, RequestId(1), attempt);
            yield return new HarnessEvent(44, "attempt.completed", NodeId, attempt, ActiveDialog, null, attempt);
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class ReplayEventClient(bool sendSecond) : IHarnessClient
    {
        public long? StartedAfter { get; private set; }
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) => Task.FromResult<JsonDocument?>(null);
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        { await Task.CompletedTask; yield break; }
        public async IAsyncEnumerable<HarnessEvent> WatchDetailedEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            StartedAfter = after;
            yield return new HarnessEvent(1, "request.created", NodeId, RequestId(1), ActiveDialog, RequestId(1));
            if (sendSecond)
                yield return new HarnessEvent(2, "request.created", NodeId, RequestId(2), ActiveDialog, RequestId(2));
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        }
    }

    private sealed class ConcurrencyEventClient : IHarnessClient
    {
        private int _starts;
        private int _current;
        private int _maximumConcurrent;
        public int Current => Volatile.Read(ref _current);
        public int MaximumConcurrent => Volatile.Read(ref _maximumConcurrent);
        public TaskCompletionSource FirstStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource SecondStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken) => throw new NotSupportedException();
        public Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
            IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) =>
            Task.FromResult<JsonDocument?>(JsonDocument.Parse("{\"lastEventSeq\":42}"));
        public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            var current = Interlocked.Increment(ref _current);
            int observed;
            do
            {
                observed = Volatile.Read(ref _maximumConcurrent);
                if (current <= observed) break;
            } while (Interlocked.CompareExchange(ref _maximumConcurrent, current, observed) != observed);
            var start = Interlocked.Increment(ref _starts);
            if (start == 1) FirstStarted.TrySetResult();
            if (start == 2) SecondStarted.TrySetResult();
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            finally { Interlocked.Decrement(ref _current); }
            yield break;
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
            if (path[^1] == "dialogs") return Task.FromResult(new HarnessGetResult(200,
                Page([Dialog(TerminalDialog)], null, "dialogs")));
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
        public TaskCompletionSource HistoryPublished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource SecondWorkPublished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task PublishInvalidationAsync(string resource, string connectionId, string kind, CancellationToken cancellationToken)
        {
            Calls.Add((resource, kind));
            if (resource == "work") EventPublished.TrySetResult();
            if (resource == "work" && Calls.Count(x => x.Resource == "work") == 2) SecondWorkPublished.TrySetResult();
            if (resource == "history") HistoryPublished.TrySetResult();
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
