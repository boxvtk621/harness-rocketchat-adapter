using Xunit;

public class ConnectionInputTests
{
    [Theory]
    [InlineData("https://harness.example/api/v1/jobs", "https://harness.example/api/v1/jobs")]
    [InlineData("http://example.test/a/b?enabled=true", "http://example.test/a/b?enabled=true")]
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
}
