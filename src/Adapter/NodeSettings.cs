using System.Net.Http.Headers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;

public sealed record NodeSettingsResult(int Status, JsonElement? Payload = null, string? Code = null);

public interface INodeSettingsClient
{
    Task<NodeSettingsResult> SendAsync(Connection connection, string nodeId, HttpMethod method,
        IReadOnlyList<string> suffix, IReadOnlyDictionary<string, string?> query, byte[]? body, CancellationToken ct);
}

/// <summary>Provider-neutral transport for the Harness-owned node settings contract.</summary>
public sealed class NodeSettingsClient(HttpClient http, HarnessAddressPolicy addresses) : INodeSettingsClient
{
    private const int MaxResponseBytes = 1024 * 1024;

    public async Task<NodeSettingsResult> SendAsync(Connection connection, string nodeId, HttpMethod method,
        IReadOnlyList<string> suffix, IReadOnlyDictionary<string, string?> query, byte[]? body, CancellationToken ct)
    {
        var uri = HarnessUri.Build(connection.BaseUri, ["v1", "nodes", nodeId, "settings", .. suffix], query);
        if (!addresses.IsAllowed(uri)) return new(502, Code: "unreachable");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(connection.Settings.TimeoutSeconds, 1, 120)));
        using var request = new HttpRequestMessage(method, uri);
        if (body is not null)
            request.Content = new ByteArrayContent(body) { Headers = { ContentType = new MediaTypeHeaderValue("application/json") } };
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if ((int)response.StatusCode is >= 300 and < 400) return new(502, Code: "redirect_rejected");
            if (response.Content.Headers.ContentLength > MaxResponseBytes) return new(502, Code: "invalid_response");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int length;
            while ((length = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                if (buffer.Length + length > MaxResponseBytes) return new(502, Code: "invalid_response");
                buffer.Write(chunk, 0, length);
            }
            using var document = JsonDocument.Parse(buffer.ToArray());
            if (ContainsSensitiveValue(document.RootElement)) return new(502, Code: "invalid_response");
            var status = (int)response.StatusCode;
            if (status is < 200 or >= 300)
                status = status is 400 or 404 or 409 or 412 or 413 or 422 or 503 ? status : 502;
            return new(status, document.RootElement.Clone());
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException)
        {
            return new(503, Code: error is OperationCanceledException ? "timeout" : "node_settings_unavailable");
        }
    }

    private static bool ContainsSensitiveValue(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var property in value.EnumerateObject())
            {
                var normalized = new string(property.Name.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
                var safeConfiguredFlag = property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False &&
                    normalized is "bearertokenconfigured" or "tokenconfigured" or "secretconfigured" or
                        "passwordconfigured" or "credentialconfigured" or "credentialsconfigured" or "apikeyconfigured";
                if (!safeConfiguredFlag && (normalized.Contains("secret", StringComparison.Ordinal) ||
                    normalized.Contains("password", StringComparison.Ordinal) ||
                    normalized.Contains("credential", StringComparison.Ordinal) ||
                    normalized.Contains("authorization", StringComparison.Ordinal) ||
                    normalized.Contains("token", StringComparison.Ordinal) ||
                    normalized.Contains("apikey", StringComparison.Ordinal) ||
                    normalized.Contains("privatekey", StringComparison.Ordinal))) return true;
                if (ContainsSensitiveValue(property.Value)) return true;
            }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) if (ContainsSensitiveValue(item)) return true;
        return false;
    }
}

/// <summary>Orders connection identity changes with settings requests without serializing unrelated nodes.</summary>
public sealed class ConnectionDispatchFence
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);
    public async ValueTask<IAsyncDisposable> EnterAsync(string connectionId, CancellationToken ct)
    {
        var gate = _locks.GetOrAdd(connectionId, static _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        return new Lease(gate);
    }
    private sealed class Lease(SemaphoreSlim gate) : IAsyncDisposable
    {
        private int _disposed;
        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) gate.Release();
            return ValueTask.CompletedTask;
        }
    }
}

public static class NodeSettingsEndpoints
{
    private const int MaxRequestBytes = 256 * 1024;

    public static void MapNodeSettings(this RouteGroupBuilder connections)
    {
        connections.MapMethods("/{id}/node-settings", ["GET", "PUT"],
            (string id, HttpContext context, IConnectionRepository store, INodeSettingsClient client,
                ICentrifugoPublisher publisher, ConnectionDispatchFence fence, CancellationToken ct) =>
                Dispatch(id, [], context, store, client, publisher, fence, ct));
        connections.MapMethods("/{id}/node-settings/model-catalog", ["GET", "POST"],
            (string id, HttpContext context, IConnectionRepository store, INodeSettingsClient client,
                ICentrifugoPublisher publisher, ConnectionDispatchFence fence, CancellationToken ct) =>
                Dispatch(id, ["model-catalog"], context, store, client, publisher, fence, ct));
        foreach (var action in new[] { "mcp-checks", "apply" })
            connections.MapPost("/{id}/node-settings/" + action,
                (string id, HttpContext context, IConnectionRepository store, INodeSettingsClient client,
                    ICentrifugoPublisher publisher, ConnectionDispatchFence fence, CancellationToken ct) =>
                    Dispatch(id, [action], context, store, client, publisher, fence, ct));
        connections.MapGet("/{id}/node-settings/operations/{operationId}",
            (string id, string operationId, HttpContext context, IConnectionRepository store,
                INodeSettingsClient client, ICentrifugoPublisher publisher, ConnectionDispatchFence fence, CancellationToken ct) =>
                Guid.TryParseExact(operationId, "D", out _)
                    ? Dispatch(id, ["operations", operationId], context, store, client, publisher, fence, ct)
                    : Task.FromResult<IResult>(Results.BadRequest(new { code = "invalid_request" })));
    }

    private static async Task<IResult> Dispatch(string id, IReadOnlyList<string> suffix, HttpContext context,
        IConnectionRepository store, INodeSettingsClient client, ICentrifugoPublisher publisher,
        ConnectionDispatchFence fence, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
        var nodeId = context.Request.Query["nodeId"].ToString();
        if (!Guid.TryParseExact(nodeId, "D", out var parsedNode) || parsedNode.ToString("D") != nodeId ||
            !long.TryParse(context.Request.Query["configEpoch"], out var epoch) || epoch < 0)
            return Results.BadRequest(new { code = "invalid_request" });
        await using var dispatchLease = await fence.EnterAsync(id, ct);
        var connection = await store.GetAsync(id, ct);
        if (connection is null) return Results.NotFound(new { code = "not_found" });
        if (connection.ConfigEpoch != epoch || connection.Observation.NodeId != nodeId || connection.Observation.Compatibility != "compatible")
            return Results.Conflict(new { code = "connection_changed" });
        var identities = ConnectionIdentity.Analyze(await store.ListAsync(ct));
        if (!identities.TryGetValue(id, out var identity) || identity.Status != ConnectionIdentity.Unique)
            return Results.Conflict(new { code = "node_id_conflict" });

        byte[]? body = null;
        if (!HttpMethods.IsGet(context.Request.Method))
        {
            if (context.Request.ContentType is null ||
                !context.Request.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase))
                return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int length;
            while ((length = await context.Request.Body.ReadAsync(chunk, ct)) > 0)
            {
                if (buffer.Length + length > MaxRequestBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                buffer.Write(chunk, 0, length);
            }
            body = buffer.ToArray();
            try { using var _ = JsonDocument.Parse(body); }
            catch (JsonException) { return Results.BadRequest(new { code = "invalid_request" }); }
        }
        var allowedQuery = suffix.Count == 1 && suffix[0] == "model-catalog"
            ? new HashSet<string>(["cursor", "limit"], StringComparer.Ordinal)
            : [];
        if (context.Request.Query.Keys.Any(key => key is not ("nodeId" or "configEpoch") && !allowedQuery.Contains(key)))
            return Results.BadRequest(new { code = "invalid_request" });
        var query = context.Request.Query
            .Where(item => allowedQuery.Contains(item.Key))
            .ToDictionary(item => item.Key, item => (string?)item.Value.ToString(), StringComparer.Ordinal);
        var result = await client.SendAsync(connection, nodeId, new HttpMethod(context.Request.Method), suffix, query, body, ct);
        var current = await store.GetAsync(id, ct);
        if (current?.ConfigEpoch != epoch || current.Observation.NodeId != nodeId || current.Observation.Compatibility != "compatible")
            return Results.Conflict(new { code = "connection_changed" });
        var currentIdentities = ConnectionIdentity.Analyze(await store.ListAsync(ct));
        if (!currentIdentities.TryGetValue(id, out var currentIdentity) || currentIdentity.Status != ConnectionIdentity.Unique)
            return Results.Conflict(new { code = "node_id_conflict" });
        if (!HttpMethods.IsGet(context.Request.Method) && result.Status is >= 200 and < 300)
            await publisher.PublishInvalidationAsync("nodes", id, "node_settings", ct);
        return result.Payload is { } payload ? Results.Json(payload, statusCode: result.Status)
            : Results.Json(new { code = result.Code }, statusCode: result.Status);
    }
}
