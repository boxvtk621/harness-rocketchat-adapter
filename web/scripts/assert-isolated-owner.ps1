param([Parameter(Mandatory=$true)][string]$ProjectName, [Parameter(Mandatory=$true)][string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath($ProjectRoot).Replace('\','/').TrimEnd('/')
$ids = @(docker ps -aq --filter "label=com.docker.compose.project=$ProjectName")
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Compose ownership.' }
$mountedVolumes = @{}
$attachedNetworks = @{}
foreach ($id in $ids) {
    $container = @(docker inspect $id | ConvertFrom-Json)[0]
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect a project container.' }
    $owner = $container.Config.Labels.'com.docker.compose.project.working_dir'
    if (-not $owner -or $owner.Replace('\','/').TrimEnd('/') -ne $expected) { throw 'Compose project belongs to another working directory.' }
    foreach ($mount in $container.Mounts) { if ($mount.Type -eq 'volume') { $mountedVolumes[$mount.Name] = $true } }
    foreach ($network in $container.NetworkSettings.Networks.PSObject.Properties) { $attachedNetworks[$network.Name] = $true }
}
foreach ($kind in @('volume','network')) {
    $names = @(docker $kind ls --format '{{.Name}}')
    if ($LASTEXITCODE -ne 0) { throw "Could not list Docker $kind resources." }
    $suffixes = if ($kind -eq 'volume') { @('mongodb-data','keycloak-data','cursor-harness-data','codex-harness-data','cursor-provider-auth','codex-provider-auth') } else { @('web','internal','harness','provider-egress') }
    foreach ($suffix in $suffixes) {
        $name = "$ProjectName-$suffix"
        if ($names -notcontains $name) { continue }
        $resource = @(docker $kind inspect $name | ConvertFrom-Json)[0]
        if ($LASTEXITCODE -ne 0) { throw "Could not inspect $name." }
        if ($resource.Labels.'com.docker.compose.project' -ne $ProjectName) { throw "Existing $kind has another owner: $name" }
        $owner = $resource.Labels.'homelab.worktree'
        if ($owner) {
            if ($owner.Replace('\','/').TrimEnd('/') -ne $expected) { throw "Existing $kind belongs to another worktree: $name" }
        } else {
            # Backward compatibility only when current, verified containers prove use.
            # Detached legacy volumes without an owner must never be silently adopted.
            $proven = if ($kind -eq 'volume') { $mountedVolumes.ContainsKey($name) } else { $attachedNetworks.ContainsKey($name) }
            if (-not $proven) { throw "Existing $kind has no provable worktree owner: $name" }
        }
    }
}
