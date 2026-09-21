using System.ComponentModel.DataAnnotations;

public sealed record ConnectionRequest(string? Name, string? BaseUri, int? ObservationIntervalSeconds = null,
    int? RequestTimeoutSeconds = null, int? StaleThresholdSeconds = null);

public sealed record ObservationSettings(int IntervalSeconds, int TimeoutSeconds, int StaleThresholdSeconds)
{
    public static readonly ObservationSettings Default = new(15, 5, 45);
}

public sealed record Observation(DateTimeOffset? AttemptedAt, DateTimeOffset? SuccessfulAt,
    bool? HttpReachable, bool? ExecutorHealthy, bool? Ready, string? Capacity,
    DateTimeOffset? HeartbeatAt, string? BootId, string? NodeId, int? ProtocolVersion,
    string? SchemaId, string Compatibility, string? ErrorCode)
{
    public static readonly Observation Unknown = new(null, null, null, null, null, null, null, null, null, null, null, "unknown", null);
}

public sealed record Connection(string Id, string Name, string BaseUri, long ConfigEpoch,
    ObservationSettings Settings, Observation Observation, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record ObservationResponse(DateTimeOffset? AttemptedAt, DateTimeOffset? SuccessfulAt,
    bool? HttpReachable, bool? ExecutorHealthy, bool? Ready, string? Capacity,
    DateTimeOffset? HeartbeatAt, bool? HeartbeatFresh, string? BootId, string? NodeId,
    int? ProtocolVersion, string? SchemaId, string Compatibility, string? ErrorCode)
{
    public static ObservationResponse From(Connection value)
    {
        var observation = value.Observation;
        var age = observation.HeartbeatAt is null ? (TimeSpan?)null : DateTimeOffset.UtcNow - observation.HeartbeatAt.Value;
        bool? fresh = age is null ? null : age >= TimeSpan.Zero && age <= TimeSpan.FromSeconds(value.Settings.StaleThresholdSeconds);
        bool? ready = observation.AttemptedAt is null ? null :
            observation.HttpReachable == true && observation.ExecutorHealthy == true && fresh == true && Guid.TryParse(observation.BootId, out _)
                ? observation.Ready
                : false;
        return new(observation.AttemptedAt, observation.SuccessfulAt, observation.HttpReachable,
            observation.ExecutorHealthy, ready, observation.Capacity, observation.HeartbeatAt, fresh,
            observation.BootId, observation.NodeId, observation.ProtocolVersion, observation.SchemaId,
            observation.Compatibility, observation.ErrorCode);
    }
}

public sealed record ConnectionResponse(string Id, string Name, string BaseUri, long ConfigEpoch,
    int ObservationIntervalSeconds, int RequestTimeoutSeconds, int StaleThresholdSeconds,
    ObservationResponse Observation, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)
{
    public static ConnectionResponse From(Connection value) => new(value.Id, value.Name, value.BaseUri,
        value.ConfigEpoch, value.Settings.IntervalSeconds, value.Settings.TimeoutSeconds,
        value.Settings.StaleThresholdSeconds, ObservationResponse.From(value), value.CreatedAt, value.UpdatedAt);
}

public sealed record NodeProjection(string ConnectionId, string Name, long ConfigEpoch, ObservationResponse Observation)
{
    public static NodeProjection From(Connection value) => new(value.Id, value.Name, value.ConfigEpoch, ObservationResponse.From(value));
}

public static class ConnectionInput
{
    public static (string? Name, string? BaseUri, ObservationSettings? Settings, Dictionary<string, string[]>? Error)
        Validate(ConnectionRequest input, HarnessAddressPolicy? addresses = null)
    {
        var errors = new Dictionary<string, string[]>();
        var name = input.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200)
            errors["name"] = ["Name is required and must be at most 200 characters."];
        var baseUri = input.BaseUri?.Trim();
        if (!Uri.TryCreate(baseUri, UriKind.Absolute, out var uri) || !HarnessUri.IsSafeBase(uri))
            errors["baseUri"] = ["BaseUri must be an allowed absolute HTTPS URI without userinfo or fragments."];
        else if (addresses is not null && !addresses.IsAllowed(uri))
            errors["baseUri"] = ["BaseUri host is outside the configured private Harness boundary."];
        else baseUri = uri.AbsoluteUri;

        var interval = input.ObservationIntervalSeconds ?? ObservationSettings.Default.IntervalSeconds;
        var timeout = input.RequestTimeoutSeconds ?? ObservationSettings.Default.TimeoutSeconds;
        var stale = input.StaleThresholdSeconds ?? ObservationSettings.Default.StaleThresholdSeconds;
        if (interval is < 2 or > 3600) errors["observationIntervalSeconds"] = ["Interval must be between 2 and 3600 seconds."];
        if (timeout is < 1 or > 120) errors["requestTimeoutSeconds"] = ["Timeout must be between 1 and 120 seconds."];
        if (stale < interval + timeout || stale > 86400) errors["staleThresholdSeconds"] = ["Stale threshold must be at least interval plus timeout and at most 86400 seconds."];
        return (name, baseUri, new(interval, timeout, stale), errors.Count == 0 ? null : errors);
    }
}

public sealed class MongoOptions
{
    [Required] public string ConnectionString { get; init; } = null!;
    [Required] public string Database { get; init; } = null!;
}
public sealed class InternalAuthOptions { [Required] public string Token { get; init; } = null!; }
public sealed class CentrifugoOptions { public string? PublishUrl { get; init; } public string? ApiKey { get; init; } }
public sealed class HarnessOptions
{
    public string AllowedHosts { get; init; } = "cursor-harness,codex-harness";
    public int MaximumResponseBytes { get; init; } = 8 * 1024 * 1024;
    public string? CaFile { get; init; }
}
