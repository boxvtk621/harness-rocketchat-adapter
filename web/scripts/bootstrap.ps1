[CmdletBinding()]
param(
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$secretsDir = Join-Path $root '.runtime\secrets'
$harnessDir = Join-Path $root '.runtime\harness'
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
New-Item -ItemType Directory -Force -Path $harnessDir | Out-Null

function New-RandomSecret([int]$bytes = 32) {
    $buffer = New-Object byte[] $bytes
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).Replace('+','-').Replace('/','_').TrimEnd('=')
}

function Set-SecretIfMissing([string]$name, [string]$value) {
    $path = Join-Path $secretsDir $name
    if (-not (Test-Path -LiteralPath $path)) {
        [System.IO.File]::WriteAllText($path, $value, [System.Text.UTF8Encoding]::new($false))
    }
    return [System.IO.File]::ReadAllText($path).Trim()
}

$mongoUser = Set-SecretIfMissing 'mongodb_root_username' 'hl303_root'
$mongoPassword = Set-SecretIfMissing 'mongodb_root_password' (New-RandomSecret)
$devPassword = Set-SecretIfMissing 'keycloak_dev_user_password' (New-RandomSecret 18)
Set-SecretIfMissing 'keycloak_admin_password' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'adapter_internal_token' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'centrifugo_client_secret' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'centrifugo_api_key' (New-RandomSecret) | Out-Null
$escapedUser = [Uri]::EscapeDataString($mongoUser)
$escapedPassword = [Uri]::EscapeDataString($mongoPassword)
Set-SecretIfMissing 'mongodb_connection_string' "mongodb://${escapedUser}:${escapedPassword}@mongodb:27017/?authSource=admin" | Out-Null
Set-SecretIfMissing 'cursor_fixture_key' 'fixture-only-no-provider-request' | Out-Null

$serverCert = Join-Path $harnessDir 'server.crt'
$serverKey = Join-Path $harnessDir 'server.key'
if (-not (Test-Path -LiteralPath $serverCert) -or -not (Test-Path -LiteralPath $serverKey)) {
    docker run --rm -v "${harnessDir}:/out" alpine/openssl req -x509 -newkey rsa:2048 -nodes `
        -keyout /out/server.key -out /out/server.crt -days 365 -subj '/CN=hl304-harness-local' `
        -addext 'subjectAltName=DNS:cursor-harness,DNS:codex-harness' `
        -addext 'basicConstraints=critical,CA:TRUE' `
        -addext 'keyUsage=critical,digitalSignature,keyCertSign' -addext 'extendedKeyUsage=serverAuth'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to generate isolated Harness TLS certificate in Docker.' }
}

Write-Host 'Local bootstrap secrets are ready in the gitignored .runtime/secrets directory.'
Write-Host 'An isolated local Harness TLS certificate is ready; the Cursor fixture key is not a provider credential.'
Write-Host 'Keycloak user: operator'
Write-Host "Keycloak initial password: $devPassword"

if ($Start) {
    docker compose --project-directory $root -f (Join-Path $root 'compose.yaml') --profile harness up --build -d
}
