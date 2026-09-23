[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('prepare','up','update','status','stop','rollback')][string]$Action,
    [string]$HomeLabRoot,
    [string]$RuntimeRoot,
    [string]$AdoptProject,
    [string]$PinnedRevisions,
    [switch]$BuildOnly,
    [switch]$Requested
)
$ErrorActionPreference = 'Stop'
$project = 'harness-dev'
$services = @('client','gateway','adapter','mongodb','keycloak','centrifugo','cursor-harness','codex-harness')
$ingress = @('client','gateway','adapter')
$repositories = @('harness-rocketchat-adapter','harness-cursor','harness-codex')
$webRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $webRoot 'dev/compose.yaml'
$probeScript = Join-Path $webRoot 'dev/probe.mjs'
if (-not $HomeLabRoot) {
    $ancestor = Get-Item $webRoot
    while ($ancestor -and -not (Test-Path (Join-Path $ancestor.FullName 'harness-cursor/.git'))) { $ancestor = $ancestor.Parent }
    if (-not $ancestor) { throw 'Pass -HomeLabRoot with the three main repositories.' }
    $HomeLabRoot = $ancestor.FullName
}
$HomeLabRoot = [IO.Path]::GetFullPath($HomeLabRoot)
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $HomeLabRoot 'harness-rocketchat-adapter/web/.runtime/dev' }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if ($RuntimeRoot -match '[\r\n]' -or $RuntimeRoot -notmatch '[\\/]\.runtime[\\/]dev$') { throw 'RuntimeRoot must be an explicit ignored .runtime/dev directory.' }
$stateFile = Join-Path $RuntimeRoot 'deployment.json'
if ($Action -ne 'status' -and -not $Requested) { throw 'Mutations require -Requested, used only for an explicit user request. No task completion hooks or timers.' }
if ($AdoptProject -and $Action -ne 'prepare') { throw '-AdoptProject is only valid during prepare.' }
if ($BuildOnly -and $Action -ne 'prepare') { throw '-BuildOnly is only valid with prepare; it never stops or starts services.' }
function Native([string]$Exe,[string[]]$Arguments) {
    $application = @(Get-Command $Exe -CommandType Application -ErrorAction Stop)[0].Source
    $result = & $application @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit $LASTEXITCODE)." }
    return $result
}
function DockerJson([string[]]$Arguments) { return ((Native docker $Arguments) -join "`n" | ConvertFrom-Json -AsHashtable) }
function Git([string]$Repo,[string[]]$Arguments) { return Native git (@('-c',"safe.directory=$Repo",'-C',$Repo)+$Arguments) }
function SaveJson([string]$Path,$Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path+'.new',($Value|ConvertTo-Json -Depth 60)+"`n",[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($Path+'.new',$Path,$true)
}
function WriteOnce([string]$Relative,[string]$Content) {
    $path=Join-Path $RuntimeRoot $Relative
    if (-not (Test-Path $path)) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))|Out-Null; [IO.File]::WriteAllText($path,$Content.Replace("`r`n","`n"),[Text.UTF8Encoding]::new($false)) }
}
function CopyOnce([string]$Source,[string]$Relative) {
    $target=Join-Path $RuntimeRoot $Relative
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Missing bootstrap input: $Relative" }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    if (-not (Test-Path $target)) { Copy-Item -LiteralPath $Source -Destination $target }
    if ((Get-FileHash -LiteralPath $Source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Existing bootstrap differs: $Relative. Never rotate implicitly." }
}
function Containers([string]$ProjectName) {
    $ids=@(Native docker @('ps','-aq','--filter',"label=com.docker.compose.project=$ProjectName"))
    if (-not $ids.Count) { return @() }
    return @(DockerJson (@('inspect')+$ids))
}
function Probe([string]$ProjectName) {
    $value=Native docker @('run','--rm','--network',"$ProjectName-harness",'--mount',"type=bind,source=$RuntimeRoot,target=/runtime,readonly",'--mount',"type=bind,source=$probeScript,target=/probe.mjs,readonly",$script:state.toolImage,'node','/probe.mjs')
    return ($value -join "`n"|ConvertFrom-Json -AsHashtable)
}
function AssertIdle([string]$ProjectName) {
    $snapshot=Probe $ProjectName
    SaveJson (Join-Path $RuntimeRoot 'last-preflight.json') $snapshot
    if (-not $snapshot.safeToStop) { throw 'Switch deferred: active, queued, unknown execution, pending login, or unavailable node. Nothing is cancelled or replayed. See last-preflight.json.' }
    return $snapshot
}
function AssertOwners([string[]]$Allowed) {
    $ids=@(Native docker @('ps','-q'))
    foreach($id in $ids) {
        $c=@(DockerJson @('inspect',$id))[0]
        if (@($c.Mounts|Where-Object { $_.Type -eq 'volume' -and $_.Name -in @($script:state.volumes.Values) }).Count -and $c.Id -notin $Allowed) { throw "Another running container owns adopted storage: $($c.Name)" }
    }
}
function StopSafely([string]$ProjectName) {
    $all=@(Containers $ProjectName|Where-Object {$_.State.Running})
    if (-not $all.Count) { return $null }
    $before=AssertIdle $ProjectName
    $front=@($all|Where-Object {$_.Config.Labels.'com.docker.compose.service' -in $ingress}|ForEach-Object Id)
    if ($front.Count) { Native docker (@('stop','--time','30')+$front)|Out-Host }
    try { $null=AssertIdle $ProjectName } catch { if($front.Count){Native docker (@('start')+$front)|Out-Host};throw }
    $back=@($all|Where-Object {$_.Id -notin $front}|ForEach-Object Id)
    if($back.Count){Native docker (@('stop','--time','30')+$back)|Out-Host}
    AssertOwners @()
    return $before
}
function Sources {
    $pins=if($PinnedRevisions){Get-Content $PinnedRevisions -Raw|ConvertFrom-Json -AsHashtable}else{@{}}
    if($pins.Count -and (($pins.Keys|Sort-Object) -join ',') -ne (($repositories|Sort-Object) -join ',')){throw 'PinnedRevisions must specify all three repositories.'}
    $result=@{}
    foreach($name in $repositories){
        $path=Join-Path $HomeLabRoot $name
        if((Git $path @('branch','--show-current')) -ne 'main'){throw "$name is not on main."}
        if(@(Git $path @('status','--porcelain','--untracked-files=all')).Count){throw "$name main is dirty. Integrate separately; no implicit branch mix."}
        $head=(Git $path @('rev-parse','HEAD')).Trim()
        $revision=if($pins.Count){$pins[$name]}else{$head}
        if($revision -notmatch '^[a-f0-9]{40}$'){throw 'Pinned revisions must be exact commit SHA values.'}
        $null=Git $path @('cat-file','-e',"$revision^{commit}")
        $result[$name]=@{path=$path;mainHead=$head;revision=$revision}
    }
    return $result
}
function ValidateRuntime {
    foreach($kind in @('cursor','codex')){
        $cfg=Get-Content (Join-Path $RuntimeRoot "harness/$kind-node.json") -Raw|ConvertFrom-Json
        if($cfg.manualDispatchForTesting -or $cfg.approvalMode -ne 'explicit_once' -or $cfg.$kind.model -match 'fixture|test-model' -or $cfg.policyRevision -match 'fixture'){throw 'Dev rejects manual dispatch and fixture/deny-tools configuration.'}
        if($cfg.toolManifestFile -ne '/config/tools-explicit.json' -or $cfg.$kind.workingDir -ne '/workspace'){throw 'Unexpected Harness bootstrap wiring.'}
    }
}
function Compose([string]$Release,[string[]]$Arguments) {
    return Native docker (@('compose','--project-name',$project,'--project-directory',$RuntimeRoot,'--env-file',(Join-Path $Release 'release.env'),'-f',(Join-Path $Release 'compose.yaml'))+$Arguments)
}
function BuildRelease {
    ValidateRuntime
    $sources=Sources
    $release=Join-Path $RuntimeRoot ('releases/'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    [IO.Directory]::CreateDirectory($release)|Out-Null
    $manifest=@{createdAt=[DateTime]::UtcNow.ToString('o');sources=$sources;images=@{};volumes=$script:state.volumes;orchestratorSha256=(Get-FileHash $template).Hash}
    foreach($name in $repositories){
        $archive=Join-Path $release ($name+'.tar');$dest=Join-Path $release $name
        [IO.Directory]::CreateDirectory($dest)|Out-Null
        $null=Git $sources[$name].path @('-c','core.autocrlf=false','archive','--format=tar',"--output=$archive",$sources[$name].revision)
        Native docker @('run','--rm','--mount',"type=bind,source=$release,target=/release",$script:state.toolImage,'tar','-xf',"/release/$name.tar",'-C',"/release/$name")|Out-Host
    }
    $builds=@{client=@('harness-rocketchat-adapter','web/src/Client','Dockerfile');gateway=@('harness-rocketchat-adapter','web/src/Gateway','Dockerfile');adapter=@('harness-rocketchat-adapter','','Dockerfile');'cursor-harness'=@('harness-cursor','','delivery/Dockerfile.cursor');'codex-harness'=@('harness-codex','','Dockerfile')}
    foreach($service in $builds.Keys){
        $spec=$builds[$service];$context=Join-Path (Join-Path $release $spec[0]) $spec[1];$revision=$sources[$spec[0]].revision
        $tag="harness-dev/${service}:$revision"
        & docker build --file (Join-Path $context $spec[2]) --tag $tag --label "org.opencontainers.image.revision=$revision" --build-arg "REVISION=$revision" $context *> (Join-Path $release "$service-build.log")
        if($LASTEXITCODE){throw "Build failed: $service (see release log); current deployment unchanged."}
        $img=@(DockerJson @('image','inspect',$tag))[0]
        $manifest.images[$service]=@{id=$img.Id;tag=$tag;repoDigests=$img.RepoDigests}
    }
    foreach($name in @('mongodb','keycloak','centrifugo')){
        $img=@(DockerJson @('image','inspect',$script:state.infrastructureImages[$name]))[0]
        $manifest.images[$name]=@{id=$img.Id;tag=$script:state.infrastructureImages[$name];repoDigests=$img.RepoDigests}
    }
    $after=Sources
    foreach($name in $repositories){if($after[$name].mainHead -ne $sources[$name].mainHead){throw 'Source main changed during build; do not switch.'}}
    Copy-Item -LiteralPath $template -Destination (Join-Path $release 'compose.yaml')
    $envLines=@('DEV_RUNTIME_ROOT='+$RuntimeRoot.Replace('\','/'))
    foreach($name in $services){$envLines+='DEV_IMAGE_'+$name.Replace('-','_').ToUpper()+'='+$manifest.images[$name].id}
    foreach($name in $script:state.volumes.Keys){$envLines+='DEV_VOLUME_'+$name.Replace('-','_').ToUpper()+'='+$script:state.volumes[$name]}
    [IO.File]::WriteAllText((Join-Path $release 'release.env'),($envLines -join "`n")+"`n")
    SaveJson (Join-Path $release 'manifest.json') $manifest
    $effective=(Compose $release @('config','--format','json'))-join "`n"|ConvertFrom-Json -AsHashtable
    if($effective.name -ne $project -or $effective.services.Count -ne 8 -or $effective.services.ContainsKey('acceptance')){throw 'Invalid dev Compose boundary.'}
    foreach($volume in $effective.volumes.Values){if(-not $volume.external -or $volume.name -notin @($script:state.volumes.Values)){throw 'Unexpected storage in rendered Compose.'}}
    SaveJson (Join-Path $release 'effective-compose.json') $effective
    return $release
}
function Verify([string]$Release,$Before) {
    $until=[DateTime]::UtcNow.AddSeconds(120);$last='not started'
    do {
        try {
            $all=@(Containers $project)
            if($all.Count -ne 8 -or @($all|Where-Object {-not $_.State.Running}).Count){throw 'Not all eight services are running.'}
            $manifest=Get-Content (Join-Path $Release 'manifest.json') -Raw|ConvertFrom-Json -AsHashtable
            foreach($c in $all){if($c.Image -ne $manifest.images[$c.Config.Labels.'com.docker.compose.service'].id){throw 'Running image differs from release.'}}
            if((Invoke-WebRequest 'http://localhost:18707' -UseBasicParsing -TimeoutSec 5).StatusCode -ne 200){throw 'UI unavailable'}
            if((Invoke-WebRequest 'http://localhost:18787/realms/harness/.well-known/openid-configuration' -UseBasicParsing -TimeoutSec 5).StatusCode -ne 200){throw 'OIDC unavailable'}
            $after=Probe $project
            if(@($after.nodes|Where-Object {-not $_.available}).Count -or $after.registryError){throw 'Harness or registry API unavailable.'}
            if($Before){
                foreach($old in $Before.nodes){$new=@($after.nodes|Where-Object kind -eq $old.kind)[0];if($new.authState -ne $old.authState){throw 'Provider auth state changed; do not claim successful preservation.'}}
                if(($Before.registry|Sort-Object id|ConvertTo-Json -Depth 10 -Compress) -ne ($after.registry|Sort-Object id|ConvertTo-Json -Depth 10 -Compress)){throw 'Registry identity or settings changed.'}
            }
            SaveJson (Join-Path $RuntimeRoot 'last-status.json') $after
            return $after
        }catch{$last=$_.Exception.Message;Start-Sleep -Seconds 2}
    }while([DateTime]::UtcNow -lt $until)
    throw "Verification failed: $last"
}
function Adopt {
    if($AdoptProject -notmatch '^hl[0-9]+-live-[a-z0-9-]+$'){throw 'Adopt only an explicitly named live project, never an acceptance project.'}
    $all=@(Containers $AdoptProject)
    if($all.Count -ne 8){throw 'Adoption needs exactly eight existing live containers.'}
    $by=@{};foreach($c in $all){$name=$c.Config.Labels.'com.docker.compose.service';if($name -notin $services -or $by.ContainsKey($name)){throw 'Unexpected adoption service.'};$by[$name]=$c}
    $volumes=@{}
    $mountMap=@{'mongodb-data'=@('mongodb','/data/db');'keycloak-data'=@('keycloak','/opt/keycloak/data');'cursor-harness-data'=@('cursor-harness','/state');'codex-harness-data'=@('codex-harness','/state');'cursor-provider-auth'=@('cursor-harness','/provider-auth');'codex-provider-auth'=@('codex-harness','/provider-auth');'cursor-workspace'=@('cursor-harness','/workspace');'codex-workspace'=@('codex-harness','/workspace')}
    foreach($name in $mountMap.Keys){$spec=$mountMap[$name];$mount=@($by[$spec[0]].Mounts|Where-Object Destination -eq $spec[1]);if($mount.Count -ne 1 -or $mount[0].Type -ne 'volume'){throw "Invalid storage: $name"};$volumes[$name]=$mount[0].Name}
    $files=@{}
    foreach($c in $all){foreach($m in $c.Mounts){if($m.Type -ne 'bind'){continue};$relative=$null
        if($m.Destination -like '/run/secrets/*'){$name=Split-Path $m.Destination -Leaf;$relative=if($name -eq 'harness_server_key'){'harness/server.key'}else{'secrets/'+$name}}
        elseif($m.Destination -eq '/run/config/harness_server_cert' -or $m.Destination -eq '/etc/ssl/certs/hl304-harness.crt'){$relative='harness/server.crt'}
        elseif($m.Destination -eq '/usr/share/nginx/html/runtime-config.js'){$relative='client/runtime-config.js'}
        elseif($m.Destination -eq '/opt/keycloak/bootstrap/start.sh'){$relative='bootstrap/keycloak-start.sh'}
        elseif($m.Destination -eq '/opt/keycloak/data/import/harness-realm.json'){$relative='bootstrap/harness-realm.json'}
        elseif($m.Destination -eq '/centrifugo/bootstrap/start.sh'){$relative='bootstrap/centrifugo-start.sh'}
        elseif($m.Destination -eq '/config/node.json'){$relative='harness/'+$c.Config.Labels.'com.docker.compose.service'.Replace('-harness','')+'-node.json'}
        elseif($m.Destination -eq '/config/tools-explicit.json'){$relative='harness/'+$c.Config.Labels.'com.docker.compose.service'.Replace('-harness','')+'-tools.json'}
        elseif($m.Destination -eq '/config/policy.txt'){$relative='harness/policy.txt'}
        elseif($m.Destination -eq '/workspace/hl307-test.txt'){$relative='harness/hl307-test.txt'}
        if($relative){CopyOnce $m.Source $relative;$files[$relative]=(Get-FileHash -LiteralPath $m.Source).Hash}
    }}
    SaveJson (Join-Path $RuntimeRoot 'adoption-inventory.json') @{
        project=$AdoptProject;containers=@($all|ForEach-Object {@{id=$_.Id;service=$_.Config.Labels.'com.docker.compose.service';image=$_.Image;mounts=$_.Mounts}});files=$files
    }
    return @{schemaVersion=1;project=$project;sourceProject=$AdoptProject;sourceContainers=@($all|ForEach-Object Id);volumes=$volumes;infrastructureImages=@{mongodb=$by.mongodb.Image;keycloak=$by.keycloak.Image;centrifugo=$by.centrifugo.Image};toolImage=@(DockerJson @('image','inspect','node:24.18.0-bookworm-slim'))[0].Id;currentRelease=$null;previousRelease=$null}
}
function Fresh {
    $volumes=@{};foreach($name in @('mongodb-data','keycloak-data','cursor-harness-data','codex-harness-data','cursor-provider-auth','codex-provider-auth','cursor-workspace','codex-workspace')){
        $physical="$project-$name"
        if($physical -in @(Native docker @('volume','ls','--format','{{.Name}}'))){throw "Unregistered volume exists: $physical; adopt explicitly, never overwrite."}
        Native docker @('volume','create','--label','homelab.environment=harness-dev',$physical)|Out-Host;$volumes[$name]=$physical
    }
    foreach($name in @('adapter_internal_token','centrifugo_client_secret','centrifugo_api_key','keycloak_admin_password','keycloak_dev_user_password','keycloak_dev_viewer_password','mongodb_root_password')){WriteOnce "secrets/$name" ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower())}
    WriteOnce 'secrets/mongodb_root_username' 'harness_dev'
    $password=[IO.File]::ReadAllText((Join-Path $RuntimeRoot 'secrets/mongodb_root_password'))
    WriteOnce 'secrets/mongodb_connection_string' "mongodb://harness_dev:${password}@mongodb:27017/?authSource=admin"
    CopyOnce (Join-Path $webRoot 'infra/keycloak/start.sh') 'bootstrap/keycloak-start.sh'
    CopyOnce (Join-Path $webRoot 'infra/keycloak/harness-realm.json') 'bootstrap/harness-realm.json'
    CopyOnce (Join-Path $webRoot 'infra/centrifugo/start.sh') 'bootstrap/centrifugo-start.sh'
    WriteOnce 'client/runtime-config.js' 'window.__HARNESS_CONFIG__={"oidcAuthority":"http://localhost:18787/realms/harness","oidcClientId":"harness-web"};'
    foreach($kind in @('cursor','codex')){
        $cfg=Get-Content (Join-Path $webRoot "infra/harness/$kind-node.json") -Raw|ConvertFrom-Json
        $cfg.manualDispatchForTesting=$false;$cfg.approvalMode='explicit_once';$cfg.toolManifestFile='/config/tools-explicit.json';$cfg.policyRevision='harness-dev@1';$cfg.$kind.model=if($kind -eq 'cursor'){'composer-2.5'}else{'gpt-6-sol'}
        WriteOnce "harness/$kind-node.json" (($cfg|ConvertTo-Json -Depth 15)+"`n")
        WriteOnce "harness/$kind-tools.json" ('[{"name":"'+$kind+'.command"},{"name":"'+$kind+'.file_change"}]'+"`n")
    }
    WriteOnce 'harness/policy.txt' "Owner-driven local development. Use isolated tools; writes require explicit one-time approval. Never access credentials or unrelated host data.`n"
    WriteOnce 'harness/hl307-test.txt' "Harmless dev workspace marker. Per-dialog workspaces are isolated.`n"
    if(-not(Test-Path (Join-Path $RuntimeRoot 'harness/server.crt'))){Native docker @('run','--rm','--mount',"type=bind,source=$RuntimeRoot/harness,target=/out",'alpine/openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout','/out/server.key','-out','/out/server.crt','-days','365','-subj','/CN=harness-dev','-addext','subjectAltName=DNS:cursor-harness,DNS:codex-harness','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,digitalSignature,keyCertSign','-addext','extendedKeyUsage=serverAuth')|Out-Host}
    return @{schemaVersion=1;project=$project;sourceProject=$null;sourceContainers=@();volumes=$volumes;infrastructureImages=@{mongodb='mongo:8.0.16-noble';keycloak='quay.io/keycloak/keycloak:26.4.2';centrifugo='centrifugo/centrifugo:v5.4.8'};toolImage=@(DockerJson @('image','inspect','node:24.18.0-bookworm-slim'))[0].Id;currentRelease=$null;previousRelease=$null}
}
$lock=$null
try {
    if($Action -ne 'status'){
        [IO.Directory]::CreateDirectory($RuntimeRoot)|Out-Null
        $lock=[IO.File]::Open((Join-Path $RuntimeRoot 'lifecycle.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    if(Test-Path $stateFile){$script:state=Get-Content $stateFile -Raw|ConvertFrom-Json -AsHashtable}
    elseif($Action -eq 'prepare'){$script:state=if($AdoptProject){Adopt}else{Fresh};ValidateRuntime;SaveJson $stateFile $script:state}
    else{throw 'Run prepare first. No implicit bootstrap or volume adoption.'}
    if($Action -eq 'prepare'){
        if($AdoptProject -and $script:state.sourceProject -ne $AdoptProject){throw 'Already prepared for another owner.'}
        ValidateRuntime
        if($BuildOnly){$script:state.preparedRelease=BuildRelease;SaveJson $stateFile $script:state;Write-Output "Built candidate $($script:state.preparedRelease)."}
        Write-Output "Prepared $project at $RuntimeRoot. No services stopped or started.";return
    }
    if($Action -eq 'status'){
        $all=@(Containers $project)
        $report=@{project=$project;runtimeRoot=$RuntimeRoot;currentRelease=$script:state.currentRelease;preparedRelease=$script:state.preparedRelease;services=@($all|ForEach-Object {@{service=$_.Config.Labels.'com.docker.compose.service';running=$_.State.Running;image=$_.Image}})}
        if($script:state.currentRelease){$report.release=Get-Content (Join-Path $script:state.currentRelease 'manifest.json') -Raw|ConvertFrom-Json -AsHashtable}
        if(@($all|Where-Object {$_.State.Running}).Count -eq 8){$report.api=Probe $project}
        $report|ConvertTo-Json -Depth 20;return
    }
    if($Action -eq 'stop'){$null=StopSafely $project;Write-Output 'Stopped harness-dev; containers, data and credentials preserved.';return}
    $release=if($Action -eq 'rollback'){$script:state.previousRelease}elseif($Action -eq 'update' -or -not $script:state.currentRelease){BuildRelease}else{$script:state.currentRelease}
    if(-not $release){throw 'No previous release to roll back to; see adoption-inventory.json for original container IDs.'}
    $oldRelease=$script:state.currentRelease
    $owner=if(@(Containers $project|Where-Object {$_.State.Running}).Count){$project}elseif(-not $oldRelease -and $script:state.sourceProject){$script:state.sourceProject}else{$null}
    $allowed=if($owner){@(Containers $owner|Where-Object {$_.State.Running}|ForEach-Object Id)}else{@()}
    AssertOwners $allowed
    $before=if($owner){StopSafely $owner}else{$null}
    try{
        Compose $release @('up','-d','--no-build','--pull','never')|Out-Host
        $after=Verify $release $before
        if($oldRelease -ne $release){$script:state.previousRelease=$oldRelease}
        $script:state.currentRelease=$release
        SaveJson $stateFile $script:state
        Write-Output "Running harness-dev: http://localhost:18707; OIDC http://localhost:18787; release $release"
        $after|ConvertTo-Json -Depth 15
    }catch{
        $failure=$_.Exception.Message
        # Never roll back an executor which accepted work during the verification interval.
        $running=@(Containers $project|Where-Object {$_.State.Running})
        if($running.Count -eq 8){$null=StopSafely $project}elseif($running.Count){throw "Partial startup requires inspection; original owners remain stopped. $failure"}
        if($owner -eq $project -and $oldRelease){Compose $oldRelease @('up','-d','--no-build','--pull','never')|Out-Host}
        elseif($owner){Native docker (@('start')+$script:state.sourceContainers)|Out-Host}
        throw "Switch failed; rollback attempted only after idle verification. $failure"
    }
}finally{if($lock){$lock.Dispose()}}
