import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
    createFinancialCanaryRedisDatasetBinding,
    createFinancialCanaryRedisRuntimeContract,
    financialCanaryDatasetIdDigest,
    financialCanaryRuntimeIdDigest,
    validateFinancialCanaryRedisStateFile,
    verifyFinancialCanaryRedisRuntime,
    waitForFinancialCanaryAof
} from "../src/financial-canary-redis-durability-contract.js";

const LOCAL_APP_DATA = "C:/Users/test/AppData/Local";

function contract() {
    return createFinancialCanaryRedisRuntimeContract({ localAppData: LOCAL_APP_DATA });
}

function state(value = contract()) {
    const runtimeId = "canary02-v2-test-runtime-identity";
    const datasetId = "canary02-v2-test-dataset-identity";
    const createdAt = "2026-08-25T12:00:00.000Z";
    const binding = createFinancialCanaryRedisDatasetBinding({
        contract: value,
        runtimeId,
        datasetId,
        createdAt
    });
    return {
        schemaVersion: 2,
        instanceId: value.instanceId,
        sandboxTitleId: value.sandboxTitleId,
        canaryPlayFabId: value.canaryPlayFabId,
        environment: value.environment,
        host: value.host,
        port: value.port,
        runtimeRoot: value.runtimeRoot,
        dataDirectory: value.dataDirectory,
        configPath: value.configPath,
        aofManifestPath: value.aofManifestPath,
        rdbPath: value.rdbPath,
        runtimeId,
        runtimeIdHash: financialCanaryRuntimeIdDigest(runtimeId),
        datasetId,
        datasetIdHash: financialCanaryDatasetIdDigest(datasetId),
        createdAt,
        bindingHash: binding.bindingHash
    };
}

class RuntimeRedis {
    constructor(value = contract(), runtimeState = state(value)) {
        this.contract = value;
        this.state = runtimeState;
        this.waitResult = [1, 0];
        this.appendfsync = "always";
        this.save = "60 1";
        this.providerBinding = createFinancialCanaryRedisDatasetBinding({
            contract: value,
            runtimeId: runtimeState.runtimeId,
            datasetId: runtimeState.datasetId,
            createdAt: runtimeState.createdAt
        });
    }

    async ping() { return "PONG"; }

    async sendCommand(command) {
        if (command[0] === "CONFIG") {
            return [
                "dir", this.contract.dataDirectory,
                "appenddirname", this.contract.appenddirname,
                "appendfilename", this.contract.appendfilename,
                "dbfilename", this.contract.dbfilename,
                "save", this.save,
                "appendonly", "yes",
                "appendfsync", this.appendfsync,
                "maxmemory-policy", "noeviction",
                "protected-mode", "yes"
            ];
        }
        if (command[0] === "GET" && command[1] === this.contract.runtimeIdKey) {
            return this.state.runtimeId;
        }
        if (command[0] === "GET" && command[1] === this.contract.datasetBindingKey) {
            return JSON.stringify(this.providerBinding);
        }
        if (command[0] === "INFO") {
            return "# Persistence\r\naof_enabled:1\r\naof_last_write_status:ok\r\n";
        }
        if (command[0] === "WAITAOF") return this.waitResult;
        throw new Error(`unsupported ${command[0]}`);
    }
}

test("exact Canary_02 V2 runtime/config/dataset binding is accepted", async () => {
    const expected = contract();
    const runtimeState = state(expected);
    const result = await verifyFinancialCanaryRedisRuntime({
        redis: new RuntimeRedis(expected, runtimeState),
        contract: expected,
        state: runtimeState
    });
    assert.equal(expected.schemaVersion, 2);
    assert.equal(expected.runtimeRoot.endsWith("/canary02-v2"), true);
    assert.equal(result.instanceId, "canary02-v2");
    assert.equal(result.port, 6398);
    assert.equal(result.sandboxTitleId, "1D0C16");
    assert.equal(result.canaryPlayFabId, "C5BD37AA141B3C4E");
    assert.equal(result.environment, "sandbox");
    assert.equal(result.exactDataset, true);
    assert.equal(result.aof, true);
    assert.equal(result.rdb, true);
});

test("former 6397 and legacy canary02 root are rejected fail-closed", () => {
    assert.throws(() => createFinancialCanaryRedisRuntimeContract({
        localAppData: LOCAL_APP_DATA,
        port: 6397
    }), (error) => error?.code === "FINANCIAL_CANARY_REDIS_INSTANCE_FORBIDDEN");
    assert.throws(() => createFinancialCanaryRedisRuntimeContract({
        localAppData: LOCAL_APP_DATA,
        runtimeRoot: `${LOCAL_APP_DATA}/SeabyssCodex/financial-canary-memurai/canary02`
    }), (error) => error?.code === "FINANCIAL_CANARY_REDIS_INSTANCE_FORBIDDEN");
});

test("state bound to another root, Title, canary or environment is rejected", () => {
    const expected = contract();
    for (const mutate of [
        (value) => { value.runtimeRoot = `${LOCAL_APP_DATA}/SeabyssCodex/financial-canary-memurai/canary02`; },
        (value) => { value.sandboxTitleId = "142853"; },
        (value) => { value.canaryPlayFabId = "61AD15CDA4137EA9"; },
        (value) => { value.environment = "production"; }
    ]) {
        const wrong = state(expected);
        mutate(wrong);
        assert.throws(() => validateFinancialCanaryRedisStateFile({ state: wrong, contract: expected }),
            (error) => error?.code === "FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH");
    }
});

test("state identity, dataset and binding hashes are all mandatory", () => {
    const expected = contract();
    for (const field of ["runtimeIdHash", "datasetIdHash", "bindingHash"]) {
        const wrong = state(expected);
        wrong[field] = "0".repeat(64);
        assert.throws(() => validateFinancialCanaryRedisStateFile({ state: wrong, contract: expected }),
            (error) => error?.code === "FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH");
    }
});

test("a Redis dataset with another runtime id or binding is rejected", async () => {
    const expected = contract();
    const runtimeState = state(expected);
    const wrongRuntime = new RuntimeRedis(expected, runtimeState);
    wrongRuntime.state = { ...runtimeState, runtimeId: "another-runtime" };
    await assert.rejects(
        verifyFinancialCanaryRedisRuntime({ redis: wrongRuntime, contract: expected, state: runtimeState }),
        (error) => error?.code === "FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH"
    );

    const wrongDataset = new RuntimeRedis(expected, runtimeState);
    wrongDataset.providerBinding = {
        ...wrongDataset.providerBinding,
        datasetId: "another-dataset"
    };
    await assert.rejects(
        verifyFinancialCanaryRedisRuntime({ redis: wrongDataset, contract: expected, state: runtimeState }),
        (error) => error?.code === "FINANCIAL_CANARY_REDIS_RUNTIME_MISMATCH"
    );
});

test("unsafe AOF or absent RDB schedule is rejected", async () => {
    const expected = contract();
    const runtimeState = state(expected);
    const redis = new RuntimeRedis(expected, runtimeState);
    redis.appendfsync = "everysec";
    await assert.rejects(
        verifyFinancialCanaryRedisRuntime({ redis, contract: expected, state: runtimeState }),
        (error) => error?.code === "FINANCIAL_CANARY_REDIS_PERSISTENCE_UNSAFE"
    );
    redis.appendfsync = "always";
    redis.save = "";
    await assert.rejects(
        verifyFinancialCanaryRedisRuntime({ redis, contract: expected, state: runtimeState }),
        (error) => error?.code === "FINANCIAL_CANARY_REDIS_PERSISTENCE_UNSAFE"
    );
});

test("WAITAOF requires a local fsync acknowledgement", async () => {
    const redis = new RuntimeRedis();
    assert.equal((await waitForFinancialCanaryAof(redis)).local, 1);
    redis.waitResult = [0, 0];
    await assert.rejects(waitForFinancialCanaryAof(redis),
        (error) => error?.code === "FINANCIAL_CANARY_REDIS_AOF_UNCONFIRMED");
});

test("PowerShell lifecycle is pinned to a new Canary_02 V2 dataset", () => {
    const root = resolve(import.meta.dirname, "..");
    const start = readFileSync(resolve(root, "tools/financial-canary-redis/Start-FinancialCanaryRedis.ps1"), "utf8");
    const stop = readFileSync(resolve(root, "tools/financial-canary-redis/Stop-FinancialCanaryRedis.ps1"), "utf8");
    const inspect = readFileSync(resolve(root, "tools/financial-canary-redis/Test-FinancialCanaryRedis.ps1"), "utf8");
    const invoke = readFileSync(resolve(root, "tools/financial-canary-redis/Invoke-WithFinancialCanaryRedis.ps1"), "utf8");
    for (const source of [start, stop, inspect, invoke]) {
        assert.match(source, /financial-canary-memurai[\\\\/]canary02-v2/u);
        assert.match(source, /C5BD37AA141B3C4E/u);
        assert.match(source, /1D0C16/u);
        assert.match(source, /dataset-binding:v2/u);
    }
    assert.match(start, /appendfsync always/u);
    assert.match(start, /aof-load-truncated no/u);
    assert.match(start, /runtime-identity:v2/u);
    assert.match(start, /dataset-id\.txt/u);
    assert.match(start, /Refusing to adopt pre-existing Redis V2 persistence/u);
    assert.match(start, /WAITAOF 1 0 5000/u);
    assert.match(start, /GetActiveTcpListeners/u);
    assert.match(stop, /WAITAOF 1 0 5000/u);
    assert.match(stop, /\bSAVE\b/u);
    assert.match(stop, /SHUTDOWN NOSAVE/u);
    assert.doesNotMatch(stop, /SHUTDOWN SAVE/u);
    assert.match(invoke, /SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT/u);
});
