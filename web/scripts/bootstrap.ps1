[CmdletBinding()]
param(
    [switch]$Start,
    [Parameter(Mandatory = $true)][string]$ProjectName,
    [int]$ClientPort = 18505,
    [int]$KeycloakPort = 18585,
    [string]$CursorContext,
    [string]$CodexContext
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($ProjectName -notmatch '^hl30[56]-[a-z0-9-]+$') { throw 'Use a dedicated hl305-* or hl306-* project for acceptance.' }
if ($ClientPort -lt 1024 -or $ClientPort -gt 65535 -or $KeycloakPort -lt 1024 -or $KeycloakPort -gt 65535) { throw 'Use unprivileged valid TCP ports.' }
if ($ClientPort -eq 18100 -or $KeycloakPort -eq 18180 -or $ClientPort -eq $KeycloakPort) { throw 'Acceptance ports must differ from the working stack.' }
& (Join-Path $PSScriptRoot 'assert-isolated-owner.ps1') -ProjectName $ProjectName -ProjectRoot $root
if (-not $CursorContext -or -not $CodexContext) {
    $ancestor = Get-Item -LiteralPath $root
    while ($ancestor -and -not (Test-Path (Join-Path $ancestor.FullName 'harness-cursor/delivery/Dockerfile.cursor'))) { $ancestor = $ancestor.Parent }
    if (-not $ancestor) { throw 'Specify existing Harness source paths with -CursorContext and -CodexContext.' }
    if (-not $CursorContext) { $CursorContext = Join-Path $ancestor.FullName 'harness-cursor' }
    if (-not $CodexContext) { $CodexContext = Join-Path $ancestor.FullName 'harness-codex' }
}
$secretsDir = Join-Path $root '.runtime\secrets'
$harnessDir = Join-Path $root '.runtime\harness'
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
New-Item -ItemType Directory -Force -Path $harnessDir | Out-Null
$clientDir = Join-Path $root '.runtime/client'
New-Item -ItemType Directory -Force -Path $clientDir | Out-Null
$runtime = 'window.__HARNESS_CONFIG__ = ' + (@{ oidcAuthority = "http://localhost:$KeycloakPort/realms/harness"; oidcClientId = 'harness-web' } | ConvertTo-Json -Compress) + ';'
$environmentFile = Join-Path $root '.runtime/acceptance.env'
$environmentText = @(
    "COMPOSE_PROJECT_NAME=$ProjectName", "HL304_VOLUME_PREFIX=$ProjectName",
    "WEB_CLIENT_PORT=$ClientPort", "WEB_KEYCLOAK_PORT=$KeycloakPort", 'ACCEPTANCE_ISOLATED=true',
    'CLIENT_RUNTIME_CONFIG=./.runtime/client/runtime-config.js',
    ('HARNESS_CURSOR_CONTEXT=' + $CursorContext.Replace('\','/')),
    ('HARNESS_CODEX_CONTEXT=' + $CodexContext.Replace('\','/'))
) -join "`n"
if (Test-Path $environmentFile) {
    $existingLines = @(Get-Content $environmentFile | Where-Object { $_.Trim() } | Sort-Object)
    $requestedLines = @($environmentText -split "`n" | Sort-Object)
    if (Compare-Object $existingLines $requestedLines) { throw 'Existing acceptance wiring belongs to another configuration; reuse its exact parameters.' }
}
[IO.File]::WriteAllText($environmentFile, $environmentText + "`n")
[IO.File]::WriteAllText((Join-Path $clientDir 'runtime-config.js'), $runtime)

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
Set-SecretIfMissing 'keycloak_dev_viewer_password' (New-RandomSecret 18) | Out-Null
Set-SecretIfMissing 'keycloak_admin_password' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'adapter_internal_token' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'centrifugo_client_secret' (New-RandomSecret) | Out-Null
Set-SecretIfMissing 'centrifugo_api_key' (New-RandomSecret) | Out-Null
$escapedUser = [Uri]::EscapeDataString($mongoUser)
$escapedPassword = [Uri]::EscapeDataString($mongoPassword)
Set-SecretIfMissing 'mongodb_connection_string' "mongodb://${escapedUser}:${escapedPassword}@mongodb:27017/?authSource=admin" | Out-Null

$serverCert = Join-Path $harnessDir 'server.crt'
$serverKey = Join-Path $harnessDir 'server.key'
if (-not (Test-Path -LiteralPath $serverCert) -or -not (Test-Path -LiteralPath $serverKey)) {
    docker run --rm -v "${harnessDir}:/out" alpine/openssl req -x509 -newkey rsa:2048 -nodes `
        -keyout /out/server.key -out /out/server.crt -days 365 -subj '/CN=hl304-harness-local' `
        -addext 'subjectAltName=DNS:cursor-harness,DNS:codex-harness,DNS:auth-fixture' `
        -addext 'basicConstraints=critical,CA:TRUE' `
        -addext 'keyUsage=critical,digitalSignature,keyCertSign' -addext 'extendedKeyUsage=serverAuth'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to generate isolated Harness TLS certificate in Docker.' }
}

Write-Host 'Local bootstrap secrets are ready in the gitignored .runtime/secrets directory.'
Write-Host 'An isolated local Harness TLS certificate is ready. Provider credentials must be entered through Web.'
Write-Host 'Keycloak user: operator'
Write-Host 'Keycloak password is in .runtime/secrets/keycloak_dev_user_password.'

if ($Start) {
    $effective = docker compose --env-file $environmentFile --project-directory $root -f (Join-Path $root 'compose.yaml') --profile harness config --format json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $effective.name -ne $ProjectName) { throw 'Effective Compose project differs from bootstrap parameters.' }
    foreach ($resource in @($effective.volumes.PSObject.Properties) + @($effective.networks.PSObject.Properties)) {
        if (-not $resource.Value.name.StartsWith($ProjectName + '-')) { throw 'Effective volume or network is outside this project.' }
    }
    if ([int]$effective.services.client.ports[0].published -ne $ClientPort -or [int]$effective.services.keycloak.ports[0].published -ne $KeycloakPort) { throw 'Effective ports differ from bootstrap parameters.' }
    docker compose --env-file $environmentFile --project-directory $root -f (Join-Path $root 'compose.yaml') --profile harness up --build -d
    if ($LASTEXITCODE -ne 0) { throw 'Isolated stack startup failed.' }
}
