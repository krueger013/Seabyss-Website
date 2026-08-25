[CmdletBinding()]
param(
    [ValidateRange(6398, 6398)][int]$Port = 6398,
    [string]$RuntimeRoot = "$env:LOCALAPPDATA\SeabyssCodex\financial-canary-memurai\canary02-v2",
    [string]$MemuraiRoot = "$env:LOCALAPPDATA\SeabyssCodex\financial-canary-memurai\package\Memurai"
)

$ErrorActionPreference = 'Stop'

function Assert-IsolatedRuntimeRoot {
    param([Parameter(Mandatory)][string]$Path)

    $allowedRoot = [IO.Path]::GetFullPath(
        [IO.Path]::Combine(
            [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),
            'SeabyssCodex',
            'financial-canary-memurai'
        )
    ).TrimEnd('\') + '\canary02-v2'
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not $resolved.Equals($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Redis test runtime must remain inside $allowedRoot"
    }

    return $resolved
}

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

function Get-PasswordHash {
    param([Parameter(Mandatory)][string]$Password)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Password)
    try {
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    }
    finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

$runtimeRoot = Assert-IsolatedRuntimeRoot $RuntimeRoot
$memuraiExe = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai.exe'))
$memuraiCli = [IO.Path]::GetFullPath((Join-Path $MemuraiRoot 'memurai-cli.exe'))
if (-not (Test-Path -LiteralPath $memuraiExe -PathType Leaf)) {
    throw "Memurai test binary is missing: $memuraiExe"
}
if (-not (Test-Path -LiteralPath $memuraiCli -PathType Leaf)) {
    throw "Memurai CLI is missing: $memuraiCli"
}

$runtimeDir = Join-Path $runtimeRoot 'runtime'
$dataDir = Join-Path $runtimeDir 'data'
$configPath = Join-Path $runtimeDir 'memurai-financial-canary.conf'
$aclPath = Join-Path $runtimeDir 'users.acl'
$credentialPath = Join-Path $runtimeDir 'credential.clixml'
$statePath = Join-Path $runtimeDir 'state.json'
$runtimeIdPath = Join-Path $runtimeDir 'runtime-id.txt'
$datasetIdPath = Join-Path $runtimeDir 'dataset-id.txt'
$bindingCreatedAtPath = Join-Path $runtimeDir 'binding-created-at.txt'
$logPath = Join-Path $runtimeDir 'memurai.log'
$pidPath = Join-Path $runtimeDir 'memurai.pid'

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$aofDirectory = Join-Path $dataDir 'appendonlydir'
$aofManifestPath = Join-Path $aofDirectory 'financial-canary.aof.manifest'
$rdbPath = Join-Path $dataDir 'financial-canary.rdb'
$hasPreexistingPersistence =
    (Test-Path -LiteralPath $rdbPath -PathType Leaf) -or
    (Test-Path -LiteralPath $aofManifestPath -PathType Leaf) -or
    (@(Get-ChildItem -LiteralPath $aofDirectory -Filter 'financial-canary.aof*' -File -ErrorAction SilentlyContinue).Count -gt 0)
$identityMetadataPaths = @($runtimeIdPath, $datasetIdPath, $bindingCreatedAtPath, $statePath)
$identityMetadataCount = @($identityMetadataPaths | Where-Object {
    Test-Path -LiteralPath $_ -PathType Leaf
}).Count
if ($hasPreexistingPersistence -and $identityMetadataCount -ne $identityMetadataPaths.Count) {
    throw 'Refusing to adopt pre-existing Redis V2 persistence without its complete durable binding metadata.'
}
if ($hasPreexistingPersistence -and -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw 'Refusing pre-existing Redis V2 persistence without its protected credential.'
}
if (-not $hasPreexistingPersistence -and $identityMetadataCount -ne 0) {
    throw 'Refusing a partial Canary_02 V2 identity without its certified persistence dataset.'
}

if (Test-Path -LiteralPath $credentialPath -PathType Leaf) {
    $securePassword = Import-Clixml -LiteralPath $credentialPath
}
else {
    $randomBytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
    try {
        $password = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
        $securePassword | Export-Clixml -LiteralPath $credentialPath
    }
    finally {
        [Array]::Clear($randomBytes, 0, $randomBytes.Length)
        $password = $null
    }
}

$plainPassword = ConvertTo-PlainText $securePassword
try {
    $passwordHash = Get-PasswordHash $plainPassword
}
finally {
    $plainPassword = $null
}

$acl = @"
user default off
user canary on #$passwordHash ~* +@all -@dangerous +config|get +info +eval +evalsha +script|load +script|exists +shutdown -flushall -flushdb -debug -module -replicaof -slaveof
"@
[IO.File]::WriteAllText($aclPath, $acl, [Text.UTF8Encoding]::new($false))

$normalDataDir = $dataDir.Replace('\', '/')
$normalPidPath = $pidPath.Replace('\', '/')
$normalAclPath = $aclPath.Replace('\', '/')
$config = @"
bind 127.0.0.1 ::1
protected-mode yes
port $Port
timeout 0
tcp-keepalive 60
databases 16
dir "$normalDataDir"
dbfilename financial-canary.rdb
appendonly yes
appendfilename "financial-canary.aof"
appenddirname "appendonlydir"
appendfsync always
aof-use-rdb-preamble yes
aof-load-truncated no
save 60 1
stop-writes-on-bgsave-error yes
maxmemory 256mb
maxmemory-policy noeviction
aclfile "$normalAclPath"
logfile ""
loglevel notice
pidfile "$normalPidPath"
instance-name seabyss-financial-canary
winlog-level off
"@
[IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
$configHash = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($config))
).ToLowerInvariant()
if (Test-Path -LiteralPath $runtimeIdPath -PathType Leaf) {
    $runtimeId = (Get-Content -LiteralPath $runtimeIdPath -Raw).Trim()
}
else {
    $runtimeId = 'canary02-v2-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($runtimeIdPath, $runtimeId, [Text.UTF8Encoding]::new($false))
}
$runtimeIdHash = Get-PasswordHash $runtimeId
if (Test-Path -LiteralPath $datasetIdPath -PathType Leaf) {
    $datasetId = (Get-Content -LiteralPath $datasetIdPath -Raw).Trim()
}
else {
    $datasetId = 'canary02-v2-dataset-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::WriteAllText($datasetIdPath, $datasetId, [Text.UTF8Encoding]::new($false))
}
$datasetIdHash = Get-PasswordHash $datasetId
if (Test-Path -LiteralPath $bindingCreatedAtPath -PathType Leaf) {
    $bindingCreatedAt = (Get-Content -LiteralPath $bindingCreatedAtPath -Raw).Trim()
}
else {
    $bindingCreatedAt = [DateTimeOffset]::UtcNow.ToString('O')
    [IO.File]::WriteAllText($bindingCreatedAtPath, $bindingCreatedAt, [Text.UTF8Encoding]::new($false))
}
if ($runtimeId -notmatch '^canary02-v2-[a-f0-9]{32}$' -or
    $datasetId -notmatch '^canary02-v2-dataset-[a-f0-9]{32}$') {
    throw 'Canary_02 V2 runtime or dataset identity is malformed.'
}
try { [DateTimeOffset]::Parse($bindingCreatedAt).ToUniversalTime() | Out-Null }
catch { throw 'Canary_02 V2 binding creation timestamp is malformed.' }

$bindingRuntimeRoot = $runtimeRoot.Replace('\', '/').ToLowerInvariant()
$bindingDataDirectory = $dataDir.Replace('\', '/').ToLowerInvariant()
$bindingAofManifestPath = $aofManifestPath.Replace('\', '/').ToLowerInvariant()
$bindingRdbPath = $rdbPath.Replace('\', '/').ToLowerInvariant()
$bindingBasis = [ordered]@{
    schemaVersion = 2
    instanceId = 'canary02-v2'
    sandboxTitleId = '1D0C16'
    canaryPlayFabId = 'C5BD37AA141B3C4E'
    environment = 'sandbox'
    runtimeId = $runtimeId
    datasetId = $datasetId
    runtimeRoot = $bindingRuntimeRoot
    dataDirectory = $bindingDataDirectory
    aofManifestPath = $bindingAofManifestPath
    rdbPath = $bindingRdbPath
    createdAt = $bindingCreatedAt
}
$bindingBasisJson = $bindingBasis | ConvertTo-Json -Depth 4 -Compress
$bindingHash = Get-PasswordHash $bindingBasisJson
$binding = [ordered]@{}
foreach ($item in $bindingBasis.GetEnumerator()) { $binding[$item.Key] = $item.Value }
$binding['bindingHash'] = $bindingHash
$bindingJson = $binding | ConvertTo-Json -Depth 4 -Compress

if ($hasPreexistingPersistence) {
    try { $persistedState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
    catch { throw 'Refusing pre-existing Redis V2 persistence with an unreadable state binding.' }
    if ([int]$persistedState.schemaVersion -ne 2 -or
        [string]$persistedState.instanceId -ne 'canary02-v2' -or
        [string]$persistedState.sandboxTitleId -ne '1D0C16' -or
        [string]$persistedState.canaryPlayFabId -ne 'C5BD37AA141B3C4E' -or
        [string]$persistedState.environment -ne 'sandbox' -or
        [string]$persistedState.host -ne '127.0.0.1' -or [int]$persistedState.port -ne 6398 -or
        -not [IO.Path]::GetFullPath([string]$persistedState.runtimeRoot).Equals($runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFullPath([string]$persistedState.configPath).Equals($configPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFullPath([string]$persistedState.dataDirectory).Equals($dataDir, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFullPath([string]$persistedState.aofManifestPath).Equals($aofManifestPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFullPath([string]$persistedState.rdbPath).Equals($rdbPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$persistedState.configHash -ne $configHash -or
        [string]$persistedState.runtimeId -ne $runtimeId -or
        [string]$persistedState.runtimeIdHash -ne $runtimeIdHash -or
        [string]$persistedState.datasetId -ne $datasetId -or
        [string]$persistedState.datasetIdHash -ne $datasetIdHash -or
        [string]$persistedState.createdAt -ne $bindingCreatedAt -or
        [string]$persistedState.bindingHash -ne $bindingHash) {
        throw 'Refusing to adopt pre-existing Redis V2 persistence with a mismatched state binding.'
    }
}

if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
        $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$existing.pid) -ErrorAction SilentlyContinue
        if ($process -and [IO.Path]::GetFullPath($process.Path).Equals($memuraiExe, [StringComparison]::OrdinalIgnoreCase)) {
            $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)").CommandLine
            if ([int]$existing.schemaVersion -ne 2 -or [string]$existing.instanceId -ne 'canary02-v2' -or
                [string]$existing.sandboxTitleId -ne '1D0C16' -or
                [string]$existing.canaryPlayFabId -ne 'C5BD37AA141B3C4E' -or
                [string]$existing.environment -ne 'sandbox' -or
                [int]$existing.port -ne $Port -or
                -not [IO.Path]::GetFullPath([string]$existing.runtimeRoot).Equals($runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -or
                -not [IO.Path]::GetFullPath([string]$existing.configPath).Equals($configPath, [StringComparison]::OrdinalIgnoreCase) -or
                -not [IO.Path]::GetFullPath([string]$existing.dataDirectory).Equals($dataDir, [StringComparison]::OrdinalIgnoreCase) -or
                [string]$existing.configHash -ne $configHash -or
                [string]$existing.runtimeId -ne $runtimeId -or
                [string]$existing.runtimeIdHash -ne $runtimeIdHash -or
                [string]$existing.datasetId -ne $datasetId -or
                [string]$existing.datasetIdHash -ne $datasetIdHash -or
                [string]$existing.createdAt -ne $bindingCreatedAt -or
                [string]$existing.bindingHash -ne $bindingHash -or
                [string]$commandLine -notlike "*$configPath*") {
                throw 'Refusing an already-running Redis process not bound to the exact Canary_02 V2 config/dataset.'
            }
            $previousCliAuth = $env:REDISCLI_AUTH
            try {
                $env:REDISCLI_AUTH = ConvertTo-PlainText $securePassword
                $runningConfig = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary CONFIG GET dir appenddirname appendfilename dbfilename save appendonly appendfsync maxmemory-policy protected-mode) -join "`n"
                $runningIdentity = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET 'seabyss:financial-canary:runtime-identity:v2') -join ''
                $runningBinding = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET 'seabyss:financial-canary:dataset-binding:v2') -join ''
                if ($runningIdentity -ne $runtimeId -or $runningBinding -ne $bindingJson -or
                    $runningConfig -notmatch ('(?m)^dir\n' + [regex]::Escape($normalDataDir) + '$') -or
                    $runningConfig -notmatch '(?m)^appenddirname\nappendonlydir$' -or
                    $runningConfig -notmatch '(?m)^appendfilename\nfinancial-canary\.aof$' -or
                    $runningConfig -notmatch '(?m)^dbfilename\nfinancial-canary\.rdb$' -or
                    $runningConfig -notmatch '(?m)^save\n60 1$' -or
                    $runningConfig -notmatch '(?m)^appendonly\nyes$' -or
                    $runningConfig -notmatch '(?m)^appendfsync\nalways$' -or
                    $runningConfig -notmatch '(?m)^maxmemory-policy\nnoeviction$' -or
                    $runningConfig -notmatch '(?m)^protected-mode\nyes$') {
                    throw 'Already-running Redis reports another Canary_02 V2 config or dataset binding.'
                }
            }
            finally {
                $env:REDISCLI_AUTH = $previousCliAuth
            }
            [pscustomobject]@{
                Status = 'already_running'
                ProcessId = $process.Id
                Host = '127.0.0.1'
                Port = $Port
                RuntimeRoot = $runtimeRoot
                RuntimeIdHash = $runtimeIdHash
                DatasetIdHash = $datasetIdHash
                BindingHash = $bindingHash
                CredentialProtected = $true
            }
            return
        }
    }
    catch {
        if ($process) { throw }
        # A stale state file for an absent process is replaced below.
    }
}

$unexpectedListeners = @(
    [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $Port }
)
if ($unexpectedListeners.Count -gt 0) {
    throw "Refusing to start canary02 Redis: port $Port is already owned without an exact validated runtime binding."
}

$process = Start-Process -FilePath $memuraiExe -ArgumentList @($configPath) -WorkingDirectory $runtimeDir -WindowStyle Hidden -PassThru
$oldCliAuth = $env:REDISCLI_AUTH
try {
    $env:REDISCLI_AUTH = ConvertTo-PlainText $securePassword
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($process.HasExited) {
            throw "Memurai exited during startup with code $($process.ExitCode)."
        }

        $pong = & $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary PING 2>$null
        if ($LASTEXITCODE -eq 0 -and $pong -eq 'PONG') {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) {
        throw 'Memurai did not become ready within five seconds.'
    }

    $runtimeIdentityKey = 'seabyss:financial-canary:runtime-identity:v2'
    $datasetBindingKey = 'seabyss:financial-canary:dataset-binding:v2'
    $persistedRuntimeId = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET $runtimeIdentityKey) -join ''
    $persistedBinding = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET $datasetBindingKey) -join ''
    if ([string]::IsNullOrWhiteSpace($persistedRuntimeId) -xor [string]::IsNullOrWhiteSpace($persistedBinding)) {
        throw 'Refusing a partially initialized Canary_02 V2 Redis dataset binding.'
    }
    if ([string]::IsNullOrWhiteSpace($persistedRuntimeId)) {
        if ($hasPreexistingPersistence) {
            throw 'Refusing to adopt pre-existing Redis V2 persistence without its durable binding.'
        }
        $bindingLua = "if redis.call('EXISTS', KEYS[1]) ~= 0 or redis.call('EXISTS', KEYS[2]) ~= 0 then return 'conflict' end redis.call('SET', KEYS[1], ARGV[1]) redis.call('SET', KEYS[2], ARGV[2]) return 'created'"
        $identityCreated = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary EVAL $bindingLua 2 $runtimeIdentityKey $datasetBindingKey $runtimeId $bindingJson) -join ''
        if ($identityCreated -ne 'created') {
            throw 'Redis V2 dataset binding initialization lost an atomic race.'
        }
        $identityAof = @(& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary WAITAOF 1 0 5000)
        if ($LASTEXITCODE -ne 0 -or @($identityAof).Count -lt 1 -or [int]$identityAof[0] -lt 1) {
            throw 'Redis runtime identity was not durably fsynced.'
        }
        $persistedRuntimeId = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET $runtimeIdentityKey) -join ''
        $persistedBinding = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary GET $datasetBindingKey) -join ''
    }
    if ($persistedRuntimeId -ne $runtimeId -or $persistedBinding -ne $bindingJson) {
        throw 'Redis runtime/dataset binding does not match Canary_02 V2.'
    }

    $serverInfo = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary INFO server) -join "`n"
    $persistenceInfo = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary INFO persistence) -join "`n"
    $configValues = (& $memuraiCli --raw -h 127.0.0.1 -p $Port --user canary CONFIG GET appendonly appendfsync appenddirname appendfilename dbfilename save dir maxmemory-policy bind protected-mode) -join "`n"
    if ($serverInfo -notmatch '(?m)^(?:redis_version|memurai_api_version):(7\.|8\.)') {
        throw 'The isolated server does not expose a Redis 7+ compatible API.'
    }
    if ($persistenceInfo -notmatch '(?m)^aof_enabled:1$') {
        throw 'AOF persistence is not enabled.'
    }
    if ($configValues -notmatch '(?m)^appendonly\nyes$' -or
        $configValues -notmatch '(?m)^appendfsync\nalways$' -or
        $configValues -notmatch '(?m)^appenddirname\nappendonlydir$' -or
        $configValues -notmatch '(?m)^appendfilename\nfinancial-canary\.aof$' -or
        $configValues -notmatch '(?m)^dbfilename\nfinancial-canary\.rdb$' -or
        $configValues -notmatch '(?m)^save\n60 1$' -or
        $configValues -notmatch '(?m)^maxmemory-policy\nnoeviction$' -or
        $configValues -notmatch '(?m)^protected-mode\nyes$') {
        throw 'The isolated Redis safety configuration does not match the canary contract.'
    }

    $versionMatch = [regex]::Match($serverInfo, '(?m)^(?:redis_version|memurai_api_version):([^\r\n]+)')
    $version = $versionMatch.Groups[1].Value
    $state = [ordered]@{
        schemaVersion = 2
        instanceId = 'canary02-v2'
        sandboxTitleId = '1D0C16'
        canaryPlayFabId = 'C5BD37AA141B3C4E'
        environment = 'sandbox'
        pid = $process.Id
        executable = $memuraiExe
        host = '127.0.0.1'
        port = $Port
        runtimeRoot = $runtimeRoot
        configPath = $configPath
        configHash = $configHash
        dataDirectory = $dataDir
        aofManifestPath = $aofManifestPath
        rdbPath = $rdbPath
        runtimeId = $runtimeId
        runtimeIdHash = $runtimeIdHash
        datasetId = $datasetId
        datasetIdHash = $datasetIdHash
        createdAt = $bindingCreatedAt
        bindingHash = $bindingHash
        redisApiVersion = $version
        aofEnabled = $true
        maxmemoryPolicy = 'noeviction'
        protectedMode = $true
        bind = @('127.0.0.1', '::1')
        startedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))

    [pscustomobject]@{
        Status = 'started'
        ProcessId = $process.Id
        Host = '127.0.0.1'
        Port = $Port
        RedisApiVersion = $version
        AofEnabled = $true
        AppendFsync = 'always'
        MaxmemoryPolicy = 'noeviction'
        LoopbackOnly = $true
        CredentialProtected = $true
        RuntimeRoot = $runtimeRoot
        RuntimeIdHash = $runtimeIdHash
        DatasetIdHash = $datasetIdHash
        BindingHash = $bindingHash
    }
}
catch {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw
}
finally {
    $env:REDISCLI_AUTH = $oldCliAuth
}
