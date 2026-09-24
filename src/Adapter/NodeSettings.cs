using System.Net.Http.Headers;
using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;

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
                var safeSecretAction = normalized == "secretaction" && property.Value.ValueKind == JsonValueKind.String &&
                    property.Value.GetString() is "keep" or "replace" or "remove";
                if (!safeConfiguredFlag && !safeSecretAction && (normalized.Contains("secret", StringComparison.Ordinal) ||
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
        foreach (var action in new[] { "mcp-checks", "mcp-validate", "apply" })
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
        if (result.Payload is { } value && value.ValueKind == JsonValueKind.Object)
        {
            var revisions = context.RequestServices.GetRequiredService<IResourceRevisions>();
            var operation = value.TryGetProperty("operation", out var op) && op.ValueKind == JsonValueKind.Object ? op : default;
            var operationId = operation.ValueKind == JsonValueKind.Object && operation.TryGetProperty("operationId", out var opId)
                ? opId.GetString() : null;
            if (!HttpMethods.IsGet(context.Request.Method) && suffix.FirstOrDefault() is not ("mcp-validate" or "model-catalog") && result.Status is >= 200 and < 300)
            {
                var draft = value.TryGetProperty("draftRevision", out var draftValue) && draftValue.TryGetInt64(out var d) ? d : 0;
                var applied = value.TryGetProperty("appliedRevision", out var appliedValue) && appliedValue.TryGetInt64(out var a) ? a : 0;
                var status = operation.ValueKind == JsonValueKind.Object && operation.TryGetProperty("status", out var statusValue)
                    ? statusValue.GetString() : null;
                var phase = operation.ValueKind == JsonValueKind.Object && operation.TryGetProperty("phase", out var phaseValue)
                    ? phaseValue.GetString() : null;
                var observations = value.TryGetProperty("observations", out var observed) && observed.ValueKind == JsonValueKind.Array
                    ? string.Join(';', observed.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.Object).Select(x => string.Join(':',
                        x.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : "",
                        x.TryGetProperty("state", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : "",
                        x.TryGetProperty("reasonCode", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() : ""))) : "";
                var observationDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(observations)));
                var marker = $"{draft}:{applied}:{operationId}:{status}:{phase}:{observationDigest}";
                var revision = await revisions.AdvanceAsync("node_settings", id, epoch, nodeId, marker, ct);
                if (revision is not null)
                    await publisher.PublishInvalidationAsync(new Invalidation(1, "node_settings", id, nodeId,
                        epoch, nodeId, operationId, revision.Value, "changed"), ct);
                if (suffix.FirstOrDefault() == "apply" && status == "pending" && ProviderAuthClient.ExactId(operationId))
                    await context.RequestServices.GetRequiredService<IOperationWatches>()
                        .RegisterAsync("node_settings", current, nodeId, operationId!, ct);
            }
            var resourceRevision = await revisions.ReadAsync("node_settings", id, epoch, nodeId, ct);
            var enriched = JsonNode.Parse(value.GetRawText())!.AsObject();
            enriched["resourceRevision"] = resourceRevision;
            enriched["lastObservedAt"] = current.Observation.AttemptedAt?.ToString("O");
            enriched["syncedAt"] = DateTimeOffset.UtcNow.ToString("O");
            if (ProviderAuthClient.ExactId(operationId))
                enriched["operationObservationStatus"] = await context.RequestServices.GetRequiredService<IOperationWatches>()
                    .StatusAsync("node_settings", id, epoch, operationId!, ct);
            return Results.Json(enriched, statusCode: result.Status);
        }
        return result.Payload is { } payload ? Results.Json(payload, statusCode: result.Status)
            : Results.Json(new { code = result.Code }, statusCode: result.Status);
    }
}
