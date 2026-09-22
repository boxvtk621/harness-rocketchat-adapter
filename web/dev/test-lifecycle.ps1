$ErrorActionPreference='Stop'
$scriptPath=Join-Path $PSScriptRoot '../scripts/dev.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$functions=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
foreach($f in $functions){. ([scriptblock]::Create($f.Extent.Text))}
function Assert($Value,[string]$Message){if(-not $Value){throw $Message}}
function Reject([scriptblock]$Code,[string]$Message){$rejected=$false;try{& $Code|Out-Null}catch{$rejected=$true};Assert $rejected $Message}
$RuntimeRoot=Join-Path ([IO.Path]::GetTempPath()) ('dev-test-'+[Guid]::NewGuid())
[IO.Directory]::CreateDirectory($RuntimeRoot)|Out-Null
$originalOwners=${function:AssertOwners};$originalIdle=${function:AssertIdle}
$script:state=@{volumes=@{state='owned-state'}}
function Native([string]$Exe,[string[]]$Arguments){if($Arguments[0] -eq 'ps'){return '0123456789ab'};$script:calls.Add(($Arguments -join ' '))}
function DockerJson([string[]]$Arguments){return @(@{Id='0123456789abcdef';Name='owner';Mounts=@(@{Type='volume';Name='owned-state'})})}
AssertOwners @('0123456789abcdef')
Reject {AssertOwners @()} 'Foreign running storage owner was accepted'
$script:calls=[Collections.Generic.List[string]]::new()
$ingress=@('client','gateway','adapter')
$script:containers=@('client','gateway','adapter','cursor-harness','codex-harness','mongodb','keycloak','centrifugo')|ForEach-Object {@{Id=$_;State=@{Running=$true};Config=@{Labels=@{'com.docker.compose.service'=$_}}}}
function Containers([string]$ProjectName){return $script:containers}
function AssertOwners([string[]]$Allowed){}
function AssertIdle([string]$ProjectName){$script:gate++;if($script:gate -eq $script:failGate){throw 'busy'};return @{safeToStop=$true}}
$script:gate=0;$script:failGate=1
Reject {StopSafely 'harness-dev'} 'Initial busy gate ignored'
Assert ($script:calls.Count -eq 0) 'Busy first gate changed running services'
$script:gate=0;$script:failGate=2
Reject {StopSafely 'harness-dev'} 'Busy after freezing ingress ignored'
Assert ($script:calls.Count -eq 2) 'Expected stop/start of ingress only'
Assert (-not (($script:calls -join '|') -match 'cursor-harness|codex-harness|mongodb')) 'Race cancelled an executor or database'
$script:calls.Clear();$script:gate=0;$script:failGate=-1
$null=StopSafely 'harness-dev'
Assert ($script:gate -eq 2 -and $script:calls.Count -eq 2) 'Successful stop must gate twice and preserve container objects'
Assert ($script:calls[0] -eq 'stop --time 30 client gateway adapter') 'Ingress must stop before executors'
Assert ($script:calls[1].Contains('cursor-harness')) 'Executors were not stopped after second gate'
${function:AssertIdle}=$originalIdle
function Probe([string]$ProjectName){return @{safeToStop=$script:idle}}
$script:idle=$false;Reject {AssertIdle 'dev'} 'Unsafe probe allowed'
$script:idle=$true;$null=AssertIdle 'dev'
Assert (Test-Path (Join-Path $RuntimeRoot 'last-preflight.json')) 'Preflight evidence missing'
$HomeLabRoot='/source';$PinnedRevisions='';$repositories=@('harness-rocketchat-adapter','harness-cursor','harness-codex')
$script:branch='main';$script:dirty=$false
function Git([string]$Repo,[string[]]$Arguments){switch($Arguments[0]){'branch'{return $script:branch};'status'{if($script:dirty){return ' M changed'}};'rev-parse'{return ('a'*40)};'cat-file'{return}}}
$sources=Sources;Assert ($sources.Count -eq 3) 'Incomplete source lock'
$script:branch='codex/unmerged';Reject {Sources} 'Non-main source accepted'
$script:branch='main';$script:dirty=$true;Reject {Sources} 'Dirty source accepted'
$script:dirty=$false
$PinnedRevisions=Join-Path $RuntimeRoot 'pins.json';SaveJson $PinnedRevisions @{'harness-codex'=('a'*40)}
Reject {Sources} 'Partial revision override accepted'
$pins=@{};foreach($repo in $repositories){$pins[$repo]='b'*40};SaveJson $PinnedRevisions $pins
$sources=Sources;Assert ($sources.'harness-cursor'.revision -eq ('b'*40)) 'Explicit complete pins not retained'
foreach($kind in @('cursor','codex')){SaveJson (Join-Path $RuntimeRoot "harness/$kind-node.json") @{manualDispatchForTesting=$false;approvalMode='explicit_once';toolManifestFile='/config/tools-explicit.json';policyRevision='dev@1';$kind=@{model='real-model';workingDir='/workspace'}}}
ValidateRuntime
$cfg=Get-Content (Join-Path $RuntimeRoot 'harness/cursor-node.json') -Raw|ConvertFrom-Json -AsHashtable
$cfg.manualDispatchForTesting=$true;SaveJson (Join-Path $RuntimeRoot 'harness/cursor-node.json') $cfg
Reject {ValidateRuntime} 'Fixture dispatch accepted'
$cfg.manualDispatchForTesting=$false;$cfg.approvalMode='deny';SaveJson (Join-Path $RuntimeRoot 'harness/cursor-node.json') $cfg
Reject {ValidateRuntime} 'Deny-tools bootstrap accepted'
$cfg.approvalMode='explicit_once';$cfg.cursor.model='fixture-model';SaveJson (Join-Path $RuntimeRoot 'harness/cursor-node.json') $cfg
Reject {ValidateRuntime} 'Fixture model accepted'
$input=Join-Path $RuntimeRoot 'source.txt';[IO.File]::WriteAllText($input,'original')
CopyOnce $input 'copied.txt';CopyOnce $input 'copied.txt'
[IO.File]::WriteAllText($input,'changed');Reject {CopyOnce $input 'copied.txt'} 'Bootstrap rotated existing data'
Assert ([IO.File]::ReadAllText((Join-Path $RuntimeRoot 'copied.txt')) -eq 'original') 'Copy failure corrupted existing data'
WriteOnce 'kept.txt' 'first';WriteOnce 'kept.txt' 'second'
Assert ([IO.File]::ReadAllText((Join-Path $RuntimeRoot 'kept.txt')) -eq 'first') 'Repeat bootstrap rotated data'
$compose=Get-Content (Join-Path $PSScriptRoot 'compose.yaml') -Raw|ConvertFrom-Json -AsHashtable
Assert ($compose.name -eq 'harness-dev' -and $compose.services.Count -eq 8 -and -not $compose.services.ContainsKey('acceptance')) 'Dev compose includes acceptance'
Assert ($compose.volumes.Count -eq 8 -and @($compose.volumes.Values|Where-Object {-not $_.external}).Count -eq 0) 'Dev storage can be silently recreated'
Assert (@($compose.services.Keys|Where-Object {$compose.services[$_].ports}).Count -eq 2) 'Unexpected public service'
foreach($script in @('bootstrap.ps1','accept-auth.ps1')){Assert (-not ((Get-Content (Join-Path $PSScriptRoot "../scripts/$script") -Raw).Contains("'harness-dev'"))) 'Acceptance knows permanent project'}
Write-Output 'PASS: idle/race/ownership gates, clean main/exact pins, fixture refusal, idempotent secrets, external volumes, isolated acceptance; no real Docker mutations.'
