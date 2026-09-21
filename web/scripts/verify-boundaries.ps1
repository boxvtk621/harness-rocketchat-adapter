$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gateway = Join-Path $root 'src\Gateway'
$forbidden = rg -n -i 'MongoDB|MongoClient|EntityFramework|DbContext|ConnectionString' $gateway
if ($LASTEXITCODE -eq 0) {
    Write-Error "Gateway DB-boundary violation:`n$forbidden"
}
if ($LASTEXITCODE -gt 1) { exit $LASTEXITCODE }
Write-Host 'PASS: Gateway contains no database driver, ORM, credential or connection-string references.'
