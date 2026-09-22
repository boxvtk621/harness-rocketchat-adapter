[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$environmentFile = Join-Path $root '.runtime/acceptance.env'
if (-not (Test-Path -LiteralPath $environmentFile)) { throw 'Bootstrap a dedicated hl306-* project first.' }
$wiring = @{}
Get-Content -LiteralPath $environmentFile | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { $wiring[$matches[1]] = $matches[2] } }
if ($wiring.COMPOSE_PROJECT_NAME -notmatch '^hl306-[a-z0-9-]+$' -or $wiring.HL304_VOLUME_PREFIX -ne $wiring.COMPOSE_PROJECT_NAME -or $wiring.ACCEPTANCE_ISOLATED -ne 'true') { throw 'Dedicated HL-306 project required.' }
& (Join-Path $PSScriptRoot 'assert-isolated-owner.ps1') -ProjectName $wiring.COMPOSE_PROJECT_NAME -ProjectRoot $root
$composeArgs = @('compose','--env-file',$environmentFile,'--project-directory',$root,'-f',(Join-Path $root 'compose.yaml'),'-f',(Join-Path $root 'compose.auth-test.yaml'))
$effective = docker @composeArgs --profile harness --profile acceptance config --format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $effective.name -ne $wiring.COMPOSE_PROJECT_NAME) { throw 'Compose project mismatch.' }
foreach ($resource in @($effective.volumes.PSObject.Properties) + @($effective.networks.PSObject.Properties)) {
    if (-not $resource.Value.name.StartsWith($wiring.COMPOSE_PROJECT_NAME + '-')) { throw 'Resource is outside this project.' }
}
if ($wiring.WEB_CLIENT_PORT -eq '18100' -or $wiring.WEB_KEYCLOAK_PORT -eq '18180') { throw 'Working-stack ports are forbidden.' }
$build = @(if (-not $SkipBuild) { '--build' })
docker @composeArgs --profile harness up @build -d
if ($LASTEXITCODE -ne 0) { throw 'Auth stack startup failed.' }
docker @composeArgs up --no-deps --no-build --force-recreate -d auth-fixture
if ($LASTEXITCODE -ne 0) { throw 'Controlled fixture refresh failed.' }
docker @composeArgs --profile acceptance run @build --no-deps --rm acceptance
if ($LASTEXITCODE -ne 0) { throw 'Controlled auth acceptance failed.' }
docker @composeArgs --profile acceptance run --no-deps --rm acceptance node auth-real-smoke.mjs
if ($LASTEXITCODE -ne 0) { throw 'Real Harness unauthenticated smoke failed.' }
docker @composeArgs --profile acceptance run --no-deps --rm acceptance node auth-restart-smoke.mjs before
if ($LASTEXITCODE -ne 0) { throw 'Auth ledger capture failed.' }
docker @composeArgs --profile harness stop
if ($LASTEXITCODE -ne 0) { throw 'Own stack stop failed.' }
docker @composeArgs --profile harness start
if ($LASTEXITCODE -ne 0) { throw 'Own stack restart failed.' }
docker @composeArgs --profile harness up --no-deps --no-build --force-recreate -d cursor-harness codex-harness
if ($LASTEXITCODE -ne 0) { throw 'Own Harness recreation failed.' }
docker @composeArgs --profile acceptance run --no-deps --rm acceptance node auth-restart-smoke.mjs after
if ($LASTEXITCODE -ne 0) { throw 'Auth ledger recreation check failed.' }
docker @composeArgs --profile acceptance run --no-deps --rm acceptance
if ($LASTEXITCODE -ne 0) { throw 'Auth acceptance after restart failed.' }
docker @composeArgs --profile acceptance run --no-deps --rm acceptance node auth-real-smoke.mjs
if ($LASTEXITCODE -ne 0) { throw 'Real Harness smoke after restart failed.' }
& (Join-Path $PSScriptRoot 'verify-boundaries.ps1') -EnvironmentFile $environmentFile
Write-Host 'PASS: controlled auth acceptance and real unauthenticated Harness smoke before/after restart. Real provider login requires owner participation.'
