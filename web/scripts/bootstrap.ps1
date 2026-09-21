[CmdletBinding()]
param(
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$secretsDir = Join-Path $root '.runtime\secrets'
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

function New-RandomSecret([int]$bytes = 32) {
    $buffer = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
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

Write-Host 'Local bootstrap secrets are ready in the gitignored .runtime/secrets directory.'
Write-Host 'Keycloak user: operator'
Write-Host "Keycloak initial password: $devPassword"

if ($Start) {
    docker compose --project-directory $root -f (Join-Path $root 'compose.yaml') up --build -d
}
