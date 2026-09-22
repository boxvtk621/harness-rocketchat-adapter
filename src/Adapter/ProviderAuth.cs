using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

// This input is deliberately a class: generated record ToString must never print Secret.
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed class ProviderAuthCommand
{
    public string? NodeId { get; init; }
    public string? CommandId { get; init; }
    public string? Method { get; init; }
    public string? Secret { get; init; }
}

public sealed record ProviderAuthCapabilities(string[] Methods, bool CanCheck, bool CanLogout);
public sealed record ProviderAuthOperation(string OperationId, string CommandId, string Method, string Status,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, string? ReasonCode,
    string? VerificationUrl, string? UserCode, DateTimeOffset? ExpiresAt, DateTimeOffset? TimeoutAt);
public sealed record ProviderAuthSnapshot(string SchemaId, string NodeId, long Revision, string State,
    DateTimeOffset? CheckedAt, string? ReasonCode, ProviderAuthCapabilities Capabilities, ProviderAuthOperation? Operation);
public sealed record ProviderAuthResult(int Status, ProviderAuthSnapshot? Snapshot = null, string? Code = null);

public interface IProviderAuthClient
{
    Task<ProviderAuthResult> SendAsync(Connection connection, string nodeId, string action,
        string? operationId, ProviderAuthCommand? input, CancellationToken ct);
}

public sealed class ProviderAuthClient(HttpClient http, HarnessAddressPolicy addresses) : IProviderAuthClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> Reasons = new(StringComparer.Ordinal)
    {
        "pending_operation", "busy", "id_conflict", "unsupported_method", "provider_unavailable",
        "unauthenticated", "invalid_secret", "login_failed", "cancelled", "expired", "timeout", "restarted",
        "unsupported", "unsupported_version", "invalid_request", "not_found", "node_mismatch",
        "verification_failed", "reauthentication_required", "storage_error", "provider_error", "check_failed",
        "credential_rejected", "interrupted_by_restart", "managed_auth_required", "provider_operation_missing", "provider_protocol_error"
    };

    public static bool ExactId(string? value) => Guid.TryParseExact(value, "D", out var parsed) && parsed.ToString("D") == value;
    private static string? SafeReason(string? reason) => reason is null ? null : Reasons.Contains(reason) ? reason : "provider_error";

    public async Task<ProviderAuthResult> SendAsync(Connection connection, string nodeId, string action,
        string? operationId, ProviderAuthCommand? input, CancellationToken ct)
    {
        var path = new List<string> { "v1", "provider-auth" };
        if (operationId is not null) { path.Add("operations"); path.Add(operationId); }
        if (action.Length > 0) path.Add(action);
        var uri = HarnessUri.Build(connection.BaseUri, path,
            input is null ? new Dictionary<string, string?> { ["nodeId"] = nodeId } : null);
        if (!addresses.IsAllowed(uri)) return new(502, Code: "unreachable");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(connection.Settings.TimeoutSeconds, 1, 120)));
        using var request = new HttpRequestMessage(input is null ? HttpMethod.Get : HttpMethod.Post, uri);
        if (input is not null) request.Content = JsonContent.Create(input, options: new(Json)
            { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if ((int)response.StatusCode is >= 300 and < 400) return new(502, Code: "redirect_rejected");
            // Never reflect raw provider errors, arbitrary fields or CLI output.
            if (response.Content.Headers.ContentLength > 32768) return new(502, Code: "invalid_response");
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[4096];
            int length;
            while ((length = await stream.ReadAsync(chunk, timeout.Token)) > 0)
            {
                if (buffer.Length + length > 32768) return new(502, Code: "invalid_response");
                buffer.Write(chunk, 0, length);
            }
            using var document = JsonDocument.Parse(buffer.ToArray());
            if (!response.IsSuccessStatusCode)
            {
                var code = document.RootElement.TryGetProperty("code", out var property) && property.ValueKind == JsonValueKind.String
                    ? property.GetString() : null;
                var status = (int)response.StatusCode;
                return new(status is 400 or 404 or 409 or 422 or 503 ? status : 502, Code: SafeReason(code) ?? "provider_error");
            }
            var value = document.RootElement.Deserialize<ProviderAuthSnapshot>(Json);
            if (value is null || value.SchemaId != "harness-provider-auth-v1" || value.NodeId != nodeId || value.Revision < 0 ||
                value.State is not ("unknown" or "unauthenticated" or "authenticated" or "reauthentication_required") ||
                value.Capabilities?.Methods is null || value.Capabilities.Methods.Any(x => x is not ("secret" or "device_code")))
                return new(502, Code: "invalid_response");
            var op = value.Operation;
            if (op is not null)
            {
                if (!ExactId(op.OperationId) || !ExactId(op.CommandId) || (operationId is not null && op.OperationId != operationId) ||
                    op.Method is not ("secret" or "device_code") || op.Status is not ("pending" or "succeeded" or "failed" or "cancelled" or "expired"))
                    return new(502, Code: "invalid_response");
                if (op.VerificationUrl is not null && (!Uri.TryCreate(op.VerificationUrl, UriKind.Absolute, out var login) ||
                    login.Scheme != "https" || !string.IsNullOrEmpty(login.UserInfo) || op.VerificationUrl.Length > 2048))
                    return new(502, Code: "invalid_response");
                if (op.UserCode?.Length > 128) return new(502, Code: "invalid_response");
                var showCode = op.Status == "pending" && op.Method == "device_code";
                op = op with { ReasonCode = SafeReason(op.ReasonCode), VerificationUrl = showCode ? op.VerificationUrl : null,
                    UserCode = showCode ? op.UserCode : null };
            }
            return new((int)response.StatusCode, value with { ReasonCode = SafeReason(value.ReasonCode), Operation = op });
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException)
        { return new(503, Code: error is OperationCanceledException ? "timeout" : "provider_unavailable"); }
    }
}

public static class ProviderAuthEndpoints
{
    public static void MapProviderAuth(this RouteGroupBuilder connections)
    {
        connections.MapGet("/{id}/provider-auth", (string id, string nodeId, long configEpoch, HttpContext ctx,
            IConnectionRepository store, IProviderAuthClient client, ICentrifugoPublisher publisher, CancellationToken ct) =>
            Dispatch(id, nodeId, configEpoch, "", null, null, ctx, store, client, publisher, ct));
        connections.MapGet("/{id}/provider-auth/operations/{operationId}", (string id, string nodeId, long configEpoch, string operationId, HttpContext ctx,
            IConnectionRepository store, IProviderAuthClient client, ICentrifugoPublisher publisher, CancellationToken ct) =>
            Dispatch(id, nodeId, configEpoch, "", operationId, null, ctx, store, client, publisher, ct));
        foreach (var action in new[] { "operations", "check", "logout" })
            connections.MapPost("/{id}/provider-auth/" + action, (string id, long configEpoch, ProviderAuthCommand input, HttpContext ctx,
                IConnectionRepository store, IProviderAuthClient client, ICentrifugoPublisher publisher, CancellationToken ct) =>
                Dispatch(id, input.NodeId, configEpoch, action, null, input, ctx, store, client, publisher, ct));
        connections.MapPost("/{id}/provider-auth/operations/{operationId}/cancel", (string id, long configEpoch, string operationId, ProviderAuthCommand input, HttpContext ctx,
            IConnectionRepository store, IProviderAuthClient client, ICentrifugoPublisher publisher, CancellationToken ct) =>
            Dispatch(id, input.NodeId, configEpoch, "cancel", operationId, input, ctx, store, client, publisher, ct));
    }

    private static async Task<IResult> Dispatch(string id, string? nodeId, long epoch, string action, string? operationId,
        ProviderAuthCommand? input, HttpContext context, IConnectionRepository store, IProviderAuthClient client,
        ICentrifugoPublisher publisher, CancellationToken ct)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
        if (!ProviderAuthClient.ExactId(nodeId) || (operationId is not null && !ProviderAuthClient.ExactId(operationId)) ||
            (input is not null && (!ProviderAuthClient.ExactId(input.CommandId) || input.Secret?.Length > 16384 ||
                (action == "operations" ? input.Method is not ("secret" or "device_code") ||
                    (input.Method == "secret" ? string.IsNullOrWhiteSpace(input.Secret) : input.Secret is not null)
                    : input.Method is not null || input.Secret is not null))))
            return Results.BadRequest(new { code = "invalid_request" });
        var connection = await store.GetAsync(id, ct);
        if (connection is null) return Results.NotFound(new { code = "not_found" });
        if (connection.ConfigEpoch != epoch || connection.Observation.NodeId != nodeId || connection.Observation.Compatibility != "compatible")
            return Results.Conflict(new { code = "connection_changed" });
        var identities = ConnectionIdentity.Analyze(await store.ListAsync(ct));
        if (!identities.TryGetValue(id, out var identity) || identity.Status != ConnectionIdentity.Unique)
            return Results.Conflict(new { code = "node_id_conflict" });
        var result = await client.SendAsync(connection, nodeId!, action, operationId, input, ct);
        var current = await store.GetAsync(id, ct);
        if (current?.ConfigEpoch != epoch || current.Observation.NodeId != nodeId)
            return Results.Conflict(new { code = "connection_changed" });
        if (input is not null)
            await publisher.PublishInvalidationAsync("nodes", id, "provider_auth", ct);
        return result.Snapshot is not null ? Results.Json(result.Snapshot, statusCode: result.Status)
            : Results.Json(new { code = result.Code }, statusCode: result.Status);
    }
}
