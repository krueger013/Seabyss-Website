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
        throw 'The Redis self-test found an invalid Canary_02 V2 state binding.'
    }
    $binding = [ordered]@{}
    foreach ($item in $basis.GetEnumerator()) { $binding[$item.Key] = $item.Value }
    $binding['bindingHash'] = [string]$State.bindingHash
    return $binding | ConvertTo-Json -Depth 4 -Compress
}

$runtimeDir = Join-Path $RuntimeRoot 'runtime'
$credentialPath = Join-Path $runtimeDir 'credential.clixml'
$statePath = Join-Path $runtimeDir 'state.json'
$cli = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai-cli.exe'))
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $statePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'The isolated financial canary Redis instance is not initialized.'
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$resolvedRoot = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'SeabyssCodex\financial-canary-memurai\canary02-v2')).TrimEnd('\')
if (-not $resolvedRoot.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The Redis self-test refuses a root outside Canary_02 V2.'
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
    throw 'The Redis self-test is not bound to the exact canary02 runtime.'
}
$expectedBindingJson = Get-BindingJson $state
$hostName = [string]$state.host
$port = [int]$state.port

$oldCliAuth = $env:REDISCLI_AUTH
try {
    $env:REDISCLI_AUTH = $null
    $unauthenticated = (& $cli --raw -h $hostName -p $port PING 2>&1) -join "`n"
    if ($unauthenticated -notmatch 'NOAUTH|Authentication required') {
        throw 'Unauthenticated Redis commands were not rejected.'
    }

    $securePassword = Import-Clixml -LiteralPath $credentialPath
    $env:REDISCLI_AUTH = ConvertTo-PlainText $securePassword
    $pong = (& $cli --raw -h $hostName -p $port --user canary PING) -join ''
    if ($pong -ne 'PONG') {
        throw 'Authenticated Redis PING failed.'
    }

    $testId = [Guid]::NewGuid().ToString('N')
    $valueKey = "seabyss:financial-canary:selftest:value:$testId"
    $leaseKey = "seabyss:financial-canary:selftest:lease:$testId"
    try {
        $setResult = (& $cli --raw -h $hostName -p $port --user canary SET $valueKey expected-value PX 10000 NX) -join ''
        $getResult = (& $cli --raw -h $hostName -p $port --user canary GET $valueKey) -join ''
        $ttlResult = [int]((& $cli --raw -h $hostName -p $port --user canary PTTL $valueKey) -join '')
        $lua = "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])"
        $claimResult = (& $cli --raw -h $hostName -p $port --user canary EVAL $lua 1 $leaseKey owner-a 10000) -join ''
        $loserResult = (& $cli --raw -h $hostName -p $port --user canary EVAL $lua 1 $leaseKey owner-b 10000) -join ''
        if ($setResult -ne 'OK' -or $getResult -ne 'expected-value' -or $ttlResult -le 0) {
            throw 'SET/GET/TTL verification failed.'
        }
        if ($claimResult -ne 'OK' -or $loserResult) {
            throw 'Lua atomic claim verification failed.'
        }
    }
    finally {
        & $cli --raw -h $hostName -p $port --user canary DEL $valueKey $leaseKey | Out-Null
    }

    $serverInfo = (& $cli --raw -h $hostName -p $port --user canary INFO server) -join "`n"
    $persistenceInfo = (& $cli --raw -h $hostName -p $port --user canary INFO persistence) -join "`n"
    $runtimeIdentity = (& $cli --raw -h $hostName -p $port --user canary GET 'seabyss:financial-canary:runtime-identity:v2') -join ''
    $datasetBinding = (& $cli --raw -h $hostName -p $port --user canary GET 'seabyss:financial-canary:dataset-binding:v2') -join ''
    $configValues = (& $cli --raw -h $hostName -p $port --user canary CONFIG GET appendonly appendfsync appenddirname appendfilename dbfilename save dir maxmemory-policy bind protected-mode) -join "`n"
    $version = [regex]::Match($serverInfo, '(?m)^(?:redis_version|memurai_api_version):([^\r\n]+)').Groups[1].Value
    $aofEnabled = $persistenceInfo -match '(?m)^aof_enabled:1$'
    $safeConfig = $configValues -match '(?m)^appendonly\nyes$' -and
        $configValues -match '(?m)^appendfsync\nalways$' -and
        $configValues -match '(?m)^appenddirname\nappendonlydir$' -and
        $configValues -match '(?m)^appendfilename\nfinancial-canary\.aof$' -and
        $configValues -match '(?m)^dbfilename\nfinancial-canary\.rdb$' -and
        $configValues -match '(?m)^save\n60 1$' -and
        $configValues -match '(?m)^maxmemory-policy\nnoeviction$' -and
        $configValues -match '(?m)^protected-mode\nyes$' -and
        $runtimeIdentity -eq [string]$state.runtimeId -and
        $datasetBinding -eq $expectedBindingJson

    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    $loopbackOnly = @($listeners).Count -gt 0 -and @($listeners | Where-Object {
        $_.LocalAddress -notin @('127.0.0.1', '::1')
    }).Count -eq 0
    if (-not $aofEnabled -or -not $safeConfig -or -not $loopbackOnly) {
        throw 'Redis persistence, noeviction, protected mode, or loopback binding verification failed.'
    }

    [pscustomobject]@{
        Status = 'pass'
        RedisApiVersion = $version
        AuthRequired = $true
        Ping = 'PONG'
        SetGetTtl = 'pass'
        LuaAtomicClaim = 'pass'
        AofEnabled = $aofEnabled
        MaxmemoryPolicy = 'noeviction'
        ProtectedMode = $true
        LoopbackOnly = $loopbackOnly
        PersistenceDirectory = (Join-Path $runtimeDir 'data')
        SandboxTitleId = '1D0C16'
        CanaryPlayFabId = 'C5BD37AA141B3C4E'
        RuntimeIdHash = [string]$state.runtimeIdHash
        DatasetIdHash = [string]$state.datasetIdHash
        BindingHash = [string]$state.bindingHash
    }
}
finally {
    $env:REDISCLI_AUTH = $oldCliAuth
}
