using System.Text.Json;

public sealed class HarnessObservationService(
    IConnectionRepository connections,
    IHarnessClient client,
    IResourceRevisions revisions,
    ICentrifugoPublisher publisher,
    ILogger<HarnessObservationService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            do { await ObserveDueAsync(stoppingToken); }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }

    internal async Task ObserveDueAsync(CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var connection in await connections.ListAsync(ct))
        {
            var stale = ObservationSemantics.WithFreshness(connection.Observation, connection.Settings, now);
            if (stale.HeartbeatFresh != connection.Observation.HeartbeatFresh)
                await CommitAndPublishAsync(connection, stale, ct);
            if (connection.Observation.AttemptedAt is { } attempted &&
                now - attempted < TimeSpan.FromSeconds(connection.Settings.IntervalSeconds)) continue;
            var epoch = connection.ConfigEpoch;
            HarnessProbeResult result;
            try { result = await client.ProbeAsync(connection, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("Harness observation failed for connection {ConnectionId}: {ErrorType}",
                    connection.Id, ex.GetType().Name);
                continue;
            }
            await CommitAndPublishAsync(connection, ObservationSemantics.WithFreshness(result.Observation, connection.Settings,
                DateTimeOffset.UtcNow), ct);
        }
    }

    private async Task CommitAndPublishAsync(Connection connection, Observation observation, CancellationToken ct)
    {
        var before = ConnectionIdentity.Analyze(await connections.ListAsync(ct));
        var committed = await connections.CommitObservationAsync(connection.Id, connection.ConfigEpoch, observation, ct);
        if (!committed.Written || committed.Connection is null) return;
        var after = ConnectionIdentity.Analyze(await connections.ListAsync(ct));
        var affected = new HashSet<string>(StringComparer.Ordinal);
        var identityChanged = false;
        if (committed.Changed) affected.Add(connection.Id);
        foreach (var (id, identity) in after)
            if (!before.TryGetValue(id, out var previous) || previous.Status != identity.Status ||
                !previous.ConflictingConnectionIds.SequenceEqual(identity.ConflictingConnectionIds))
            { affected.Add(id); identityChanged = true; }
        var listRevision = identityChanged
            ? await revisions.AdvanceAsync("nodes", "*", 0, null,
                $"identity:{connection.Id}:{committed.Connection.ObservationVersion}", ct)
            : null;
        foreach (var id in affected)
        {
            var item = id == connection.Id ? committed.Connection : await connections.GetAsync(id, ct);
            if (item is null) continue;
            if (id != connection.Id) item = await connections.AdvanceNodeRevisionAsync(id, item.ConfigEpoch, ct);
            if (item is null) continue;
            await publisher.PublishInvalidationAsync(new Invalidation(1, "nodes", id, item.Observation.NodeId,
                item.ConfigEpoch, null, null, item.NodeRevision, "observed", listRevision), ct);
        }
    }
}

public sealed class HarnessEventInvalidationService(
    IConnectionRepository connections,
    IHarnessClient client,
    IResourceRevisions revisions,
    IEventRelations relations,
    IEventCursors cursors,
    ICentrifugoPublisher publisher,
    ILogger<HarnessEventInvalidationService> logger) : BackgroundService
{
    private sealed record Worker(long Epoch, string NodeId, string? BootId, CancellationTokenSource Stop, Task Task);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var workers = new Dictionary<string, Worker>(StringComparer.Ordinal);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            do
            {
                var listed = await connections.ListAsync(stoppingToken);
                var conflictingIds = ConnectionIdentity.FindConflicts(listed)
                    .SelectMany(x => x.ConnectionIds).ToHashSet(StringComparer.Ordinal);
                var current = listed
                    .Where(x => x.Observation.Compatibility == "compatible" &&
                                Guid.TryParse(x.Observation.NodeId, out _) && !conflictingIds.Contains(x.Id))
                    .ToDictionary(x => x.Id, StringComparer.Ordinal);
                foreach (var item in workers.ToArray())
                {
                    if (!current.TryGetValue(item.Key, out var connection) ||
                        connection.ConfigEpoch != item.Value.Epoch ||
                        connection.Observation.NodeId != item.Value.NodeId ||
                        connection.Observation.BootId != item.Value.BootId || item.Value.Task.IsCompleted)
                    {
                        item.Value.Stop.Cancel();
                        workers.Remove(item.Key);
                        try { await item.Value.Task; }
                        catch (OperationCanceledException) when (item.Value.Stop.IsCancellationRequested) { }
                        catch (Exception ex)
                        {
                            logger.LogWarning("Retired Harness event worker failed for connection {ConnectionId}: {ErrorType}",
                                item.Key, ex.GetType().Name);
                        }
                        item.Value.Stop.Dispose();
                    }
                }
                foreach (var connection in current.Values)
                {
                    if (workers.ContainsKey(connection.Id)) continue;
                    var stop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    var task = RunAsync(connection, stop.Token);
                    workers[connection.Id] = new(connection.ConfigEpoch, connection.Observation.NodeId!,
                        connection.Observation.BootId, stop, task);
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            foreach (var worker in workers.Values) worker.Stop.Cancel();
            try { await Task.WhenAll(workers.Values.Select(x => x.Task)); }
            catch (OperationCanceledException) { }
            foreach (var worker in workers.Values) worker.Stop.Dispose();
        }
    }

    private async Task RunAsync(Connection connection, CancellationToken ct)
    {
        long? after = null;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (after is null)
                    after = await cursors.ReadAsync(connection, ct);
                await foreach (var item in client.WatchDetailedEventsAsync(connection, after.Value, ct))
                {
                    if (item.Seq <= after.Value) continue;
                    if (item.NodeId is null || item.NodeId == connection.Observation.NodeId)
                        await PublishEventAsync(connection, item, ct);
                    await cursors.AdvanceAsync(connection, item.Seq, ct);
                    after = item.Seq;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException or InvalidDataException)
            {
                logger.LogWarning("Harness event stream failed for connection {ConnectionId}: {ErrorType}",
                    connection.Id, ex.GetType().Name);
            }
            await Task.Delay(TimeSpan.FromSeconds(1), ct);
        }
    }

    private async Task PublishEventAsync(Connection connection, HarnessEvent item, CancellationToken ct)
    {
        if (item.Type is null) return;
        var type = item.Type;
        var resources = new List<(string Resource, string? Entity, string Kind)>();
        var requestId = item.RequestId ?? (type.StartsWith("request.", StringComparison.Ordinal) ? item.EntityId : null);
        if (item.AttemptId is { } attemptId)
        {
            if (requestId is not null)
                await relations.RememberAsync(connection.Id, connection.ConfigEpoch, attemptId, requestId, ct);
            else requestId = await relations.RequestAsync(connection.Id, connection.ConfigEpoch, attemptId, ct);
            if (requestId is null)
            {
                using var readback = await client.GetAsync(connection,
                    ["v1", "nodes", connection.Observation.NodeId!, "attempts", attemptId], null, ct);
                if (readback is { } document && document.RootElement.TryGetProperty("attempt", out var found) &&
                    found.ValueKind == JsonValueKind.Object &&
                    found.TryGetProperty("attemptId", out var foundId) && foundId.ValueKind == JsonValueKind.String &&
                    foundId.GetString() == attemptId &&
                    found.TryGetProperty("requestId", out var foundRequest) && foundRequest.ValueKind == JsonValueKind.String &&
                    Guid.TryParseExact(foundRequest.GetString(), "D", out _))
                {
                    requestId = foundRequest.GetString();
                    await relations.RememberAsync(connection.Id, connection.ConfigEpoch, attemptId, requestId!, ct);
                }
            }
        }
        var dialogId = item.DialogId ?? (type.StartsWith("dialog.", StringComparison.Ordinal) ? item.EntityId : null);
        if (type.StartsWith("request.", StringComparison.Ordinal) || type.StartsWith("attempt.", StringComparison.Ordinal) ||
            type == "queue.changed" || type == "message.accepted")
        {
            if (requestId is not null || type == "queue.changed") resources.Add(("work", requestId, type));
            if ((type is "request.completed" or "request.failed" or "request.cancelled" or "request.interrupted" or
                "attempt.completed" or "attempt.failed" or "attempt.interrupted" or "attempt.unknown") && requestId is not null)
                resources.Add(("history", requestId, type));
        }
        if (dialogId is not null && (type.StartsWith("dialog.", StringComparison.Ordinal) ||
            type.StartsWith("message.", StringComparison.Ordinal) || type.StartsWith("assistant.", StringComparison.Ordinal) ||
            type.StartsWith("tool.", StringComparison.Ordinal) || type.StartsWith("attempt.", StringComparison.Ordinal)))
            resources.Add(("dialogs", dialogId, type));
        if (requestId is not null && (type.StartsWith("message.", StringComparison.Ordinal) ||
            type.StartsWith("assistant.", StringComparison.Ordinal) || type.StartsWith("tool.", StringComparison.Ordinal)))
            resources.Add(("history", requestId, type));
        foreach (var (resource, entity, kind) in resources.Distinct())
        {
            var marker = $"{connection.Observation.BootId}:{item.Seq}:{resource}:{entity}";
            var membership = entity is null || resource switch
            {
                "work" => kind is "request.created" or "request.cancelled" or "request.completed" or
                    "request.failed" or "request.interrupted" or "attempt.completed" or "attempt.failed" or
                    "attempt.interrupted" or "attempt.unknown" or "message.accepted",
                "history" => kind is "request.completed" or "request.failed" or "request.cancelled" or
                    "request.interrupted" or "attempt.completed" or "attempt.failed" or "attempt.interrupted" or "attempt.unknown",
                "dialogs" => kind is "dialog.created" or "dialog.deleted" or "dialog.updated",
                _ => false
            };
            var listRevision = membership
                ? await revisions.AdvanceAsync(resource, connection.Id, connection.ConfigEpoch, null, marker, ct)
                : await revisions.ReadAsync(resource, connection.Id, connection.ConfigEpoch, null, ct);
            var revision = entity is null ? listRevision :
                await revisions.AdvanceAsync(resource, connection.Id, connection.ConfigEpoch, entity, marker, ct);
            if (revision is null) continue;
            await publisher.PublishInvalidationAsync(new Invalidation(1, resource, connection.Id,
                connection.Observation.NodeId, connection.ConfigEpoch, entity, null, revision.Value, kind,
                listRevision), ct);
        }
    }
}

public sealed record WorkProjection(string ConnectionId, string NodeId, string NodeName, string RequestId,
    string DialogId, string? Title, string Status, long Version, long QueueSequence,
    DateTimeOffset? ObservedAt, bool AttentionRequired, AttemptProjection? ActiveAttempt);
public sealed record AttemptProjection(string AttemptId, string RequestId, string? DialogId, string State, string EffectStatus,
    long Generation, long Version, string? StartedAt, string? FinishedAt);
public sealed record HistoryProjection(string ConnectionId, string NodeId, string NodeName, string RequestId,
    string DialogId, string Status, string? Title, long DialogVersion, string? CreatedAt, string? CompletedAt,
    IReadOnlyList<AttemptProjection> Attempts, IReadOnlyList<MessageProjection> Messages, string? InputMessageId = null, string? FailureReason = null);
public sealed record MessageProjection(string MessageId, string Role, long Sequence, long Version,
    string CreatedAt, string? Text, JsonElement? Content, string? RequestId, string? AttemptId);
public sealed class ProjectionUnavailableException(string message) : Exception(message);

public static class HarnessProjectionReader
{
    private static readonly HashSet<string> ActiveRequestStates = new(StringComparer.Ordinal)
        { "queued", "dispatching", "active", "unknown" };
    private static readonly HashSet<string> TerminalRequestStates = new(StringComparer.Ordinal)
        { "cancelled", "completed", "failed", "interrupted" };

    public static async Task<IReadOnlyList<WorkProjection>> ReadWorkAsync(
        IReadOnlyList<Connection> connections, IHarnessClient client, CancellationToken ct)
    {
        var result = new List<WorkProjection>();
        foreach (var connection in Eligible(connections))
        {
            var nodeId = connection.Observation.NodeId!;
            var requests = await ReadAllItemsAsync(connection, client,
                ["v1", "nodes", nodeId, "requests"], ct);
            var dialogs = (await ReadAllItemsAsync(connection, client,
                ["v1", "nodes", nodeId, "dialogs"], ct))
                .Where(x => String(x, "dialogId") is not null)
                .ToDictionary(x => String(x, "dialogId")!, StringComparer.Ordinal);
            using var snapshot = await client.GetAsync(connection, ["v1", "nodes", nodeId, "snapshot"], null, ct);
            var active = snapshot is null ? null : ParseAttempt(snapshot.RootElement.TryGetProperty("activeAttempt", out var a) ? a : default);
            foreach (var item in requests)
            {
                var requestId = String(item, "requestId");
                var status = String(item, "status");
                if (requestId is null || status is null || !ActiveRequestStates.Contains(status)) continue;
                var dialogId = String(item, "dialogId") ?? "";
                if (!dialogs.TryGetValue(dialogId, out var dialog))
                    throw new ProjectionUnavailableException("Active request refers to a missing dialog.");
                result.Add(new(connection.Id, nodeId, connection.Name, requestId, dialogId,
                    String(dialog, "title"),
                    status, Long(item, "version"), Long(item, "queueSequence"), connection.Observation.AttemptedAt,
                    status == "unknown",
                    active?.RequestId == requestId ? active : null));
            }
        }
        return result.GroupBy(x => (x.NodeId, x.RequestId)).Select(x => x.First()).ToList();
    }

    public static async Task<IReadOnlyList<HistoryProjection>> ReadHistoryAsync(
        IReadOnlyList<Connection> connections, IHarnessClient client, CancellationToken ct)
    {
        var result = new List<HistoryProjection>();
        foreach (var connection in Eligible(connections))
        {
            var nodeId = connection.Observation.NodeId!;
            var requests = await ReadAllItemsAsync(connection, client,
                ["v1", "nodes", nodeId, "requests"], ct);
            var terminalRequests = requests.GroupBy(x => String(x, "inputMessageId")).Where(group => group.Any(x => TerminalRequestStates.Contains(String(x, "status") ?? ""))).Select(group => group.OrderByDescending(x => Long(x, "queueSequence")).First())
                .Where(x => String(x, "requestId") is not null && String(x, "dialogId") is not null).ToList();
            var dialogs = await ReadAllItemsAsync(connection, client,
                ["v1", "nodes", nodeId, "dialogs"], ct);
            var dialogsById = dialogs.Where(x => String(x, "dialogId") is not null)
                .ToDictionary(x => String(x, "dialogId")!, StringComparer.Ordinal);
            var messagesByDialog = new Dictionary<string, IReadOnlyList<JsonElement>>(StringComparer.Ordinal);
            foreach (var request in terminalRequests)
            {
                var requestId = String(request, "requestId")!;
                var dialogId = String(request, "dialogId")!;
                var inputMessageId = String(request, "inputMessageId")!;
                if (!dialogsById.TryGetValue(dialogId, out var dialog))
                    throw new ProjectionUnavailableException("Terminal request refers to a missing dialog.");
                if (!messagesByDialog.TryGetValue(dialogId, out var allMessages))
                {
                    allMessages = await ReadAllItemsAsync(connection, client,
                        ["v1", "nodes", nodeId, "dialogs", dialogId, "messages"], ct);
                    messagesByDialog[dialogId] = allMessages;
                }
                var attemptItems = new List<JsonElement>();
                foreach (var related in requests.Where(x => String(x, "inputMessageId") == inputMessageId))
                    attemptItems.AddRange(await ReadAllItemsAsync(connection, client,
                        ["v1", "nodes", nodeId, "requests", String(related, "requestId")!, "attempts"], ct));
                if (attemptItems.Any(x => String(x, "dialogId") != dialogId))
                    throw new ProjectionUnavailableException("Request attempt belongs to another dialog.");
                var attempts = attemptItems.Select(ParseAttempt).Where(x => x is not null).Cast<AttemptProjection>().ToList();
                var attemptIds = attempts.Select(x => x.AttemptId).ToHashSet(StringComparer.Ordinal);
                var scopedMessages = allMessages.Where(x => String(x, "messageId") == inputMessageId ||
                    String(x, "requestId") == requestId ||
                    (String(x, "attemptId") is { } attemptId && attemptIds.Contains(attemptId))).ToList();
                var createdAt = scopedMessages.Where(x => String(x, "messageId") == inputMessageId)
                    .Select(x => String(x, "createdAt")).FirstOrDefault(x => x is not null);
                var completedAt = attempts.Where(x => DateTimeOffset.TryParse(x.FinishedAt, out _))
                    .OrderByDescending(x => DateTimeOffset.Parse(x.FinishedAt!)).Select(x => x.FinishedAt).FirstOrDefault();
                result.Add(new(connection.Id, nodeId, connection.Name, requestId, dialogId,
                    String(request, "status")!, String(dialog, "title"), Long(dialog, "version"), createdAt,
                    completedAt, attempts, ParseMessages(scopedMessages), inputMessageId, await ReadFailureReason(connection, client, attempts.Where(x => x.RequestId == requestId).OrderByDescending(x => x.Generation).FirstOrDefault(), ct)));
            }
        }
        return result.GroupBy(x => (x.NodeId, x.RequestId)).Select(x => x.First()).ToList();
    }

    private static async Task<string?> ReadFailureReason(Connection connection, IHarnessClient client, AttemptProjection? attempt, CancellationToken ct)
    {
        if (attempt is null || attempt.State is not ("failed" or "interrupted" or "unknown")) return null;
        if (attempt.EffectStatus != "none") return "Возможны побочные эффекты. Перед повтором требуется сверка состояния.";
        var fallback = attempt.State == "failed" ? "Попытка завершилась ошибкой." : "Выполнение прервано.";
        // Best-effort bounded enrichment; original history remains available when
        // diagnostics cannot be read. The public projector strips provider text.
        const string incomplete = "Диагностика неполная или недоступна. Причина ошибки не подтверждена.";
        try
        {
            long after = 0;
            string? reason = null;
            for (var page = 0; page < 5; page++)
            {
                var query = new Dictionary<string, string?> { ["limit"] = "100", ["after"] = after.ToString(System.Globalization.CultureInfo.InvariantCulture) };
                using var document = await client.GetAsync(connection, ["v1", "nodes", connection.Observation.NodeId!, "attempts", attempt.AttemptId, "events"], query, ct);
                if (document is null) return incomplete;
                var projected = DialogPublicDto.Project(connection.Observation.NodeId!, ["attempts", attempt.AttemptId, "events"], query, document.RootElement, null);
                if (projected is null) return incomplete;
                reason = projected.Value.GetProperty("items").EnumerateArray().Where(item => item.GetProperty("generation").GetInt64() == attempt.Generation)
                    .OrderByDescending(item => item.GetProperty("seq").GetInt64()).Select(item => item.GetProperty("safeMessage").GetString()).FirstOrDefault() ?? reason;
                var cursor = projected.Value.GetProperty("nextCursor");
                if (cursor.ValueKind == JsonValueKind.Null) return reason ?? fallback;
                if (!long.TryParse(cursor.GetString(), out var next) || next <= after) return incomplete;
                after = next;
            }
            return incomplete;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception) { return incomplete; }
    }
    private static IEnumerable<Connection> Eligible(IEnumerable<Connection> connections) => connections.Where(x =>
        x.Observation.Compatibility == "compatible" && Guid.TryParse(x.Observation.NodeId, out _));

    private static async Task<IReadOnlyList<JsonElement>> ReadAllItemsAsync(Connection connection,
        IHarnessClient client, IReadOnlyList<string> path, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try { return await ReadAllItemsAttemptAsync(connection, client, path, ct); }
            catch (StaleProjectionException)
            {
                if (attempt == 2) throw new ProjectionUnavailableException("Harness projection changed during pagination.");
            }
        }
        throw new ProjectionUnavailableException("Harness projection changed during pagination.");
    }

    private static async Task<IReadOnlyList<JsonElement>> ReadAllItemsAttemptAsync(Connection connection,
        IHarnessClient client, IReadOnlyList<string> path, CancellationToken ct)
    {
        var result = new List<JsonElement>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null;
        var expectedPageType = path[^1] switch
        {
            "requests" => "requests",
            "dialogs" => "dialogs",
            "attempts" => "attempts",
            _ => "history"
        };
        for (var page = 0; page < 10_000; page++)
        {
            var response = await client.GetResultAsync(connection, path,
                new Dictionary<string, string?> { ["limit"] = "100", ["cursor"] = cursor }, ct);
            if (response.StatusCode == 409) throw new StaleProjectionException();
            using var document = response.Document;
            if (response.StatusCode != 200 || document is null)
                throw new ProjectionUnavailableException("Harness projection page is unavailable.");
            var root = document.RootElement;
            if (!Integer(root, "protocolVersion", 1) || Long(root, "protocolVersion") != 1 || String(root, "schemaId") != "harness-wire-v2" ||
                String(root, "nodeId") != connection.Observation.NodeId || String(root, "pageType") != expectedPageType ||
                !Integer(root, "epoch", 1) || !Integer(root, "snapshotStateVersion", 0) || !Integer(root, "lastEventSeq", 0) ||
                !root.TryGetProperty("nextCursor", out var nextProperty) ||
                nextProperty.ValueKind is not (JsonValueKind.Null or JsonValueKind.String) ||
                (nextProperty.ValueKind == JsonValueKind.String && string.IsNullOrEmpty(nextProperty.GetString())) ||
                (expectedPageType == "history" && String(root, "dialogId") != path[^2]) ||
                (expectedPageType == "attempts" &&
                    (String(root, "dialogId") is null || String(root, "requestId") != path[^2])) ||
                !root.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
                throw new ProjectionUnavailableException("Harness projection envelope is invalid or belongs to another node.");
            foreach (var item in items.EnumerateArray()) ValidateItem(item, expectedPageType, path);
            result.AddRange(items.EnumerateArray().Select(x => x.Clone()));
            var next = String(root, "nextCursor");
            if (next is null) return result;
            if (!seen.Add(next)) throw new ProjectionUnavailableException("Harness pagination cursor repeated.");
            cursor = next;
        }
        throw new ProjectionUnavailableException("Harness projection exceeded the page limit.");
    }

    private static void ValidateItem(JsonElement item, string pageType, IReadOnlyList<string> path)
    {
        var valid = pageType switch
        {
            "requests" => Uuid(item, "requestId") && Uuid(item, "dialogId") && Uuid(item, "inputMessageId") &&
                          Integer(item, "queueSequence", 1) && Integer(item, "version", 0) &&
                          (String(item, "status") is "queued" or "cancelled" or "dispatching" or "active" or "completed" or "failed" or "interrupted" or "unknown"),
            "dialogs" => Uuid(item, "dialogId") && Integer(item, "version", 0) && Date(item, "createdAt"),
            "history" => Uuid(item, "messageId") && Uuid(item, "dialogId") &&
                         String(item, "dialogId") == path[^2] && Integer(item, "sequence", 1) &&
                         Integer(item, "version", 0) && Date(item, "createdAt") &&
                         (String(item, "role") is "user" or "assistant" or "system" or "tool"),
            "attempts" => Uuid(item, "attemptId") && Uuid(item, "dialogId") &&
                          Uuid(item, "requestId") && String(item, "requestId") == path[^2] &&
                          Integer(item, "generation", 1) && Integer(item, "version", 0) &&
                          (String(item, "state") is "dispatching" or "running" or "waiting_input" or
                           "stopping" or "completed" or "failed" or "interrupted" or "unknown") &&
                          (String(item, "effectStatus") is "none" or "known" or "unknown"),
            _ => false
        };
        if (!valid) throw new ProjectionUnavailableException("Harness projection item is invalid.");
    }

    private static bool Uuid(JsonElement item, string name) => String(item, name) is { } value &&
        Guid.TryParse(value, out var parsed) && string.Equals(value, parsed.ToString("D"), StringComparison.Ordinal);
    private static bool Date(JsonElement item, string name) => DateTimeOffset.TryParse(String(item, name), out _);
    private static bool Integer(JsonElement item, string name, long minimum) =>
        item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var value) &&
        value.TryGetInt64(out var parsed) && parsed >= minimum;

    private static IReadOnlyList<MessageProjection> ParseMessages(IReadOnlyList<JsonElement> items)
    {
        var result = new List<MessageProjection>();
        foreach (var item in items)
        {
            var id = String(item, "messageId");
            if (id is null) continue;
            JsonElement? content = item.TryGetProperty("content", out var value) ? value.Clone() : null;
            result.Add(new(id, String(item, "role") ?? "unknown", Long(item, "sequence"), Long(item, "version"),
                String(item, "createdAt") ?? "", String(item, "text"), content, String(item, "requestId"), String(item, "attemptId")));
        }
        return result;
    }

    private static AttemptProjection? ParseAttempt(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || String(item, "attemptId") is not { } id) return null;
        return new(id, String(item, "requestId") ?? "", String(item, "dialogId"), String(item, "state") ?? "unknown",
            String(item, "effectStatus") ?? "unknown", Long(item, "generation"), Long(item, "version"),
            String(item, "startedAt"), String(item, "finishedAt"));
    }
    private static string? String(JsonElement item, string name) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    private static long Long(JsonElement item, string name) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var p) && p.TryGetInt64(out var value) ? value : 0;
    private sealed class StaleProjectionException : Exception { }
}
