[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
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
        throw 'The command wrapper found an invalid Canary_02 V2 state binding.'
    }
    $binding = [ordered]@{}
    foreach ($item in $basis.GetEnumerator()) { $binding[$item.Key] = $item.Value }
    $binding['bindingHash'] = [string]$State.bindingHash
    return $binding | ConvertTo-Json -Depth 4 -Compress
}

$runtimeDir = Join-Path $RuntimeRoot 'runtime'
$credentialPath = Join-Path $runtimeDir 'credential.clixml'
$statePath = Join-Path $runtimeDir 'state.json'
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw 'The isolated financial canary Redis instance is not initialized.'
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$resolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SeabyssCodex\financial-canary-memurai\canary02-v2')).TrimEnd('\')
if (-not $resolvedRoot.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The command wrapper refuses a root outside Canary_02 V2.'
}
if ([int]$state.schemaVersion -ne 2 -or [string]$state.instanceId -ne 'canary02-v2' -or
    [string]$state.sandboxTitleId -ne '1D0C16' -or
    [string]$state.canaryPlayFabId -ne 'C5BD37AA141B3C4E' -or
    [string]$state.environment -ne 'sandbox' -or
    [string]$state.host -ne '127.0.0.1' -or [int]$state.port -ne 6398 -or
    -not [IO.Path]::GetFullPath([string]$state.runtimeRoot).TrimEnd('\').Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.configPath).Equals((Join-Path $resolvedRoot 'runtime\memurai-financial-canary.conf'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.dataDirectory).Equals((Join-Path $resolvedRoot 'runtime\data'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.aofManifestPath).Equals((Join-Path $resolvedRoot 'runtime\data\appendonlydir\financial-canary.aof.manifest'), [StringComparison]::OrdinalIgnoreCase) -or
    -not [IO.Path]::GetFullPath([string]$state.rdbPath).Equals((Join-Path $resolvedRoot 'runtime\data\financial-canary.rdb'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The command wrapper is not bound to the exact canary02 Redis runtime.'
}
$expectedBindingJson = Get-BindingJson $state
$securePassword = Import-Clixml -LiteralPath $credentialPath
$password = ConvertTo-PlainText $securePassword
$escapedUser = [Uri]::EscapeDataString('canary')
$escapedPassword = [Uri]::EscapeDataString($password)
$redisUrl = "redis://${escapedUser}:${escapedPassword}@$($state.host):$($state.port)/0"
$cli = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai-cli.exe'))
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'The isolated Memurai CLI is missing.'
}

$previous = @{
    TEST_REDIS_URL = $env:TEST_REDIS_URL
    REDIS_URL = $env:REDIS_URL
    FINANCIAL_REDIS_URL = $env:FINANCIAL_REDIS_URL
    SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT = $env:SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT
}
try {
    $previousCliAuth = $env:REDISCLI_AUTH
    $env:REDISCLI_AUTH = $password
    $runtimeIdentity = (& $cli --raw -h $state.host -p ([int]$state.port) --user canary GET 'seabyss:financial-canary:runtime-identity:v2') -join ''
    $datasetBinding = (& $cli --raw -h $state.host -p ([int]$state.port) --user canary GET 'seabyss:financial-canary:dataset-binding:v2') -join ''
    if ($runtimeIdentity -ne [string]$state.runtimeId -or $datasetBinding -ne $expectedBindingJson) {
        throw 'The command wrapper connected to another Canary_02 V2 dataset binding.'
    }
    $env:REDISCLI_AUTH = $previousCliAuth
    $env:TEST_REDIS_URL = $redisUrl
    $env:REDIS_URL = $redisUrl
    $env:FINANCIAL_REDIS_URL = $redisUrl
    $env:SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT = $resolvedRoot
    & $FilePath @ArgumentList
    exit $LASTEXITCODE
}
finally {
    $env:TEST_REDIS_URL = $previous.TEST_REDIS_URL
    $env:REDIS_URL = $previous.REDIS_URL
    $env:FINANCIAL_REDIS_URL = $previous.FINANCIAL_REDIS_URL
    $env:SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT = $previous.SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT
    $env:REDISCLI_AUTH = $previousCliAuth
    $password = $null
    $redisUrl = $null
}
