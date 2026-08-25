import { createHash } from "node:crypto";
import { resolve } from "node:path";

const RUNTIME_ID_KEY = "seabyss:financial-canary:runtime-identity:v2";
const DATASET_BINDING_KEY = "seabyss:financial-canary:dataset-binding:v2";
const SANDBOX_TITLE_ID = "1D0C16";
const CANARY_PLAYFAB_ID = "C5BD37AA141B3C4E";
const ENVIRONMENT = "sandbox";

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function text(value, label, maximum = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_INVALID", `${label} is absent or invalid.`);
    }
    return value;
}

function canonicalPath(value) {
    return resolve(text(value, "Redis runtime path", 1024)).replaceAll("\\", "/").toLowerCase();
}

function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function configMap(value) {
    if (Array.isArray(value)) {
        const result = new Map();
        for (let index = 0; index + 1 < value.length; index += 2) {
            result.set(String(value[index]).toLowerCase(), String(value[index + 1]));
        }
        return result;
    }
    if (value && typeof value === "object") {
        return new Map(Object.entries(value).map(([key, item]) => [key.toLowerCase(), String(item)]));
    }
    fail("FINANCIAL_CANARY_REDIS_CONFIG_INVALID", "Redis CONFIG GET returned invalid data.");
}

function isoTimestamp(value, label) {
    const normalized = text(value, label, 64);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/u.test(normalized) ||
        !Number.isFinite(Date.parse(normalized))) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_INVALID", `${label} is invalid.`);
    }
    return normalized;
}

export function financialCanaryRuntimeIdDigest(value) {
    return sha256(text(value, "Redis runtime identity", 200));
}

export function financialCanaryDatasetIdDigest(value) {
    return sha256(text(value, "Redis dataset identity", 200));
}

export function createFinancialCanaryRedisRuntimeContract({
    localAppData,
    runtimeRoot = null,
    port = 6398,
    instanceId = "canary02-v2"
} = {}) {
    const expectedRoot = canonicalPath(resolve(
        text(localAppData, "LOCALAPPDATA", 1024),
        "SeabyssCodex", "financial-canary-memurai", "canary02-v2"
    ));
    const root = canonicalPath(runtimeRoot || expectedRoot);
    if (!Number.isSafeInteger(port) || port !== 6398 || instanceId !== "canary02-v2" ||
        root !== expectedRoot) {
        fail("FINANCIAL_CANARY_REDIS_INSTANCE_FORBIDDEN",
            "Financial Canary_02 V2 requires its exact isolated runtime root and port 6398.");
    }
    return Object.freeze({
        schemaVersion: 2,
        instanceId,
        sandboxTitleId: SANDBOX_TITLE_ID,
        canaryPlayFabId: CANARY_PLAYFAB_ID,
        environment: ENVIRONMENT,
        runtimeRoot: root,
        runtimeDirectory: `${root}/runtime`,
        dataDirectory: `${root}/runtime/data`,
        configPath: `${root}/runtime/memurai-financial-canary.conf`,
        aofDirectory: `${root}/runtime/data/appendonlydir`,
        aofManifestPath: `${root}/runtime/data/appendonlydir/financial-canary.aof.manifest`,
        rdbPath: `${root}/runtime/data/financial-canary.rdb`,
        port,
        host: "127.0.0.1",
        appenddirname: "appendonlydir",
        appendfilename: "financial-canary.aof",
        dbfilename: "financial-canary.rdb",
        runtimeIdKey: RUNTIME_ID_KEY,
        datasetBindingKey: DATASET_BINDING_KEY
    });
}

export function createFinancialCanaryRedisDatasetBinding({
    contract,
    runtimeId,
    datasetId,
    createdAt
} = {}) {
    if (!contract || contract.schemaVersion !== 2) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_INVALID", "Redis V2 runtime contract is absent.");
    }
    const runtime = text(runtimeId, "Redis runtime identity", 200);
    const dataset = text(datasetId, "Redis dataset identity", 200);
    const created = isoTimestamp(createdAt, "Redis dataset creation time");
    const basis = {
        schemaVersion: 2,
        instanceId: contract.instanceId,
        sandboxTitleId: contract.sandboxTitleId,
        canaryPlayFabId: contract.canaryPlayFabId,
        environment: contract.environment,
        runtimeId: runtime,
        datasetId: dataset,
        runtimeRoot: contract.runtimeRoot,
        dataDirectory: contract.dataDirectory,
        aofManifestPath: contract.aofManifestPath,
        rdbPath: contract.rdbPath,
        createdAt: created
    };
    return Object.freeze({ ...basis, bindingHash: sha256(JSON.stringify(basis)) });
}

function validateBinding(value, contract, expected = null) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("FINANCIAL_CANARY_REDIS_BINDING_INVALID", "Redis dataset binding is absent or malformed.");
    }
    const derived = createFinancialCanaryRedisDatasetBinding({
        contract,
        runtimeId: value.runtimeId,
        datasetId: value.datasetId,
        createdAt: value.createdAt
    });
    const fields = Object.keys(derived);
    if (Object.keys(value).sort().join(",") !== [...fields].sort().join(",") ||
        fields.some((field) => value[field] !== derived[field]) ||
        expected && fields.some((field) => expected[field] !== derived[field])) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH",
            "Redis dataset binding does not identify the exact Canary_02 V2 dataset.");
    }
    return derived;
}

export function validateFinancialCanaryRedisStateFile({ state, contract }) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        fail("FINANCIAL_CANARY_REDIS_STATE_INVALID", "Redis state.json is absent or malformed.");
    }
    const comparisons = [
        [state.schemaVersion, contract.schemaVersion, "state schema"],
        [state.instanceId, contract.instanceId, "instance id"],
        [state.sandboxTitleId, contract.sandboxTitleId, "Sandbox Title"],
        [state.canaryPlayFabId, contract.canaryPlayFabId, "canary PlayFabId"],
        [state.environment, contract.environment, "environment"],
        [String(state.host), contract.host, "host"],
        [Number(state.port), contract.port, "port"],
        [canonicalPath(state.runtimeRoot), contract.runtimeRoot, "runtime root"],
        [canonicalPath(state.dataDirectory), contract.dataDirectory, "data directory"],
        [canonicalPath(state.configPath), contract.configPath, "config path"],
        [canonicalPath(state.aofManifestPath), contract.aofManifestPath, "AOF manifest path"],
        [canonicalPath(state.rdbPath), contract.rdbPath, "RDB path"]
    ];
    for (const [actual, expected, label] of comparisons) {
        if (actual !== expected) {
            fail("FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH",
                `Redis ${label} does not identify Canary_02 V2.`);
        }
    }
    const binding = createFinancialCanaryRedisDatasetBinding({
        contract,
        runtimeId: state.runtimeId,
        datasetId: state.datasetId,
        createdAt: state.createdAt
    });
    if (state.runtimeIdHash !== financialCanaryRuntimeIdDigest(binding.runtimeId) ||
        state.datasetIdHash !== financialCanaryDatasetIdDigest(binding.datasetId) ||
        state.bindingHash !== binding.bindingHash) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH",
            "Redis state identity or dataset binding hash is invalid.");
    }
    return binding;
}

export async function verifyFinancialCanaryRedisRuntime({ redis, contract, state }) {
    if (typeof redis?.sendCommand !== "function" || typeof redis?.ping !== "function") {
        throw new TypeError("Redis client is required.");
    }
    const stateBinding = validateFinancialCanaryRedisStateFile({ state, contract });
    if (await redis.ping() !== "PONG") {
        fail("FINANCIAL_CANARY_REDIS_UNHEALTHY", "Redis PING failed.");
    }
    const config = configMap(await redis.sendCommand([
        "CONFIG", "GET", "dir", "appenddirname", "appendfilename", "dbfilename", "save",
        "appendonly", "appendfsync", "maxmemory-policy", "protected-mode"
    ]));
    const expected = new Map([
        ["dir", contract.dataDirectory],
        ["appenddirname", contract.appenddirname],
        ["appendfilename", contract.appendfilename],
        ["dbfilename", contract.dbfilename],
        ["appendonly", "yes"],
        ["maxmemory-policy", "noeviction"],
        ["protected-mode", "yes"]
    ]);
    for (const [key, wanted] of expected) {
        const actual = key === "dir" ? canonicalPath(config.get(key)) : config.get(key);
        if (actual !== wanted) {
            fail("FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH",
                `Redis CONFIG ${key} is not bound to the certified Canary_02 V2 dataset.`);
        }
    }
    if (config.get("appendfsync") !== "always" || !String(config.get("save") || "").trim()) {
        fail("FINANCIAL_CANARY_REDIS_PERSISTENCE_UNSAFE", "Redis AOF/RDB persistence is unsafe.");
    }
    const providerRuntimeId = await redis.sendCommand(["GET", contract.runtimeIdKey]);
    if (providerRuntimeId !== stateBinding.runtimeId) {
        fail("FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH",
            "Connected Redis dataset has another runtime identity.");
    }
    let providerBinding;
    try {
        providerBinding = JSON.parse(await redis.sendCommand(["GET", contract.datasetBindingKey]));
    } catch {
        fail("FINANCIAL_CANARY_REDIS_BINDING_INVALID", "Redis dataset binding cannot be decoded.");
    }
    validateBinding(providerBinding, contract, stateBinding);
    const persistence = String(await redis.sendCommand(["INFO", "persistence"]));
    if (!/(?:^|\r?\n)aof_enabled:1(?:\r?\n|$)/u.test(persistence) ||
        /(?:^|\r?\n)aof_last_write_status:(?!ok)/u.test(persistence)) {
        fail("FINANCIAL_CANARY_REDIS_PERSISTENCE_UNSAFE", "Redis AOF persistence is not healthy.");
    }
    return Object.freeze({
        instanceId: contract.instanceId,
        port: contract.port,
        runtimeIdHash: state.runtimeIdHash,
        datasetIdHash: state.datasetIdHash,
        bindingHash: state.bindingHash,
        sandboxTitleId: contract.sandboxTitleId,
        canaryPlayFabId: contract.canaryPlayFabId,
        environment: contract.environment,
        aof: true,
        rdb: true,
        appendfsync: config.get("appendfsync"),
        noeviction: true,
        exactDataset: true
    });
}

export async function waitForFinancialCanaryAof(redis, timeoutMilliseconds = 5_000) {
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
        throw new TypeError("AOF timeout must be a positive integer.");
    }
    const result = await redis.sendCommand(["WAITAOF", "1", "0", String(timeoutMilliseconds)]);
    if (!Array.isArray(result) || Number(result[0]) < 1) {
        fail("FINANCIAL_CANARY_REDIS_AOF_UNCONFIRMED", "Redis did not fsync the local AOF.");
    }
    return Object.freeze({ local: Number(result[0]), replicas: Number(result[1] || 0) });
}
