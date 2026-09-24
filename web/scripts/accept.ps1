[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'compose.yaml'
$environmentFile = Join-Path $root '.runtime/acceptance.env'
if (-not (Test-Path $environmentFile)) { throw 'Run bootstrap.ps1 for a dedicated hl305-* or hl320-* acceptance project first.' }
$wiring = @{}
Get-Content $environmentFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $wiring[$matches[1]] = $matches[2] } }
if ($wiring.COMPOSE_PROJECT_NAME -notmatch '^(hl305|hl320)-[a-z0-9-]+$' -or $wiring.HL304_VOLUME_PREFIX -ne $wiring.COMPOSE_PROJECT_NAME -or $wiring.ACCEPTANCE_ISOLATED -ne 'true') { throw 'Refusing acceptance outside dedicated project/volume namespace.' }
if ($wiring.WEB_CLIENT_PORT -eq '18100' -or $wiring.WEB_KEYCLOAK_PORT -eq '18180') { throw 'Refusing working-stack ports.' }
$composeArgs = @('compose', '--env-file', $environmentFile, '--project-directory', $root, '-f', $compose)
$rendered = docker @composeArgs --profile harness --profile acceptance config --format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $rendered.name -ne $wiring.COMPOSE_PROJECT_NAME) { throw 'Effective Compose project differs from the isolated environment file.' }
foreach ($entry in $rendered.volumes.PSObject.Properties) {
    if (-not $entry.Value.name.StartsWith($wiring.COMPOSE_PROJECT_NAME + '-')) { throw "Volume is not isolated: $($entry.Name)" }
}
foreach ($entry in $rendered.networks.PSObject.Properties) {
    if (-not $entry.Value.name.StartsWith($wiring.COMPOSE_PROJECT_NAME + '-')) { throw "Network is not isolated: $($entry.Name)" }
}
if ([string]$rendered.services.client.ports[0].published -ne $wiring.WEB_CLIENT_PORT -or [string]$rendered.services.keycloak.ports[0].published -ne $wiring.WEB_KEYCLOAK_PORT) { throw 'Effective ports differ from the isolated environment file.' }
& (Join-Path $PSScriptRoot 'assert-isolated-owner.ps1') -ProjectName $wiring.COMPOSE_PROJECT_NAME -ProjectRoot $root

function Wait-Http([string]$uri, [string]$name) {
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 5
        } catch {
            $response = $null
        }
        if ($null -ne $response -and $response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            Write-Host "PASS: $name is ready."
            return
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$name did not become ready within two minutes: $uri"
}

function Wait-Stack {
    Wait-Http "http://127.0.0.1:$($wiring.WEB_CLIENT_PORT)/" 'Client'
    Wait-Http "http://127.0.0.1:$($wiring.WEB_KEYCLOAK_PORT)/realms/harness/.well-known/openid-configuration" 'Keycloak realm'
}

if (-not (Test-Path -LiteralPath (Join-Path $root '.runtime\secrets\keycloak_dev_user_password'))) {
    throw 'Bootstrap secrets are missing. Run ./scripts/bootstrap.ps1 only after the bootstrap boundary is approved.'
}

docker @composeArgs --profile harness up --build -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Wait-Stack

docker @composeArgs --profile acceptance run --build --rm acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker @composeArgs --profile harness stop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker @composeArgs --profile harness start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Wait-Stack

docker @composeArgs --profile acceptance run --rm acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot 'verify-boundaries.ps1') -EnvironmentFile $environmentFile
Write-Host 'PASS: full browser acceptance and persistence across compose stop/start.'
