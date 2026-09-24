using System.Net;
using System.Net.Sockets;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Options;

public static class HarnessUri
{
    public static bool IsSafeBase(Uri uri) => uri.IsAbsoluteUri &&
        uri.Scheme == Uri.UriSchemeHttps &&
        string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Fragment) &&
        !string.IsNullOrWhiteSpace(uri.Host) && !IPAddress.TryParse(uri.Host, out _) &&
        !string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase) &&
        !uri.IsLoopback;

    public static Uri Build(string baseUri, IReadOnlyList<string> pathSegments,
        IReadOnlyDictionary<string, string?>? query = null)
    {
        var origin = new Uri(baseUri, UriKind.Absolute);
        if (!IsSafeBase(origin)) throw new InvalidDataException("Unsafe Harness base URI.");
        var builder = new UriBuilder(origin);
        var prefix = origin.AbsolutePath.TrimEnd('/');
        builder.Path = prefix + "/" + string.Join("/", pathSegments.Select(Uri.EscapeDataString));
        var parts = new List<string>();
        if (!string.IsNullOrEmpty(origin.Query)) parts.Add(origin.Query.TrimStart('?'));
        if (query is not null)
        {
            parts.AddRange(query.Where(x => x.Value is not null)
                .Select(x => $"{Uri.EscapeDataString(x.Key)}={Uri.EscapeDataString(x.Value!)}"));
        }
        builder.Query = string.Join("&", parts);
        builder.Fragment = "";
        return builder.Uri;
    }
}

public sealed class HarnessAddressPolicy
{
    private readonly HashSet<string> _allowed;
    public HarnessAddressPolicy(IOptions<HarnessOptions> options) => _allowed = options.Value.AllowedHosts
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);
    public bool IsAllowed(Uri uri) => HarnessUri.IsSafeBase(uri) && _allowed.Contains(uri.IdnHost);
}

public static class HarnessTls
{
    public static SocketsHttpHandler CreateHandler(IOptions<HarnessOptions> options)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.None, UseCookies = false
        };
        if (string.IsNullOrWhiteSpace(options.Value.CaFile)) return handler;
        var root = X509CertificateLoader.LoadCertificateFromFile(options.Value.CaFile);
        handler.SslOptions.RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
        {
            if (certificate is null || (errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) return false;
            using var candidate = new X509Certificate2(certificate);
            using var custom = new X509Chain();
            custom.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            custom.ChainPolicy.CustomTrustStore.Add(root);
            custom.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return custom.Build(candidate);
        };
        return handler;
    }
}

public sealed record HarnessProbeResult(Observation Observation);
public sealed record HarnessGetResult(int StatusCode, JsonDocument? Document);

public interface IHarnessClient
{
    Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken cancellationToken);
    Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
        IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken);
    async Task<HarnessGetResult> GetResultAsync(Connection connection, IReadOnlyList<string> path,
        IReadOnlyDictionary<string, string?>? query, CancellationToken cancellationToken) =>
        new(200, await GetAsync(connection, path, query, cancellationToken));
    IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
        CancellationToken cancellationToken);
    async IAsyncEnumerable<HarnessEvent> WatchDetailedEventsAsync(Connection connection, long after,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var sequence in WatchEventsAsync(connection, after, cancellationToken))
            yield return new HarnessEvent(sequence, null, null, null, null, null);
    }
}

public sealed record HarnessEvent(long Seq, string? Type, string? NodeId, string? EntityId,
    string? DialogId, string? RequestId, string? AttemptId = null);

public sealed class HarnessClient(HttpClient http, IOptions<HarnessOptions> options, HarnessAddressPolicy addresses) : IHarnessClient
{
    private const int ProtocolVersion = 1;
    private const string SchemaId = "harness-wire-v2";

    public async Task<HarnessProbeResult> ProbeAsync(Connection connection, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(connection.Settings.TimeoutSeconds));
        try
        {
            using var identity = await GetRequiredAsync(connection, ["v1", "identity"], null, timeout.Token);
            var root = identity.RootElement;
            var protocol = GetInt(root, "protocolVersion");
            var schema = GetString(root, "schemaId");
            var reportedNodeId = GetString(root, "nodeId");
            var nodeIdValid = Guid.TryParse(reportedNodeId, out var parsedNodeId);
            var compatible = protocol == ProtocolVersion && schema == SchemaId && nodeIdValid;
            var nodeId = compatible ? parsedNodeId.ToString("D") : reportedNodeId;
            if (!compatible)
                return new(new(now, null, true, null, false, null, null, null, nodeId, protocol, schema, "incompatible", "contract_mismatch"));

            using var live = await GetRequiredAsync(connection, ["health", "live"], null, timeout.Token);
            var liveRoot = live.RootElement;
            var liveHealthy = string.Equals(GetString(liveRoot, "status"), "live", StringComparison.OrdinalIgnoreCase) ||
                              string.Equals(GetString(liveRoot, "status"), "healthy", StringComparison.OrdinalIgnoreCase);

            using var heartbeat = await GetRequiredAsync(connection, ["v1", "executor", "heartbeat"], null, timeout.Token);
            var heartbeatRoot = heartbeat.RootElement;
            var heartbeatNodeId = GetString(heartbeatRoot, "nodeId");
            if (!Guid.TryParse(heartbeatNodeId, out var parsedHeartbeatNodeId) ||
                !string.Equals(parsedHeartbeatNodeId.ToString("D"), nodeId, StringComparison.Ordinal))
                return new(new(now, null, true, false, false, null, null, null, nodeId, protocol, schema, "incompatible", "heartbeat_identity_mismatch"));
            var heartbeatHealth = GetString(heartbeatRoot, "health");
            var executorHealthy = liveHealthy && string.Equals(heartbeatHealth, "live", StringComparison.OrdinalIgnoreCase);
            var bootId = GetString(heartbeatRoot, "bootId");
            var heartbeatAt = GetDate(heartbeatRoot, "observedAt");

            using var ready = await GetRequiredAsync(connection, ["health", "ready"], null, timeout.Token);
            var readyRoot = ready.RootElement;
            var readiness = GetString(readyRoot, "readiness");
            var heartbeatReadiness = GetString(heartbeatRoot, "readiness");
            var heartbeatContractValid = Guid.TryParse(bootId, out _) && heartbeatAt is not null &&
                                         heartbeatHealth == "live" &&
                                         heartbeatReadiness is "ready" or "blocked" or "unknown";
            var heartbeatFresh = heartbeatAt is { } observedAt && now - observedAt >= TimeSpan.Zero &&
                                 now - observedAt <= TimeSpan.FromSeconds(connection.Settings.StaleThresholdSeconds);
            var isReady = heartbeatContractValid && heartbeatFresh && executorHealthy &&
                          string.Equals(readiness, "ready", StringComparison.OrdinalIgnoreCase) &&
                          string.Equals(heartbeatReadiness, "ready", StringComparison.OrdinalIgnoreCase);
            var capacity = Scalar(heartbeatRoot, "capacity") ?? Scalar(readyRoot, "capacity");
            var occupancy = "unknown";
            var snapshot = await GetResultAsync(connection, ["v1", "nodes", nodeId!, "snapshot"], null, timeout.Token);
            using (snapshot.Document)
            {
                if (snapshot.StatusCode == 200 && snapshot.Document is { } snapshotDocument)
                {
                    var snapshotRoot = snapshotDocument.RootElement;
                    var reported = snapshotRoot.TryGetProperty("node", out var node) ? GetString(node, "occupancy") : null;
                    if (GetInt(snapshotRoot, "protocolVersion") == ProtocolVersion &&
                        GetString(snapshotRoot, "schemaId") == SchemaId &&
                        GetString(snapshotRoot, "nodeId") == nodeId &&
                        reported is "idle" or "active" or "unknown")
                        occupancy = reported;
                }
            }
            return new(new(now, now, true, executorHealthy, isReady, capacity, heartbeatAt, bootId,
                nodeId, protocol, schema, heartbeatContractValid ? "compatible" : "incompatible",
                heartbeatContractValid ? null : "heartbeat_contract_mismatch", occupancy));
        }
        catch (HarnessHttpException ex)
        {
            return new(new(now, connection.Observation.SuccessfulAt, true, null, false,
                connection.Observation.Capacity, connection.Observation.HeartbeatAt, connection.Observation.BootId,
                connection.Observation.NodeId, connection.Observation.ProtocolVersion, connection.Observation.SchemaId,
                ex.StatusCode is >= 300 and < 400 ? "incompatible" : connection.Observation.Compatibility,
                ex.StatusCode is >= 300 and < 400 ? "redirect_rejected" : "http_error"));
        }
        catch (HarnessPayloadException)
        {
            return new(new(now, connection.Observation.SuccessfulAt, true, null, false,
                connection.Observation.Capacity, connection.Observation.HeartbeatAt, connection.Observation.BootId,
                connection.Observation.NodeId, connection.Observation.ProtocolVersion, connection.Observation.SchemaId,
                "incompatible", "invalid_response"));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidDataException)
        {
            return new(new(now, connection.Observation.SuccessfulAt, false, null, false,
                connection.Observation.Capacity, connection.Observation.HeartbeatAt, connection.Observation.BootId,
                connection.Observation.NodeId, connection.Observation.ProtocolVersion, connection.Observation.SchemaId,
                connection.Observation.Compatibility, ex is TaskCanceledException ? "timeout" : "unreachable"));
        }
    }

    public async Task<JsonDocument?> GetAsync(Connection connection, IReadOnlyList<string> path,
        IReadOnlyDictionary<string, string?>? query, CancellationToken ct)
        => (await GetResultAsync(connection, path, query, ct)).Document;

    public async Task<HarnessGetResult> GetResultAsync(Connection connection, IReadOnlyList<string> path,
        IReadOnlyDictionary<string, string?>? query, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(connection.Settings.TimeoutSeconds));
        try { return new(200, await GetRequiredAsync(connection, path, query, timeout.Token)); }
        catch (HarnessHttpException ex) { return new(ex.StatusCode, null); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or InvalidDataException or HarnessPayloadException) { return new(0, null); }
    }

    public async IAsyncEnumerable<long> WatchEventsAsync(Connection connection, long after,
        [EnumeratorCancellation] CancellationToken ct)
    {
        await foreach (var item in WatchDetailedEventsAsync(connection, after, ct)) yield return item.Seq;
    }

    public async IAsyncEnumerable<HarnessEvent> WatchDetailedEventsAsync(Connection connection, long after,
        [EnumeratorCancellation] CancellationToken ct)
    {
        var uri = HarnessUri.Build(connection.BaseUri,
            ["v1", "nodes", connection.Observation.NodeId!, "events"],
            new Dictionary<string, string?> { ["after"] = after.ToString(System.Globalization.CultureInfo.InvariantCulture) });
        if (!addresses.IsAllowed(uri)) throw new InvalidDataException("Harness address left its configured boundary.");
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Accept.ParseAdd("text/event-stream");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Harness event stream returned HTTP {(int)response.StatusCode}.");
        await using var input = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(input);
        while (!ct.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) yield break;
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var value = ParseEvent(line[5..].TrimStart());
            if (value.Seq <= after) continue;
            after = value.Seq;
            yield return value;
        }
    }

    private static HarnessEvent ParseEvent(string data)
    {
        try
        {
            using var envelope = JsonDocument.Parse(data);
            var root = envelope.RootElement;
            if (root.TryGetProperty("seq", out var seq) && seq.TryGetInt64(out var value))
            {
                static string? Str(JsonElement item, string key) =>
                    item.TryGetProperty(key, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
                var payload = root.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object ? p : default;
                var requestId = Str(root, "requestId") ?? (payload.ValueKind == JsonValueKind.Object ? Str(payload, "requestId") : null);
                return new(value, Str(root, "type"), Str(root, "nodeId"), Str(root, "entityId"),
                    Str(root, "dialogId") ?? (payload.ValueKind == JsonValueKind.Object ? Str(payload, "dialogId") : null),
                    requestId, Str(root, "attemptId"));
            }
        }
        catch (JsonException) { }
        throw new HarnessPayloadException();
    }

    private async Task<JsonDocument> GetRequiredAsync(Connection connection, IReadOnlyList<string> path,
        IReadOnlyDictionary<string, string?>? query, CancellationToken ct)
    {
        var uri = HarnessUri.Build(connection.BaseUri, path, query);
        if (!addresses.IsAllowed(uri)) throw new InvalidDataException("Harness address left its configured boundary.");
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        // Deliberately no Authorization, Cookie, X-Internal-Token or caller identity headers.
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if ((int)response.StatusCode is >= 300 and < 400) throw new HarnessHttpException((int)response.StatusCode);
        if (!response.IsSuccessStatusCode) throw new HarnessHttpException((int)response.StatusCode);
        if (response.Content.Headers.ContentLength > options.Value.MaximumResponseBytes) throw new HarnessPayloadException();
        await using var input = await response.Content.ReadAsStreamAsync(ct);
        await using var bounded = new MemoryStream();
        var buffer = new byte[16 * 1024];
        var total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, ct);
            if (read == 0) break;
            total += read;
            if (total > options.Value.MaximumResponseBytes) throw new HarnessPayloadException();
            await bounded.WriteAsync(buffer.AsMemory(0, read), ct);
        }
        bounded.Position = 0;
        try { return await JsonDocument.ParseAsync(bounded, cancellationToken: ct); }
        catch (JsonException) { throw new HarnessPayloadException(); }
    }

    private static string? GetString(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
    private static int? GetInt(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.TryGetInt32(out var result) ? result : null;
    private static DateTimeOffset? GetDate(JsonElement value, string name) => DateTimeOffset.TryParse(GetString(value, name), out var result) ? result : null;
    private static string? Scalar(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var capacity)) return null;
        return capacity.ValueKind == JsonValueKind.String ? capacity.GetString() : capacity.GetRawText();
    }
    private sealed class HarnessHttpException(int statusCode) : Exception { public int StatusCode { get; } = statusCode; }
    private sealed class HarnessPayloadException : Exception { }
}
