param([string]$EnvironmentFile)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gateway = Join-Path $root 'src\Gateway'
$forbidden = rg -n -i 'MongoDB|MongoClient|EntityFramework|DbContext|ConnectionString' $gateway
if ($LASTEXITCODE -eq 0) {
    Write-Error "Gateway DB-boundary violation:`n$forbidden"
}
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }

$gatewayProgram = Get-Content (Join-Path $gateway 'Program.cs') -Raw
foreach ($required in @(
    'MapGet("/api/projections/nodes"',
    'MapGet("/api/projections/work"',
    'MapGet("/api/projections/history"',
    'context.Request.QueryString'
)) {
    if (-not $gatewayProgram.Contains($required)) {
        throw "Gateway proxy boundary is missing required allowlist/query behavior: $required"
    }
}

$composeArgs = @('compose')
if ($EnvironmentFile) { $composeArgs += @('--env-file', $EnvironmentFile) }
$composeJson = docker @composeArgs -f (Join-Path $root 'compose.yaml') --profile harness config --format json
if ($LASTEXITCODE -ne 0) { throw 'Unable to render Compose configuration.' }
$compose = $composeJson | ConvertFrom-Json

foreach ($serviceName in @('cursor-harness', 'codex-harness')) {
    $service = $compose.services.$serviceName
    if ($null -eq $service) { throw "Missing $serviceName service." }
    if ($null -ne $service.ports -and $service.ports.Count -gt 0) {
        throw "$serviceName must not publish host ports."
    }
    $networkNames = @($service.networks.PSObject.Properties.Name)
    if (($networkNames | Sort-Object) -join ',' -ne 'harness,provider-egress') {
        throw "$serviceName must use only the private Harness network and provider egress."
    }
}

foreach ($serviceName in @('client', 'gateway')) {
    $networkNames = @($compose.services.$serviceName.networks.PSObject.Properties.Name)
    if ($networkNames -contains 'harness' -or $networkNames -contains 'provider-egress') {
        throw "$serviceName must not be attached to the harness network."
    }
}

$adapterNetworks = @($compose.services.adapter.networks.PSObject.Properties.Name)
if ($adapterNetworks -notcontains 'harness' -or $adapterNetworks -notcontains 'internal') {
    throw 'Adapter must be the sole bridge between internal and harness networks.'
}

$published = @($compose.services.PSObject.Properties | Where-Object {
    $null -ne $_.Value.ports -and $_.Value.ports.Count -gt 0
} | ForEach-Object Name | Sort-Object)
if (($published -join ',') -ne 'client,keycloak') {
    throw "Only Client and Keycloak may publish ports; found: $($published -join ', ')"
}

Write-Host 'PASS: Gateway has no DB access, API prefix/query is preserved, browser-facing services cannot reach Harness, and Harness has provider egress without published ports.'
