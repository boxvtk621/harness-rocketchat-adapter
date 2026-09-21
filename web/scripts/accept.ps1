[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'compose.yaml'
$marker = Join-Path $root 'output\acceptance\created-name.txt'

function Wait-Http([string]$uri, [string]$name) {
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    do {
        curl.exe -fsS $uri -o NUL 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "PASS: $name is ready."
            return
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$name did not become ready within two minutes: $uri"
}

function Wait-Stack {
    Wait-Http 'http://127.0.0.1:18000/' 'Client'
    Wait-Http 'http://127.0.0.1:18080/realms/harness/.well-known/openid-configuration' 'Keycloak realm'
}

if (-not (Test-Path -LiteralPath (Join-Path $root '.runtime\secrets\keycloak_dev_user_password'))) {
    throw 'Bootstrap secrets are missing. Run ./scripts/bootstrap.ps1 only after the bootstrap boundary is approved.'
}

docker compose --project-directory $root -f $compose up --build -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Wait-Stack

docker compose --project-directory $root -f $compose --profile acceptance run --build --rm acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath $marker)) { throw 'Acceptance run did not create its persistence marker.' }

docker compose --project-directory $root -f $compose stop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose --project-directory $root -f $compose start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Wait-Stack

docker compose --project-directory $root -f $compose --profile acceptance run --rm acceptance
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot 'verify-boundaries.ps1')
Write-Host 'PASS: full browser acceptance and persistence across compose stop/start.'
