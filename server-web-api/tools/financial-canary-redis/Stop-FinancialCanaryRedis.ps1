[CmdletBinding()]
param(
    [string]$RuntimeRoot = "$env:LOCALAPPDATA\SeabyssCodex\financial-canary-memurai\canary02-v2",
    [string]$MemuraiRoot = "$env:LOCALAPPDATA\SeabyssCodex\financial-canary-memurai\package\Memurai"
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PlainText {
    param([Parameter(Mandatory)][Security.SecureString]$SecureString)

    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}

function Get-TextHash {
    param([Parameter(Mandatory)][string]$Value)

    return [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))
    ).ToLowerInvariant()
}

function Get-BindingJson {
    param([Parameter(Mandatory)]$State)

    $basis = [ordered]@{
        schemaVersion = 2
        instanceId = 'canary02-v2'
        sandboxTitleId = '1D0C16'
        canaryPlayFabId = 'C5BD37AA141B3C4E'
        environment = 'sandbox'
        runtimeId = [string]$State.runtimeId
        datasetId = [string]$State.datasetId
        runtimeRoot = [IO.Path]::GetFullPath([string]$State.runtimeRoot).TrimEnd('\').Replace('\', '/').ToLowerInvariant()
        dataDirectory = [IO.Path]::GetFullPath([string]$State.dataDirectory).TrimEnd('\').Replace('\', '/').ToLowerInvariant()
        aofManifestPath = [IO.Path]::GetFullPath([string]$State.aofManifestPath).Replace('\', '/').ToLowerInvariant()
        rdbPath = [IO.Path]::GetFullPath([string]$State.rdbPath).Replace('\', '/').ToLowerInvariant()
        createdAt = [string]$State.createdAt
    }
    $basisJson = $basis | ConvertTo-Json -Depth 4 -Compress
    if ((Get-TextHash $basisJson) -ne [string]$State.bindingHash -or
        (Get-TextHash ([string]$State.runtimeId)) -ne [string]$State.runtimeIdHash -or
        (Get-TextHash ([string]$State.datasetId)) -ne [string]$State.datasetIdHash) {
        throw 'Refusing a Canary_02 V2 state file with an invalid identity or binding hash.'
    }
    $binding = [ordered]@{}
    foreach ($item in $basis.GetEnumerator()) { $binding[$item.Key] = $item.Value }
    $binding['bindingHash'] = [string]$State.bindingHash
    return $binding | ConvertTo-Json -Depth 4 -Compress
}

$runtimeDir = Join-Path $RuntimeRoot 'runtime'
$credentialPath = Join-Path $runtimeDir 'credential.clixml'
$statePath = Join-Path $runtimeDir 'state.json'
$memuraiExe = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai.exe'))
$memuraiCli = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai-cli.exe'))

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    [pscustomobject]@{ Status = 'not_running' }
    return
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$resolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SeabyssCodex\financial-canary-memurai\canary02-v2')).TrimEnd('\')
if (-not $resolvedRoot.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stop Redis outside the exact Canary_02 V2 root.'
}
if ([int]$state.schemaVersion -ne 2 -or [string]$state.instanceId -ne 'canary02-v2' -or
    [string]$state.sandboxTitleId -ne '1D0C16' -or
    [string]$state.canaryPlayFabId -ne 'C5BD37AA141B3C4E' -or
    [string]$state.environment -ne 'sandbox' -or
    [int]$state.port -ne 6398 -or
    -not [IO.Path]::GetFullPath([string]$state.runtimeRoot).TrimEnd('\').Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.configPath).Equals((Join-Path $resolvedRoot 'runtime\memurai-financial-canary.conf'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.dataDirectory).Equals((Join-Path $resolvedRoot 'runtime\data'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.aofManifestPath).Equals((Join-Path $resolvedRoot 'runtime\data\appendonlydir\financial-canary.aof.manifest'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.rdbPath).Equals((Join-Path $resolvedRoot 'runtime\data\financial-canary.rdb'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to stop Redis without the exact canary02 runtime binding.'
}
$expectedBindingJson = Get-BindingJson $state
$process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
if (-not $process) {
    [pscustomobject]@{ Status = 'already_stopped'; PreviousProcessId = [int]$state.pid }
    return
}
if (-not [IO.Path]::GetFullPath($process.Path).Equals($memuraiExe, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stop process $($process.Id): executable is not the isolated Memurai binary."
}
$commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
if ([string]$commandLine -notlike "*$($state.configPath)*") {
    throw 'Refusing to stop a Redis process started with another config.'
}
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw 'Refusing to stop Redis without the protected canary02 credential; persistence cannot be confirmed.'
}

$oldCliAuth = $env:REDISCLI_AUTH
try {
    $securePassword = Import-Clixml -LiteralPath $credentialPath
    $env:REDISCLI_AUTH = ConvertTo-PlainText $securePassword
    $runtimeId = (& $memuraiCli --raw -h $state.host -p ([int]$state.port) --user canary GET 'seabyss:financial-canary:runtime-identity:v2') -join ''
    $datasetBinding = (& $memuraiCli --raw -h $state.host -p ([int]$state.port) --user canary GET 'seabyss:financial-canary:dataset-binding:v2') -join ''
    if ($runtimeId -ne [string]$state.runtimeId -or $datasetBinding -ne $expectedBindingJson) {
        throw 'Refusing to persist or stop Redis with another Canary_02 V2 dataset binding.'
    }
    $aof = @(& $memuraiCli --raw -h $state.host -p ([int]$state.port) --user canary WAITAOF 1 0 5000)
    if ($LASTEXITCODE -ne 0 -or @($aof).Count -lt 1 -or [int]$aof[0] -lt 1) {
        throw 'Redis did not confirm local AOF fsync; shutdown refused.'
    }
    & $memuraiCli --raw -h $state.host -p ([int]$state.port) --user canary SAVE | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Redis RDB snapshot failed; shutdown refused.' }
    & $memuraiCli --raw -h $state.host -p ([int]$state.port) --user canary SHUTDOWN NOSAVE 2>$null | Out-Null

    $process.WaitForExit(5000) | Out-Null
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(5000) | Out-Null
    }

    [pscustomobject]@{
        Status = 'stopped'
        ProcessId = [int]$state.pid
        PersistenceKept = $true
        AofFsyncConfirmed = $true
        RdbSnapshotConfirmed = $true
        RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
        RuntimeIdHash = [string]$state.runtimeIdHash
        DatasetIdHash = [string]$state.datasetIdHash
        BindingHash = [string]$state.bindingHash
    }
}
finally {
    $env:REDISCLI_AUTH = $oldCliAuth
}
