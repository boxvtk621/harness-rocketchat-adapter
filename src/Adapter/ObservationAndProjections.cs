using System.Text.Json;

public sealed class HarnessObservationService(
    IConnectionRepository connections,
    IHarnessClient client,
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
            if (!await connections.UpdateObservationAsync(connection.Id, epoch, result.Observation, ct))
            {
                logger.LogInformation("Discarded stale observation for connection {ConnectionId} epoch {ConfigEpoch}", connection.Id, epoch);
                continue;
            }
            await publisher.PublishInvalidationAsync("nodes", connection.Id, "observed", ct);
            await publisher.PublishInvalidationAsync("work", connection.Id, "refetch", ct);
            await publisher.PublishInvalidationAsync("history", connection.Id, "refetch", ct);
        }
    }
}

public sealed class HarnessEventInvalidationService(
    IConnectionRepository connections,
    IHarnessClient client,
    ICentrifugoPublisher publisher,
    ILogger<HarnessEventInvalidationService> logger) : BackgroundService
{
    private sealed record Worker(long Epoch, string NodeId, CancellationTokenSource Stop, Task Task);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var workers = new Dictionary<string, Worker>(StringComparer.Ordinal);
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            do
            {
                var current = (await connections.ListAsync(stoppingToken))
                    .Where(x => x.Observation.Compatibility == "compatible" &&
                                Guid.TryParse(x.Observation.NodeId, out _))
                    .ToDictionary(x => x.Id, StringComparer.Ordinal);
                foreach (var item in workers.ToArray())
                {
                    if (!current.TryGetValue(item.Key, out var connection) ||
                        connection.ConfigEpoch != item.Value.Epoch ||
                        connection.Observation.NodeId != item.Value.NodeId || item.Value.Task.IsCompleted)
                    {
                        item.Value.Stop.Cancel();
                        workers.Remove(item.Key);
                    }
                }
                foreach (var connection in current.Values)
                {
                    if (workers.ContainsKey(connection.Id)) continue;
                    var stop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    var task = RunAsync(connection, stop.Token);
                    workers[connection.Id] = new(connection.ConfigEpoch, connection.Observation.NodeId!, stop, task);
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
                {
                    using var snapshot = await client.GetAsync(connection,
                        ["v1", "nodes", connection.Observation.NodeId!, "snapshot"], null, ct);
                    if (snapshot is null || !snapshot.RootElement.TryGetProperty("lastEventSeq", out var last) ||
                        !last.TryGetInt64(out var current) || current < 0)
                        throw new InvalidDataException("Harness event cursor snapshot is unavailable.");
                    after = current;
                    await publisher.PublishInvalidationAsync("work", connection.Id, "event-stream-start", ct);
                    await publisher.PublishInvalidationAsync("history", connection.Id, "event-stream-start", ct);
                }
                await foreach (var sequence in client.WatchEventsAsync(connection, after.Value, ct))
                {
                    after = sequence;
                    await publisher.PublishInvalidationAsync("work", connection.Id, "event", ct);
                    await publisher.PublishInvalidationAsync("history", connection.Id, "event", ct);
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
}

public sealed record WorkProjection(string ConnectionId, string NodeId, string RequestId, string DialogId,
    string Status, long Version, long QueueSequence, AttemptProjection? ActiveAttempt);
public sealed record AttemptProjection(string AttemptId, string RequestId, string State, string EffectStatus,
    long Generation, long Version, string? StartedAt, string? FinishedAt);
public sealed record HistoryProjection(string ConnectionId, string NodeId, string DialogId, string? Title,
    long DialogVersion, string CreatedAt, IReadOnlyList<MessageProjection> Messages);
public sealed record MessageProjection(string MessageId, string Role, long Sequence, long Version,
    string CreatedAt, string? Text, JsonElement? Content, string? RequestId, string? AttemptId);
public sealed class ProjectionUnavailableException(string message) : Exception(message);

public static class HarnessProjectionReader
{
    private static readonly HashSet<string> ActiveRequestStates = new(StringComparer.Ordinal)
        { "queued", "dispatching", "active" };
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
            using var snapshot = await client.GetAsync(connection, ["v1", "nodes", nodeId, "snapshot"], null, ct);
            var active = snapshot is null ? null : ParseAttempt(snapshot.RootElement.TryGetProperty("activeAttempt", out var a) ? a : default);
            foreach (var item in requests)
            {
                var requestId = String(item, "requestId");
                var status = String(item, "status");
                if (requestId is null || status is null || !ActiveRequestStates.Contains(status)) continue;
                result.Add(new(connection.Id, nodeId, requestId, String(item, "dialogId") ?? "",
                    status, Long(item, "version"), Long(item, "queueSequence"),
                    active?.RequestId == requestId ? active : null));
            }
        }
        return result;
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
            var completedDialogs = requests.Where(x => TerminalRequestStates.Contains(String(x, "status") ?? ""))
                .Select(x => String(x, "dialogId")).Where(x => x is not null).ToHashSet(StringComparer.Ordinal);
            var dialogs = await ReadAllItemsAsync(connection, client,
                ["v1", "nodes", nodeId, "dialogs"], ct);
            foreach (var dialog in dialogs)
            {
                var dialogId = String(dialog, "dialogId");
                if (dialogId is null || !completedDialogs.Contains(dialogId)) continue;
                var messages = await ReadAllItemsAsync(connection, client,
                    ["v1", "nodes", nodeId, "dialogs", dialogId, "messages"], ct);
                result.Add(new(connection.Id, nodeId, dialogId, String(dialog, "title"), Long(dialog, "version"),
                    String(dialog, "createdAt") ?? "", ParseMessages(messages)));
            }
        }
        return result;
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
        var expectedPageType = path[^1] == "requests" ? "requests" : path[^1] == "dialogs" ? "dialogs" : "history";
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
            _ => false
        };
        if (!valid) throw new ProjectionUnavailableException("Harness projection item is invalid.");
    }

    private static bool Uuid(JsonElement item, string name) => Guid.TryParse(String(item, name), out _);
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
        return new(id, String(item, "requestId") ?? "", String(item, "state") ?? "unknown",
            String(item, "effectStatus") ?? "unknown", Long(item, "generation"), Long(item, "version"),
            String(item, "startedAt"), String(item, "finishedAt"));
    }
    private static string? String(JsonElement item, string name) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
    private static long Long(JsonElement item, string name) => item.ValueKind == JsonValueKind.Object && item.TryGetProperty(name, out var p) && p.TryGetInt64(out var value) ? value : 0;
    private sealed class StaleProjectionException : Exception { }
}
