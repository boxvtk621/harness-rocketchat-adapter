public static class ObservationSemantics
{
    public static Observation WithFreshness(Observation observation, ObservationSettings settings, DateTimeOffset now)
    {
        var fresh = observation.HeartbeatAt is { } heartbeat && now >= heartbeat &&
            now - heartbeat <= TimeSpan.FromSeconds(settings.StaleThresholdSeconds);
        return observation with { HeartbeatFresh = observation.HeartbeatAt is null ? null : fresh };
    }

    public static string Key(Connection connection)
    {
        var snapshot = ObservationResponse.From(connection);
        var value = connection.Observation;
        return string.Join('|', snapshot.Availability, snapshot.Ready?.ToString(), snapshot.HeartbeatFresh?.ToString(),
            value.HttpReachable?.ToString(), value.ExecutorHealthy?.ToString(), value.Capacity, value.Occupancy,
            value.BootId, value.NodeId, value.ProtocolVersion?.ToString(), value.SchemaId, value.Compatibility,
            value.ErrorCode);
    }
}

public sealed record ObservationCommit(bool Written, bool Changed, Connection? Connection);
