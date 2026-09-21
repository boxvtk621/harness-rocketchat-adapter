using Xunit;

public class ConnectionInputTests
{
    [Theory]
    [InlineData("https://harness.example/api/v1/jobs", "https://harness.example/api/v1/jobs")]
    [InlineData("https://example.test/a/b?enabled=true", "https://example.test/a/b?enabled=true")]
    public void Accepts_absolute_http_uri_and_preserves_path(string value, string expected)
    {
        var result = ConnectionInput.Validate(new ConnectionRequest("Harness", value));
        Assert.Null(result.Error);
        Assert.Equal(expected, result.BaseUri);
    }

    [Theory]
    [InlineData("/relative/path")]
    [InlineData("ftp://example.test/path")]
    [InlineData("not a uri")]
    public void Rejects_non_http_absolute_uri(string value)
    {
        var result = ConnectionInput.Validate(new ConnectionRequest("Harness", value));
        Assert.NotNull(result.Error);
        Assert.Contains("baseUri", result.Error!.Keys);
    }

    [Theory]
    [InlineData("https://user:secret@example.test/harness")]
    [InlineData("https://example.test/harness#fragment")]
    public void Rejects_uri_secrets_and_fragments(string value)
    {
        var result = ConnectionInput.Validate(new ConnectionRequest("Harness", value));
        Assert.NotNull(result.Error);
        Assert.Contains("baseUri", result.Error!.Keys);
    }

    [Theory]
    [InlineData(1, 5, 45, "observationIntervalSeconds")]
    [InlineData(15, 0, 45, "requestTimeoutSeconds")]
    [InlineData(15, 5, 19, "staleThresholdSeconds")]
    public void Rejects_unsafe_observation_timers(int interval, int timeout, int stale, string field)
    {
        var result = ConnectionInput.Validate(new ConnectionRequest("Harness", "https://example.test/", interval, timeout, stale));
        Assert.NotNull(result.Error);
        Assert.Contains(field, result.Error.Keys);
    }
}
