using System.Globalization;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;

public sealed record DialogRelayReply(int StatusCode, JsonElement? Body);
public sealed record DialogIdentityFence(string NodeId, long RegistryVersion, long IdentityEpoch, string AdapterKind, string AdapterVersion)
{
    public static readonly string[] Headers = ["X-Harness-Expected-Node-ID", "X-Harness-Expected-Registry-Version",
        "X-Harness-Expected-Identity-Epoch", "X-Harness-Expected-Adapter-Kind", "X-Harness-Expected-Adapter-Version"];
    public string[] Values => [NodeId, RegistryVersion.ToString(CultureInfo.InvariantCulture), IdentityEpoch.ToString(CultureInfo.InvariantCulture), AdapterKind, AdapterVersion];
}

public interface IDialogHarnessClient
{
    Task<DialogRelayReply> SendAsync(Connection connection, string nodeId, string[] path,
        IReadOnlyDictionary<string, string?> query, JsonElement? command, CancellationToken ct, DialogIdentityFence? fence = null);
}

// Public, bounded DTOs only. No retries: a transport failure is an unknown command outcome.
public sealed class DialogHarnessClient(HttpClient http, HarnessAddressPolicy addresses) : IDialogHarnessClient
{
    public async Task<DialogRelayReply> SendAsync(Connection connection, string nodeId, string[] path,
        IReadOnlyDictionary<string, string?> query, JsonElement? command, CancellationToken ct, DialogIdentityFence? fence = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(connection.Settings.TimeoutSeconds));
        try
        {
            var uri = HarnessUri.Build(connection.BaseUri, ["v1", "nodes", nodeId, .. path], query);
            if (!addresses.IsAllowed(uri)) return new(502, null);
            using var request = new HttpRequestMessage(command is null ? HttpMethod.Get : HttpMethod.Post, uri);
            if (command is { } payload)
            {
                if (fence is null || fence.NodeId != nodeId) return new(400, null);
                request.Content = JsonContent.Create(payload);
                for (var index = 0; index < DialogIdentityFence.Headers.Length; index++)
                    request.Headers.Add(DialogIdentityFence.Headers[index], fence.Values[index]);
            }
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400) return new(502, null);
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            await using var buffer = new MemoryStream();
            var bytes = new byte[16384];
            int read;
            while ((read = await stream.ReadAsync(bytes, timeout.Token)) != 0)
            {
                if (buffer.Length + read > 8 * 1024 * 1024) return new(502, null);
                await buffer.WriteAsync(bytes.AsMemory(0, read), timeout.Token);
            }
            if (buffer.Length == 0) return new(status, null);
            buffer.Position = 0;
            using var document = await JsonDocument.ParseAsync(buffer, cancellationToken: timeout.Token);
            var root = document.RootElement;
            if (response.IsSuccessStatusCode && (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("nodeId", out var actual) || actual.ValueKind != JsonValueKind.String || actual.GetString() != nodeId))
                return new(502, null);
            return new(status, root.Clone());
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new(504, null); }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidDataException) { return new(502, null); }
    }
}

public static class DialogEndpoints
{
    public static void AddDialogServices(this IServiceCollection services)
    {
        services.AddHttpClient<IDialogHarnessClient, DialogHarnessClient>(http =>
        {
            http.Timeout = Timeout.InfiniteTimeSpan;
            http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }).ConfigurePrimaryHttpMessageHandler(sp => HarnessTls.CreateHandler(sp.GetRequiredService<IOptions<HarnessOptions>>()));
    }

    public static void MapDialogs(this WebApplication app)
    {
        var group = app.MapGroup("/api/dialogs/{connectionId}/nodes/{nodeId}").RequireInternalToken();
        group.MapGet("/{**path}", Relay);
        group.MapPost("/commands", (HttpContext context, string connectionId, string nodeId,
            IConnectionRepository store, IDialogHarnessClient client, ICentrifugoPublisher publisher,
            CancellationToken ct) => Relay(context, connectionId, nodeId, "commands", store, client, publisher, ct));
    }

    private static async Task<IResult> Relay(HttpContext context, string connectionId, string nodeId, string? path,
        IConnectionRepository store, IDialogHarnessClient client, ICentrifugoPublisher publisher, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        var parts = (path ?? "").Split('/');
        var writing = HttpMethods.IsPost(context.Request.Method);
        if (!Guid.TryParseExact(nodeId, "D", out _) || !AllowedPath(parts, writing)) return Error(404, "route_not_found");
        if (!long.TryParse(context.Request.Query["configEpoch"], NumberStyles.None, CultureInfo.InvariantCulture, out var epoch))
            return Error(400, "config_epoch_required");
        var connection = await store.GetAsync(connectionId, ct);
        if (connection is null) return Error(404, "connection_not_found");
        if (connection.ConfigEpoch != epoch || connection.Observation.NodeId != nodeId)
            return Error(409, "target_changed");
        if (connection.Observation.Compatibility != "compatible") return Error(409, "incompatible_node");
        var identities = ConnectionIdentity.Analyze(await store.ListAsync(ct));
        if (!identities.TryGetValue(connectionId, out var identity) || identity.Status != ConnectionIdentity.Unique)
            return Error(409, "node_id_conflict");

        var query = new Dictionary<string, string?>();
        foreach (var entry in context.Request.Query)
        {
            if (entry.Key == "configEpoch") continue;
            if (entry.Value.Count != 1 || entry.Value.ToString().Length > 4096 ||
                entry.Key is not ("cursor" or "limit" or "dialogId" or "requestId" or "order" or "after" or "view"))
                return Error(400, "invalid_query");
            if (entry.Key == "limit" && (!int.TryParse(entry.Value, out var limit) || limit is < 1 or > 100))
                return Error(400, "invalid_limit");
            if (entry.Key == "after" && (!long.TryParse(entry.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var after) || after is < 0 or > 9007199254740991))
                return Error(400, "invalid_cursor");
            query[entry.Key] = entry.Value.ToString();
        }
        JsonElement? command = null;
        DialogIdentityFence? fence = null;
        if (writing)
        {
            var headers = DialogIdentityFence.Headers.Select(name => context.Request.Headers[name]).ToArray();
            if (headers.Any(value => value.Count != 1 || value.ToString().Length is < 1 or > 200 || value.ToString().Trim() != value.ToString()) ||
                headers[0].ToString() != nodeId ||
                !long.TryParse(headers[1], NumberStyles.None, CultureInfo.InvariantCulture, out var registryVersion) || registryVersion is < 1 or > 9007199254740991 ||
                !long.TryParse(headers[2], NumberStyles.None, CultureInfo.InvariantCulture, out var identityEpoch) || identityEpoch is < 1 or > 9007199254740991)
                return Error(400, "identity_fence_required");
            fence = new(nodeId, registryVersion, identityEpoch, headers[3].ToString(), headers[4].ToString());
            // Bound even chunked input, before parsing or forwarding any command.
            await using var buffer = new MemoryStream();
            var bytes = new byte[8192];
            int read;
            while ((read = await context.Request.Body.ReadAsync(bytes, ct)) != 0)
            {
                if (buffer.Length + read > 65536) return Error(413, "command_too_large");
                await buffer.WriteAsync(bytes.AsMemory(0, read), ct);
            }
            try
            {
                using var document = JsonDocument.Parse(buffer.ToArray());
                command = document.RootElement.Clone();
                if (!ValidCommand(command.Value, nodeId)) return Error(400, "invalid_command");
            }
            catch (JsonException) { return Error(400, "invalid_command"); }
        }
        if (writing && ObservationResponse.From(connection).Ready != true)
        {
            // Readback permits an exact replay of an already admitted command even after readiness changes.
            // The Harness still checks its persisted payload hash; Adapter never invents acceptance.
            var commandId = command!.Value.GetProperty("commandId").GetString()!;
            var prior = await client.SendAsync(connection, nodeId, ["commands", commandId], new Dictionary<string, string?>(), null, ct);
            if (prior.StatusCode != 200) return Error(prior.StatusCode == 404 ? 503 : 504,
                prior.StatusCode == 404 ? "node_not_ready" : "command_outcome_unknown");
        }
        var upstream = parts is ["dialogs", _, "history"] ? new[] { "dialogs", parts[1], "messages" } : parts;
        var upstreamQuery = new Dictionary<string, string?>(query);
        if (parts is ["attempts"])
        {
            if (!query.TryGetValue("requestId", out var requestId) || !Guid.TryParseExact(requestId, "D", out _))
                return Error(400, "request_id_required");
            upstream = ["requests", requestId!, "attempts"];
            upstreamQuery.Remove("requestId");
        }
        var reply = await client.SendAsync(connection, nodeId, upstream, upstreamQuery, command, ct, fence);
        // Do not forward a late read from an endpoint that has since been reconfigured.
        var current = await store.GetAsync(connectionId, ct);
        if (current?.ConfigEpoch != epoch || current.Observation.NodeId != nodeId)
            return Error(409, writing ? "command_outcome_unknown" : "target_changed");
        if (reply.StatusCode is >= 200 and < 300 && reply.Body is { } body)
        {
            var projected = DialogPublicDto.Project(nodeId, parts, query, body, command);
            if (projected is null) return Error(502, writing ? "command_outcome_unknown" : "invalid_public_dto");
            if (writing) await publisher.PublishInvalidationAsync("dialogs", connectionId, "refetch", ct);
            return Results.Json(projected.Value, statusCode: reply.StatusCode);
        }
        var code = reply.StatusCode switch
        {
            400 or 422 => "invalid_command", 404 => "not_found", 409 => "conflict", 413 => "command_too_large", 429 => "capacity_exhausted",
            503 => "node_not_ready", _ => writing ? "command_outcome_unknown" : "read_unavailable"
        };
        // Harness error details may describe provider internals. Only expose documented codes.
        if (reply.Body is { ValueKind: JsonValueKind.Object } error && error.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String &&
            value.GetString() is "id_conflict" or "version_conflict" or "cursor_stale" or "stale_cursor" or "node_not_ready") code = value.GetString()!;
        return Error(reply.StatusCode is >= 400 and <= 599 ? reply.StatusCode : 502, code);
    }

    public static bool AllowedPath(string[] p, bool writing)
    {
        if (writing) return p is ["commands"];
        return p is ["identity"] or ["snapshot"] or ["dialogs"] or ["requests"] or ["attempts"] ||
            (p.Length >= 2 && Guid.TryParseExact(p[1], "D", out _) &&
             (p is ["dialogs", _] or ["dialogs", _, "history"] or ["requests", _] or ["attempts", _] or ["commands", _] or
                   ["attempts", _, "tool-calls"] or ["attempts", _, "events"] ||
              p is ["attempts", _, "tool-calls", _] && Guid.TryParseExact(p[3], "D", out _)));
    }

    public static bool ValidCommand(JsonElement c, string nodeId)
    {
        if (c.ValueKind != JsonValueKind.Object || !c.TryGetProperty("commandId", out var id) || id.ValueKind != JsonValueKind.String ||
            !Guid.TryParseExact(id.GetString(), "D", out _) || !c.TryGetProperty("kind", out var kind) || kind.ValueKind != JsonValueKind.String ||
            kind.GetString() is not ("dialog.create" or "message.enqueue" or "attempt.retry") || !c.TryGetProperty("target", out var target) ||
            target.ValueKind != JsonValueKind.Object || !target.TryGetProperty("nodeId", out var node) || node.ValueKind != JsonValueKind.String || node.GetString() != nodeId ||
            !c.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) return false;
        if (kind.GetString() == "attempt.retry")
            return Exact(c, "protocolVersion", "schemaId", "commandId", "kind", "target", "expected", "payload") &&
                c.GetProperty("protocolVersion").ValueKind == JsonValueKind.Number && c.GetProperty("protocolVersion").TryGetInt32(out var protocol) && protocol == 1 &&
                c.GetProperty("schemaId").ValueKind == JsonValueKind.String && c.GetProperty("schemaId").GetString() == "harness-wire-v2" &&
                Exact(target, "nodeId", "attemptId") && target.GetProperty("attemptId").ValueKind == JsonValueKind.String && Guid.TryParseExact(target.GetProperty("attemptId").GetString(), "D", out _) &&
                Exact(c.GetProperty("expected"), "attemptGeneration") && c.GetProperty("expected").GetProperty("attemptGeneration").ValueKind == JsonValueKind.Number && c.GetProperty("expected").GetProperty("attemptGeneration").TryGetInt64(out var generation) && generation is > 0 and <= 9007199254740991 &&
                Exact(payload, "acknowledgeKnownEffects") && payload.GetProperty("acknowledgeKnownEffects").ValueKind == JsonValueKind.False;
        var name = kind.GetString() == "dialog.create" ? "title" : "text";
        if (name == "title" && !payload.TryGetProperty("title", out _)) return true;
        return payload.TryGetProperty(name, out var text) && text.ValueKind == JsonValueKind.String &&
            !string.IsNullOrWhiteSpace(text.GetString()) && text.GetString()!.Length <= (name == "title" ? 200 : 16000);
    }

    private static bool Exact(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object &&
        value.EnumerateObject().Count() == names.Length && names.All(name => value.TryGetProperty(name, out _));

    private static IResult Error(int status, string code) => Results.Json(new { code }, statusCode: status);
}
