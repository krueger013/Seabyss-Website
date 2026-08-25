import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT as C,
    createHistoricalXsd2SequenceRebasePlan,
    createRedisHistoricalXsd2SequenceRebaser,
    historicalSequenceRebaseRedisKeys,
    validateHistoricalXsd2SequenceRebaseEvidence
} from "../src/server-economy-poc-historical-sequence-rebase.js";
import {
    validateAcquiredHistoricalRebaseLedgerLease,
    validateHistoricalRebaseAofContinuation,
    selectHistoricalPersistenceProvenance
} from "../diamonds-canary-xsd2-historical-sequence-rebase.mjs";
import { serverEconomyPocDigest } from "../src/server-economy-poc-model.js";

const OTHER_HASH = "4".repeat(64);
const LEDGER_LEASE_TOKEN = "ledger-lease-token";

function clone(value) {
    return structuredClone(value);
}

function inboxRecord() {
    return {
        schemaVersion: 1,
        playFabId: C.playFabId,
        operationId: C.operationId,
        sequence: C.originalSequence,
        state: "Pending",
        operation: {
            schemaVersion: 1,
            kind: "xsolla_entitlement",
            playFabId: C.playFabId,
            operationId: C.operationId,
            eventId: C.eventId,
            diamonds: C.diamondsDelta,
            eliteBall: 0,
            premium: null,
            reason: C.operationReason,
            createdAtUnixMs: C.operationEffectiveAtUnixMs,
            effectiveAtUnixMs: C.operationEffectiveAtUnixMs,
            immutableHash: C.operationImmutableHash
        },
        claimEpoch: 0,
        claimOwner: null,
        claimToken: null,
        claimExpiresAtUnixMs: null,
        result: null,
        ackedAtUnixMs: null
    };
}

function ledgerWrapper() {
    return {
        immutableHash: C.ledgerImmutableHash,
        record: {
            provider: C.provider,
            providerTransactionId: C.providerTransactionId,
            playFabId: C.playFabId,
            receiptId: C.receiptId,
            sku: C.sku,
            state: "Failed",
            leaseOwner: C.ledgerLeaseOwner,
            leaseToken: LEDGER_LEASE_TOKEN,
            leaseExpiresAtUnixMs: 1_900_000_000_000,
            planVersion: C.planVersion,
            planHash: C.planHash,
            stepJournal: {
                receipt_persisted: {
                    status: "StepApplied",
                    resultHash: OTHER_HASH,
                    result: { receiptId: C.receiptId }
                },
                diamonds_target_granted: {
                    status: "StepPending",
                    resultHash: null,
                    result: null
                }
            },
            checkpoints: {
                receipt_persisted: {
                    resultHash: OTHER_HASH,
                    result: { receiptId: C.receiptId }
                }
            }
        }
    };
}

function providerGuardRecord() {
    return {
        immutableHash: C.providerGuardImmutableHash,
        identity: C.providerTransactionId,
        intent: {
            providerTransactionId: C.providerTransactionId,
            playFabId: C.playFabId,
            sku: C.sku,
            operationId: C.operationId
        }
    };
}

function eventIndexRecord() {
    return {
        immutableHash: C.eventIndexImmutableHash,
        identity: C.eventIndexIdentity,
        intent: {
            playFabId: C.playFabId,
            eventId: C.eventId,
            operationId: C.operationId
        }
    };
}

function evidence() {
    const historicalOperation = inboxRecord().operation;
    const currentImmutable = {
        schemaVersion: historicalOperation.schemaVersion,
        kind: historicalOperation.kind,
        playFabId: historicalOperation.playFabId,
        operationId: historicalOperation.operationId,
        eventId: historicalOperation.eventId,
        reason: historicalOperation.reason,
        diamonds: historicalOperation.diamonds,
        eliteBall: historicalOperation.eliteBall,
        premium: historicalOperation.premium,
        createdAtUnixMs: historicalOperation.createdAtUnixMs
    };
    const trustedOperation = { ...currentImmutable, immutableHash: serverEconomyPocDigest(currentImmutable) };
    return {
        provider: {
            titleId: C.titleId,
            playFabId: C.playFabId,
            snapshot: {
                diamonds: C.targetDiamonds,
                revision: C.targetRevision,
                highValueAppliedThroughSequence: C.providerCursor
            },
            operationProof: { verified: false, reason: "missing" },
            operationMarker: null,
            operationResultHash: null,
            migrationProof: {
                schemaVersion: C.migrationProofSchemaVersion,
                state: "Completed",
                titleId: C.titleId,
                playFabId: C.playFabId,
                domain: C.domain,
                targetValue: C.targetDiamonds,
                targetRevision: C.targetRevision,
                targetOnlyOperationCount: C.targetOnlyOperationCount,
                latestTargetOperation: { h: OTHER_HASH, d: -10 }
            }
        },
        redis: {
            operationRecord: inboxRecord(),
            sequenceCounter: C.historicalReservedSequence,
            operationIndexScore: C.originalSequence,
            rebasedSequenceOccupied: false,
            indexEntryCount: 1,
            inboxOperationCount: 1,
            pendingInboxOperationCount: 1,
            rebasedSequenceRecordCount: 0,
            targetOperationDiscovered: true,
            rebaseAudit: null,
            originalArchive: null,
            rebaseJournal: null,
            activeBinding: null,
            playerIdentity: null,
            playerRegistered: false,
            providerGuardRecord: providerGuardRecord(),
            eventIndexRecord: eventIndexRecord(),
            resolutionRecord: null,
            ledgerWrapper: ledgerWrapper()
        },
        trusted: {
            transaction: { providerTransactionId: C.providerTransactionId },
            receipt: { providerTransactionId: C.providerTransactionId, userId: C.playFabId },
            product: { sku: C.sku, planVersion: C.planVersion, planHash: C.planHash },
            operation: trustedOperation
        },
        provenance: {
            persistenceDigest: "5".repeat(64),
            totalBytes: C.persistenceAofBytes,
            fileCount: 1,
            aofSha256: C.persistenceAofSha256,
            aofBytes: C.persistenceAofBytes,
            allocatorHistory: {
                counterBeforeAllocation: C.historicalCounterBeforeAllocation,
                incrementReservedSequence: C.historicalReservedSequence,
                persistedOperationSequence: C.originalSequence,
                persistedIndexSequence: C.originalSequence,
                rebasedSequenceRecordAbsent: true
            }
        }
    };
}

function plan(source = evidence()) {
    return createHistoricalXsd2SequenceRebasePlan({
        evidence: source,
        rebasedAtUnixMs: 1_787_500_000_000,
        operatorMarker: "codex:sandbox:historical-sequence-rebase"
    });
}

function errorCode(expected) {
    return (error) => error?.code === expected;
}

function errorCodeOneOf(...expected) {
    return (error) => expected.includes(error?.code);
}

function digest(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

class FakeAtomicRedis {
    constructor(source = evidence()) {
        this.keys = historicalSequenceRebaseRedisKeys();
        this.values = new Map([
            [this.keys.operation, JSON.stringify(source.redis.operationRecord)],
            [this.keys.providerGuard, JSON.stringify(source.redis.providerGuardRecord)],
            [this.keys.ledger, JSON.stringify(source.redis.ledgerWrapper)],
            [this.keys.eventIndex, JSON.stringify(source.redis.eventIndexRecord)]
        ]);
        if (source.redis.sequenceCounter !== null) {
            this.values.set(this.keys.sequence, String(source.redis.sequenceCounter));
        }
        this.index = new Map();
        if (source.redis.operationIndexScore !== null) {
            this.index.set(this.keys.operation, source.redis.operationIndexScore);
        }
        this.sets = new Map();
        if (source.redis.playerIdentity !== null && source.redis.playerIdentity !== undefined) {
            this.values.set(this.keys.playerIdentity, source.redis.playerIdentity);
        }
        if (source.redis.playerRegistered === true) {
            this.sets.set(this.keys.players, new Set([this.keys.playerHash]));
        }
        this.evalStatuses = [];
        this.providerWrites = 0;
        this.localAofAcks = 0;
        this.failpoint = null;
        this.aofImage = this.#encodeImage();
    }

    #encodeImage() {
        return JSON.stringify({
            values: [...this.values.entries()],
            index: [...this.index.entries()],
            sets: [...this.sets.entries()].map(([key, values]) => [key, [...values]])
        });
    }

    #loadImage(image) {
        const parsed = JSON.parse(image);
        this.values = new Map(parsed.values);
        this.index = new Map(parsed.index);
        this.sets = new Map(parsed.sets.map(([key, values]) => [key, new Set(values)]));
    }

    exportAofImage() { return this.aofImage; }
    exportRdbImage() { return this.#encodeImage(); }

    static hydrate(image) {
        const redis = new FakeAtomicRedis();
        redis.#loadImage(image);
        redis.aofImage = image;
        redis.evalStatuses = [];
        redis.localAofAcks = 0;
        return redis;
    }

    setFailpoint(name) { this.failpoint = name; }

    installLease(token, epoch) {
        this.values.set(this.keys.lease, JSON.stringify({
            schemaVersion: 1,
            playFabId: C.playFabId,
            tokenDigest: digest(token),
            epoch,
            expiresAtUnixMs: Date.now() + 60_000
        }));
    }

    occupySequence3() {
        this.index.set("another-operation", C.rebasedSequence);
    }

    claimAndAckRebasedOperation(result) {
        const record = JSON.parse(this.values.get(this.keys.operation));
        assert.equal(record.sequence, C.rebasedSequence);
        assert.equal(record.state, "Pending");
        record.state = "Claimed";
        record.claimEpoch += 1;
        record.claimOwner = "simulated-xsd2-consumer";
        record.claimToken = "simulated-xsd2-claim";
        record.claimExpiresAtUnixMs = 1_900_000_060_000;
        this.values.set(this.keys.operation, JSON.stringify(record));
        record.state = "Acked";
        record.result = structuredClone(result);
        record.ackedAtUnixMs = 1_900_000_000_000;
        record.claimExpiresAtUnixMs = null;
        this.values.set(this.keys.operation, JSON.stringify(record));
        this.aofImage = this.#encodeImage();
        return structuredClone(record);
    }

    async sendCommand(command) {
        if (command[0] === "SCAN") {
            const matches = [...this.values.keys()]
                .filter((key) => key.startsWith(this.keys.operationNamespace));
            return ["0", matches];
        }
        if (command[0] === "MGET") return command.slice(1).map((key) => this.values.get(key) ?? null);
        if (command[0] === "SISMEMBER") {
            return this.sets.get(command[1])?.has(command[2]) ? 1 : 0;
        }
        if (command[0] === "ZRANGE") {
            return [...this.index.entries()]
                .sort((left, right) => left[1] - right[1])
                .flatMap(([member, score]) => [member, String(score)]);
        }
        if (command[0] === "WAITAOF") {
            if (this.failpoint === "aof_timeout") return [0, 0];
            this.aofImage = this.#encodeImage();
            this.localAofAcks += 1;
            if (this.failpoint === "after_fsync_before_reply") {
                this.failpoint = null;
                throw Object.assign(new Error("simulated connection loss after AOF fsync"), {
                    code: "SIMULATED_CONNECTION_LOSS"
                });
            }
            return [1, 0];
        }
        if (command[0] !== "EVAL") throw new Error(`Unsupported fake Redis command ${command[0]}`);
        const keys = command.slice(3, 17);
        const args = command.slice(17);
        const lease = JSON.parse(this.values.get(keys[0]) ?? "null");
        if (!lease || lease.tokenDigest !== args[1] || lease.epoch !== Number(args[2]) ||
            lease.expiresAtUnixMs <= Date.now()) {
            this.evalStatuses.push("stale_lease");
            return ["stale_lease"];
        }
        const existingAudit = this.values.get(keys[4]);
        const existingCommitParts = [existingAudit, this.values.get(keys[5]), this.values.get(keys[6]),
            this.values.get(keys[7])].filter((value) => value !== undefined).length;
        if (existingCommitParts > 0) {
            const archiveRaw = this.values.get(keys[5]);
            const journalRaw = this.values.get(keys[6]);
            const bindingRaw = this.values.get(keys[7]);
            const activeRaw = this.values.get(keys[1]);
            const score = this.index.get(keys[1]);
            const sequenceCount = [...this.index.values()]
                .filter((value) => value === Number(args[6])).length;
            const active = JSON.parse(activeRaw ?? "null");
            const pendingLifecycle = active?.state === "Pending" && active.result === null &&
                active.ackedAtUnixMs === null && active.claimOwner === null && active.claimToken === null &&
                active.claimExpiresAtUnixMs === null;
            const claimedLifecycle = active?.state === "Claimed" && active.result === null &&
                active.ackedAtUnixMs === null && typeof active.claimOwner === "string" &&
                typeof active.claimToken === "string" && active.claimExpiresAtUnixMs > 0 && active.claimEpoch > 0;
            const ackedLifecycle = active?.state === "Acked" && active.result !== null &&
                active.ackedAtUnixMs >= 0 && active.claimExpiresAtUnixMs === null && active.claimEpoch > 0;
            const valid = existingCommitParts === 4 && existingAudit === args[8] &&
                archiveRaw === args[32] && journalRaw === args[27] && bindingRaw === args[29] &&
                active?.operationId === C.operationId && active?.operation?.immutableHash === C.operationImmutableHash &&
                active?.sequence === Number(args[6]) && active?.originalSequence === Number(args[5]) &&
                active?.activeSequence === Number(args[6]) && active?.sequenceRebase?.auditHash === args[9] &&
                active?.sequenceRebase?.bindingHash === args[30] &&
                (pendingLifecycle || claimedLifecycle || ackedLifecycle) &&
                Number(this.values.get(keys[2])) >= Number(args[6]) &&
                score === Number(args[6]) && sequenceCount === 1 &&
                this.values.get(keys[8]) === args[0] &&
                this.sets.get(keys[9])?.has(args[33]) === true;
            const status = valid ? "existing" : "durable_commit_conflict";
            this.evalStatuses.push(status);
            return valid ? [status, activeRaw, existingAudit, archiveRaw, journalRaw, bindingRaw] : [status];
        }
        if (this.values.has(keys[12])) return ["resolution_conflict"];
        if (this.values.get(keys[10]) !== args[17] || this.values.get(keys[11]) !== args[18] ||
            this.values.get(keys[13]) !== args[23]) return ["trusted_chain_conflict"];
        const raw = this.values.get(keys[1]);
        if (raw !== args[16]) return ["operation_conflict"];
        const ledger = JSON.parse(this.values.get(keys[11]));
        if (ledger.record.leaseOwner !== args[19] || ledger.record.leaseToken !== args[20]) return ["ledger_conflict"];
        if ([...this.index.entries()].some(([member, score]) => member !== keys[1] && score === Number(args[6]))) {
            return ["sequence_occupied"];
        }
        const recoverAllocatorMetadata = args[26] === "1";
        if (recoverAllocatorMetadata) {
            if (this.values.has(keys[2]) || this.index.has(keys[1]) || this.index.size !== 0) {
                return ["allocator_metadata_conflict"];
            }
        } else {
            if (Number(this.values.get(keys[2])) !== Number(args[6])) return ["next_sequence_mismatch"];
            if (this.index.get(keys[1]) !== Number(args[5])) return ["index_conflict"];
        }
        if (this.failpoint === "before_commit" || this.failpoint === "during_atomic_commit") {
            this.failpoint = null;
            throw Object.assign(new Error("simulated crash before atomic commit"), {
                code: "SIMULATED_REDIS_CRASH"
            });
        }
        const nextValues = new Map(this.values);
        const nextIndex = new Map(this.index);
        const nextSets = new Map([...this.sets.entries()].map(([key, values]) => [key, new Set(values)]));
        if (recoverAllocatorMetadata) {
            nextValues.set(keys[2], String(args[6]));
        }
        nextIndex.set(keys[1], Number(args[6]));
        nextValues.set(keys[8], args[0]);
        if (!nextSets.has(keys[9])) nextSets.set(keys[9], new Set());
        nextSets.get(keys[9]).add(args[33]);
        nextValues.set(keys[5], args[32]);
        nextValues.set(keys[4], args[8]);
        nextValues.set(keys[7], args[29]);
        nextValues.set(keys[6], args[27]);
        nextValues.set(keys[1], args[31]);
        this.values = nextValues;
        this.index = nextIndex;
        this.sets = nextSets;
        this.evalStatuses.push("rebased");
        if (this.failpoint === "after_commit_before_reply") {
            this.failpoint = null;
            throw Object.assign(new Error("simulated connection loss after atomic commit"), {
                code: "SIMULATED_CONNECTION_LOSS"
            });
        }
        return ["rebased", args[31], args[8], args[32], args[27], args[29]];
    }
}

function evidenceWithMissingAllocatorMetadata() {
    const source = evidence();
    source.redis.sequenceCounter = null;
    source.redis.operationIndexScore = null;
    source.redis.indexEntryCount = 0;
    source.redis.inboxOperationCount = 1;
    source.redis.pendingInboxOperationCount = 1;
    source.redis.rebasedSequenceRecordCount = 0;
    source.redis.targetOperationDiscovered = true;
    return source;
}

test("certified never-applied evidence proves the orphaned sequence 3 reservation", () => {
    const verified = validateHistoricalXsd2SequenceRebaseEvidence({ evidence: evidence() });
    assert.equal(verified.status, "complete");
    assert.equal(verified.neverApplied, true);
    assert.equal(verified.allocatorBugProven, true);
    assert.equal(verified.orphanedReservationProven, true);
    assert.equal(verified.nextSequence, 3);
});

test("historical Pending seq1 is atomically re-based to the orphaned seq3 and preserves seq1", async () => {
    const source = evidence();
    const original = clone(source.redis.operationRecord);
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-1";
    redis.installLease(token, 9);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const result = await rebaser.rebase({ plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 9, ledgerLeaseToken: LEDGER_LEASE_TOKEN });
    assert.equal(result.status, "rebased");
    assert.equal(result.activeRecord.sequence, 3);
    assert.equal(result.activeRecord.operationId, C.operationId);
    assert.equal(result.activeRecord.operation.immutableHash, C.operationImmutableHash);
    assert.equal(result.originalArchive.originalRecord.sequence, 1);
    assert.deepEqual(result.originalArchive.originalRecord, original);
    assert.equal(result.audit.originalSequence, 1);
    assert.equal(result.audit.rebasedSequence, 3);
    assert.equal(result.audit.reason, "HistoricalSequenceAllocatorBug");
    assert.equal(redis.providerWrites, 0);
});

test("an exact duplicate rebase request is idempotent", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-2";
    redis.installLease(token, 10);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const request = { plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 10, ledgerLeaseToken: LEDGER_LEASE_TOKEN };
    assert.equal((await rebaser.rebase(request)).status, "rebased");
    assert.equal((await rebaser.rebase(request)).status, "already_rebased");
    assert.deepEqual(redis.evalStatuses, ["rebased", "existing"]);
});

test("concurrent rebase requests produce one winner and one idempotent observer", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-3";
    redis.installLease(token, 11);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const request = { plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 11, ledgerLeaseToken: LEDGER_LEASE_TOKEN };
    const results = await Promise.all([rebaser.rebase(request), rebaser.rebase(request)]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ["already_rebased", "rebased"]);
    assert.equal(results[0].activeRecord.sequence, 3);
    assert.equal(results[1].activeRecord.sequence, 3);
});

test("missing allocator counter and index are recovered atomically from certified evidence", async () => {
    const source = evidenceWithMissingAllocatorMetadata();
    const recoveryPlan = plan(source);
    assert.equal(recoveryPlan.allocatorMetadataRecoveryRequired, true);
    assert.equal(recoveryPlan.audit.allocatorMetadataRecovered, true);
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-metadata-recovery";
    redis.installLease(token, 21);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const result = await rebaser.rebase({
        plan: recoveryPlan, playerLeaseToken: token, playerFencingEpoch: 21,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    });
    assert.equal(result.status, "rebased");
    assert.equal(redis.values.get(redis.keys.sequence), "3");
    assert.equal(redis.index.get(redis.keys.operation), 3);
    assert.equal(result.originalArchive.originalRecord.sequence, 1);
    assert.equal(result.audit.redisSequenceCounterBefore, null);
    assert.equal(result.audit.redisOperationIndexScoreBefore, null);
    assert.equal(redis.providerWrites, 0);
    const readback = await rebaser.inspect();
    assert.equal(readback.sequenceCounter, 3);
    assert.equal(readback.operationIndexScore, 3);
    assert.equal(readback.indexEntryCount, 1);
    assert.equal(readback.pendingInboxOperationCount, 1);
    assert.equal(readback.rebasedSequenceRecordCount, 1);
});

test("concurrent allocator recovery has one winner and one idempotent observer", async () => {
    const source = evidenceWithMissingAllocatorMetadata();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-concurrent-metadata-recovery";
    redis.installLease(token, 22);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const request = {
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 22,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    };
    const results = await Promise.all([rebaser.rebase(request), rebaser.rebase(request)]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ["already_rebased", "rebased"]);
    assert.equal(redis.values.get(redis.keys.sequence), "3");
});

for (const [name, mutate] of [
    ["counter-only state", (source) => { source.redis.sequenceCounter = 3; }],
    ["index-only state", (source) => {
        source.redis.operationIndexScore = 1;
        source.redis.indexEntryCount = 1;
    }],
    ["another pending operation", (source) => { source.redis.pendingInboxOperationCount = 2; }],
    ["an existing seq3 record", (source) => { source.redis.rebasedSequenceRecordCount = 1; }],
    ["missing target discovery", (source) => { source.redis.targetOperationDiscovered = false; }]
]) {
    test(`allocator recovery refuses ${name}`, () => {
        const source = evidenceWithMissingAllocatorMetadata();
        mutate(source);
        assert.throws(() => plan(source),
            errorCode("POC_HISTORICAL_REBASE_ALLOCATOR_METADATA_CONFLICT"));
    });
}

test("allocator metadata appearing after preflight is refused atomically", async () => {
    const source = evidenceWithMissingAllocatorMetadata();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-raced-metadata";
    redis.installLease(token, 23);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    redis.index.set("concurrent-operation", 2);
    await assert.rejects(rebaser.rebase({
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 23,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    }), errorCode("POC_HISTORICAL_REBASE_ALLOCATOR_METADATA_CONFLICT"));
    assert.equal(redis.values.has(redis.keys.sequence), false);
    assert.equal(redis.values.has(redis.keys.audit), false);
});

test("a crash after Lua is recognized as an exact already-rebased state", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-crash-rerun";
    redis.installLease(token, 12);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const first = await rebaser.rebase({
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 12,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    });
    assert.equal(first.status, "rebased");
    const rerunEvidence = evidence();
    rerunEvidence.redis = await rebaser.inspect();
    const verified = validateHistoricalXsd2SequenceRebaseEvidence({ evidence: rerunEvidence });
    assert.equal(verified.status, "already_rebased");
    assert.equal(verified.alreadyRebased, true);
    const rerun = await rebaser.rebase({
        plan: plan(rerunEvidence), playerLeaseToken: token, playerFencingEpoch: 12,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    });
    assert.equal(rerun.status, "already_rebased");
    assert.equal(rerun.activeRecord.sequence, 3);
    assert.equal(rerun.originalArchive.originalRecord.sequence, 1);
});

async function applyDurableRebase(redis, source = evidence(), epoch = 30) {
    const token = `durable-lease-${epoch}`;
    redis.installLease(token, epoch);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const result = await rebaser.rebase({
        plan: plan(source),
        playerLeaseToken: token,
        playerFencingEpoch: epoch,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    });
    return { result, rebaser, token };
}

async function assertRestartHydratesActiveThree(redis) {
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    const hydrated = await rebaser.hydrate();
    assert.equal(hydrated.status, "hydrated");
    assert.equal(hydrated.originalSequence, 1);
    assert.equal(hydrated.activeSequence, 3);
    assert.equal(hydrated.operation.sequence, 3);
    assert.equal(hydrated.operation.originalSequence, 1);
    assert.equal(hydrated.operation.activeSequence, 3);
    assert.equal(hydrated.audit.originalSequence, 1);
    assert.equal(hydrated.journal.originalSequence, 1);
    assert.equal(hydrated.journal.activeSequence, 3);
    assert.equal(hydrated.binding.originalSequence, 1);
    assert.equal(hydrated.binding.activeSequence, 3);
    assert.equal(redis.index.get(redis.keys.operation), 3);
    assert.equal(redis.values.get(redis.keys.sequence), "3");
    return hydrated;
}

test("rebase survives a process restart from its fsynced AOF image", async () => {
    const redis = new FakeAtomicRedis(evidence());
    const { result } = await applyDurableRebase(redis);
    assert.equal(result.durability.aofLocalFsync, true);
    assert.equal(redis.localAofAcks, 1);
    const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
    await assertRestartHydratesActiveThree(restarted);
});

test("rebase survives RDB-style hydration", async () => {
    const redis = new FakeAtomicRedis(evidence());
    await applyDurableRebase(redis, evidence(), 31);
    const restarted = FakeAtomicRedis.hydrate(redis.exportRdbImage());
    await assertRestartHydratesActiveThree(restarted);
});

test("double restart preserves active seq3 and immutable seq1 audit", async () => {
    const redis = new FakeAtomicRedis(evidence());
    await applyDurableRebase(redis, evidence(), 32);
    const first = FakeAtomicRedis.hydrate(redis.exportAofImage());
    const second = FakeAtomicRedis.hydrate(first.exportRdbImage());
    const hydrated = await assertRestartHydratesActiveThree(second);
    assert.equal(hydrated.audit.payloadHash, C.operationImmutableHash);
    assert.equal(hydrated.journal.payloadHash, C.operationImmutableHash);
    assert.equal(hydrated.operation.operation.immutableHash, C.operationImmutableHash);
});

test("duplicate rebase after restart is idempotent and keeps active seq3", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    await applyDurableRebase(redis, source, 33);
    const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
    const current = evidence();
    current.redis = await createRedisHistoricalXsd2SequenceRebaser({ redis: restarted }).inspect();
    const token = "restart-idempotent-lease";
    restarted.installLease(token, 34);
    const result = await createRedisHistoricalXsd2SequenceRebaser({ redis: restarted }).rebase({
        plan: plan(current), playerLeaseToken: token, playerFencingEpoch: 34,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    });
    assert.equal(result.status, "already_rebased");
    assert.equal(result.activeRecord.sequence, 3);
    assert.equal(restarted.index.get(restarted.keys.operation), 3);
});

for (const failpoint of ["before_commit", "during_atomic_commit"]) {
    test(`crash ${failpoint.replaceAll("_", " ")} restores the complete pre-rebase state`, async () => {
        const source = evidence();
        const redis = new FakeAtomicRedis(source);
        const token = `crash-${failpoint}`;
        redis.installLease(token, 40);
        redis.setFailpoint(failpoint);
        await assert.rejects(createRedisHistoricalXsd2SequenceRebaser({ redis }).rebase({
            plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 40,
            ledgerLeaseToken: LEDGER_LEASE_TOKEN
        }), errorCode("SIMULATED_REDIS_CRASH"));
        const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
        const hydrated = await createRedisHistoricalXsd2SequenceRebaser({ redis: restarted }).hydrate();
        assert.equal(hydrated.status, "not_rebased");
        assert.equal(JSON.parse(restarted.values.get(restarted.keys.operation)).sequence, 1);
        assert.equal(restarted.values.has(restarted.keys.audit), false);
        assert.equal(restarted.values.has(restarted.keys.journal), false);
    });
}

test("connection loss after atomic commit has only pre-commit AOF or full post-commit RDB", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "crash-after-commit";
    redis.installLease(token, 41);
    redis.setFailpoint("after_commit_before_reply");
    await assert.rejects(createRedisHistoricalXsd2SequenceRebaser({ redis }).rebase({
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 41,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    }), errorCode("SIMULATED_CONNECTION_LOSS"));
    const fromAof = FakeAtomicRedis.hydrate(redis.exportAofImage());
    assert.equal((await createRedisHistoricalXsd2SequenceRebaser({ redis: fromAof }).hydrate()).status,
        "not_rebased");
    const fromRdb = FakeAtomicRedis.hydrate(redis.exportRdbImage());
    await assertRestartHydratesActiveThree(fromRdb);
});

test("connection loss after AOF fsync restarts as fully rebased before ACK", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "crash-after-fsync";
    redis.installLease(token, 42);
    redis.setFailpoint("after_fsync_before_reply");
    await assert.rejects(createRedisHistoricalXsd2SequenceRebaser({ redis }).rebase({
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 42,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    }), errorCode("SIMULATED_CONNECTION_LOSS"));
    const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
    await assertRestartHydratesActiveThree(restarted);
});

test("AOF fsync timeout never reports the rebase as durably committed", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "aof-timeout";
    redis.installLease(token, 43);
    redis.setFailpoint("aof_timeout");
    await assert.rejects(createRedisHistoricalXsd2SequenceRebaser({ redis }).rebase({
        plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 43,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    }), errorCode("POC_HISTORICAL_REBASE_DURABILITY_UNCONFIRMED"));
    assert.equal((await createRedisHistoricalXsd2SequenceRebaser({
        redis: FakeAtomicRedis.hydrate(redis.exportAofImage())
    }).hydrate()).status, "not_rebased");
});

test("provider cursor advancing after plan but before commit is rejected without Redis mutation", async () => {
    const source = evidence();
    const request = plan(source);
    const redis = new FakeAtomicRedis(source);
    const token = "provider-race-lease";
    redis.installLease(token, 48);
    const provider = {
        titleId: C.titleId,
        playFabId: C.playFabId,
        operationId: C.operationId,
        operationHash: C.operationImmutableHash,
        diamonds: 15,
        revision: 3,
        cursor: 2,
        proofAbsent: true
    };
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({
        redis,
        verifyProviderPrecommit: async () => structuredClone(provider)
    });
    provider.cursor = 3;
    await assert.rejects(rebaser.rebase({
        plan: request,
        playerLeaseToken: token,
        playerFencingEpoch: 48,
        ledgerLeaseToken: LEDGER_LEASE_TOKEN
    }), errorCode("POC_HISTORICAL_REBASE_PROVIDER_CHANGED"));
    assert.equal(JSON.parse(redis.values.get(redis.keys.operation)).sequence, 1);
    assert.equal(redis.values.has(redis.keys.audit), false);
    assert.equal(redis.evalStatuses.length, 0);
});

test("simulated seq3 xsd2 applies 15 to 515 once and replay survives restart", async () => {
    const redis = new FakeAtomicRedis(evidence());
    await applyDurableRebase(redis, evidence(), 44);
    const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
    const hydrated = await assertRestartHydratesActiveThree(restarted);
    const provider = {
        diamonds: 15, revision: 3, cursor: 2, proof: null, writes: 0
    };
    function apply(inboxRedis) {
        const inbox = JSON.parse(inboxRedis.values.get(inboxRedis.keys.operation));
        if (inbox.state === "Acked") {
            assert.equal(inbox.result.status, "applied");
            assert.equal(inbox.result.sequence, C.rebasedSequence);
            return "already_acked";
        }
        if (provider.proof) {
            assert.equal(provider.proof.operationId, C.operationId);
            assert.equal(provider.proof.payloadHash, C.operationImmutableHash);
            assert.equal(provider.proof.sequence, hydrated.activeSequence);
            return "already_applied";
        }
        assert.equal(provider.cursor + 1, hydrated.activeSequence);
        provider.diamonds += C.diamondsDelta;
        provider.revision += 1;
        provider.cursor = hydrated.activeSequence;
        provider.proof = {
            operationId: C.operationId,
            payloadHash: C.operationImmutableHash,
            sequence: hydrated.activeSequence
        };
        provider.writes += 1;
        inboxRedis.claimAndAckRebasedOperation({
            status: "applied",
            sequence: hydrated.activeSequence,
            balance: provider.diamonds,
            revision: provider.revision
        });
        return "applied";
    }
    assert.equal(apply(restarted), "applied");
    assert.deepEqual(provider, {
        diamonds: 515, revision: 4, cursor: 3,
        proof: { operationId: C.operationId, payloadHash: C.operationImmutableHash, sequence: 3 },
        writes: 1
    });
    const secondRestart = FakeAtomicRedis.hydrate(restarted.exportAofImage());
    const afterAck = await assertRestartHydratesActiveThree(secondRestart);
    assert.equal(afterAck.operation.state, "Acked");
    assert.equal(afterAck.operation.result.balance, 515);
    assert.equal(apply(secondRestart), "already_acked");
    assert.equal(provider.diamonds, 515);
    assert.equal(provider.writes, 1);
});

for (const [label, mutate] of [
    ["active record", (request) => { request.persisted.activeRecord.operation.diamonds = 501; }],
    ["active binding", (request) => { request.persisted.activeBinding.activeSequence = 4; }],
    ["original archive", (request) => { request.persisted.originalArchive.originalSequence = 2; }],
    ["rebase journal", (request) => { request.persisted.rebaseJournal.reason = "tampered"; }]
]) {
    test(`tampered persisted plan ${label} is rejected before Redis commit`, async () => {
        const source = evidence();
        const redis = new FakeAtomicRedis(source);
        const request = structuredClone(plan(source));
        mutate(request);
        await assert.rejects(createRedisHistoricalXsd2SequenceRebaser({ redis }).rebase({
            plan: request,
            playerLeaseToken: "unused-plan-rejection-token",
            playerFencingEpoch: 50,
            ledgerLeaseToken: LEDGER_LEASE_TOKEN
        }), errorCode("POC_HISTORICAL_REBASE_PLAN_INVALID"));
        assert.equal(JSON.parse(redis.values.get(redis.keys.operation)).sequence, 1);
        assert.equal(redis.values.has(redis.keys.audit), false);
        assert.equal(redis.evalStatuses.length, 0);
    });
}

for (const [name, corrupt] of [
    ["counter regression", (redis) => redis.values.set(redis.keys.sequence, "2")],
    ["sequence uniqueness", (redis) => redis.index.set("another-operation", C.rebasedSequence)],
    ["active record", (redis) => {
        const value = JSON.parse(redis.values.get(redis.keys.operation));
        value.operation.immutableHash = OTHER_HASH;
        redis.values.set(redis.keys.operation, JSON.stringify(value));
    }],
    ["audit", (redis) => {
        const value = JSON.parse(redis.values.get(redis.keys.audit));
        value.reason = "tampered";
        redis.values.set(redis.keys.audit, JSON.stringify(value));
    }],
    ["archive", (redis) => {
        const value = JSON.parse(redis.values.get(redis.keys.archive));
        value.originalRecord.sequence = 2;
        redis.values.set(redis.keys.archive, JSON.stringify(value));
    }]
]) {
    test(`an idempotent rerun refuses corrupted ${name} metadata`, async () => {
        const source = evidence();
        const redis = new FakeAtomicRedis(source);
        const token = `lease-token-corrupt-${name.replaceAll(" ", "-")}`;
        redis.installLease(token, 13);
        const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
        const request = {
            plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 13,
            ledgerLeaseToken: LEDGER_LEASE_TOKEN
        };
        assert.equal((await rebaser.rebase(request)).status, "rebased");
        corrupt(redis);
        await assert.rejects(rebaser.rebase(request),
            errorCodeOneOf(
                "POC_HISTORICAL_REBASE_DURABLE_COMMIT_CONFLICT",
                "POC_HISTORICAL_REBASE_TRUSTED_CHAIN_CONFLICT"
            ));
    });
}

test("the CLI validates the real payment-ledger acquire result shape", () => {
    const token = "real-ledger-shape-token";
    const record = {
        state: "Failed", leaseOwner: C.ledgerLeaseOwner, leaseToken: token
    };
    const validated = validateAcquiredHistoricalRebaseLedgerLease({ status: "acquired", record }, token);
    assert.equal(validated.acquired, true);
    assert.equal(validated.record, record);
    assert.throws(() => validateAcquiredHistoricalRebaseLedgerLease({ status: "acquired", ...record }, token),
        errorCode("DIAMONDS_HISTORICAL_REBASE_LEDGER_LEASE_FAILED"));
});

function durableAofContinuation() {
    const keys = historicalSequenceRebaseRedisKeys();
    const durablePlan = plan(evidence());
    return [
        ["MULTI"],
        ["SET", keys.sequence, "3"],
        ["ZADD", keys.index, "3", keys.operation],
        ["SET", keys.archive, JSON.stringify(durablePlan.persisted.originalArchive)],
        ["SET", keys.audit, JSON.stringify(durablePlan.audit)],
        ["SET", keys.activeBinding, JSON.stringify(durablePlan.persisted.activeBinding)],
        ["SET", keys.journal, JSON.stringify(durablePlan.persisted.rebaseJournal)],
        ["SET", keys.playerIdentity, C.playFabId],
        ["SADD", keys.players, keys.playerHash],
        ["SET", keys.operation, JSON.stringify(durablePlan.persisted.activeRecord)],
        ["EXEC"]
    ];
}

test("AOF validator accepts the exact atomic V2 rebase continuation", () => {
    const result = validateHistoricalRebaseAofContinuation(durableAofContinuation());
    assert.equal(result.durableRebaseCommitCount, 1);
    assert.deepEqual(result.durableRebaseCommit, {
        operationId: C.operationId,
        payloadHash: C.operationImmutableHash,
        originalSequence: 1,
        activeSequence: 3,
        auditHash: plan(evidence()).audit.auditHash,
        bindingHash: plan(evidence()).persisted.activeBinding.bindingHash,
        journalHash: plan(evidence()).persisted.rebaseJournal.journalHash
    });
});

test("AOF durable commit with live pre-rebase Redis fails closed as lost hydration", () => {
    const aof = {
        continuation: validateHistoricalRebaseAofContinuation(durableAofContinuation())
    };
    assert.throws(() => selectHistoricalPersistenceProvenance({ redis: evidence().redis, aof }),
        errorCode("DIAMONDS_HISTORICAL_REBASE_HYDRATION_MISMATCH"));
});

test("AOF durable commit with hydrated active seq3 uses the journal attestation", async () => {
    const redis = new FakeAtomicRedis(evidence());
    await applyDurableRebase(redis, evidence(), 49);
    const restarted = FakeAtomicRedis.hydrate(redis.exportAofImage());
    const live = await createRedisHistoricalXsd2SequenceRebaser({ redis: restarted }).inspect();
    const aof = {
        continuation: validateHistoricalRebaseAofContinuation(durableAofContinuation())
    };
    const selected = selectHistoricalPersistenceProvenance({ redis: live, aof });
    assert.equal(selected.source, "durable_rebase_journal");
    assert.equal(selected.allocatorHistory.persistedOperationSequence, 1);
});

test("AOF validator rejects a partial V2 rebase commit", () => {
    const commands = durableAofContinuation().filter((command) =>
        command[1] !== historicalSequenceRebaseRedisKeys().journal);
    assert.throws(() => validateHistoricalRebaseAofContinuation(commands),
        errorCode("DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE"));
});

test("AOF validator rejects a conflicting durable payload", () => {
    const keys = historicalSequenceRebaseRedisKeys();
    const commands = durableAofContinuation();
    const journalCommand = commands.find((command) => command[1] === keys.journal);
    const journal = JSON.parse(journalCommand[2]);
    journal.payloadHash = OTHER_HASH;
    journalCommand[2] = JSON.stringify(journal);
    assert.throws(() => validateHistoricalRebaseAofContinuation(commands),
        errorCode("DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE"));
});

test("AOF validator rejects an unknown mutation after the certified prefix", () => {
    assert.throws(() => validateHistoricalRebaseAofContinuation([
        ["SET", "untrusted:key", "value"]
    ]), errorCode("DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE"));
});

test("provider proof present refuses metadata rebase", () => {
    const source = evidence();
    source.provider.operationProof = { verified: true, reason: "exact" };
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_PROVIDER_APPLIED"));
});

test("provider cursor advanced to seq3 refuses the certified rebase", () => {
    const source = evidence();
    source.provider.snapshot.highValueAppliedThroughSequence = 3;
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE"));
});

test("payload mismatch refuses metadata rebase", () => {
    const source = evidence();
    source.redis.operationRecord.operation.diamonds = 501;
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE"));
});

test("an ACKed transaction refuses metadata rebase", () => {
    const source = evidence();
    source.redis.operationRecord.state = "Acked";
    source.redis.operationRecord.result = { status: "applied" };
    source.redis.operationRecord.ackedAtUnixMs = 1_787_500_000_000;
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_NOT_PENDING"));
});

test("an applied ledger checkpoint refuses metadata rebase", () => {
    const source = evidence();
    source.redis.ledgerWrapper.record.stepJournal.diamonds_target_granted = {
        status: "StepApplied", resultHash: OTHER_HASH, result: { status: "applied" }
    };
    source.redis.ledgerWrapper.record.checkpoints.diamonds_target_granted = {
        resultHash: OTHER_HASH, result: { status: "applied" }
    };
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_PROVIDER_APPLIED"));
});

test("a payload hash bound to another transaction refuses metadata rebase", () => {
    const source = evidence();
    source.redis.operationRecord.operation.immutableHash = "6".repeat(64);
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_HASH_MISMATCH"));
});

test("a concurrently occupied seq3 is refused without changing the historical record", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const token = "lease-token-4";
    redis.installLease(token, 12);
    redis.occupySequence3();
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    await assert.rejects(
        rebaser.rebase({ plan: plan(source), playerLeaseToken: token, playerFencingEpoch: 12, ledgerLeaseToken: LEDGER_LEASE_TOKEN }),
        errorCode("POC_HISTORICAL_REBASE_SEQUENCE_OCCUPIED")
    );
    assert.equal(JSON.parse(redis.values.get(redis.keys.operation)).sequence, 1);
    assert.equal(redis.values.has(redis.keys.audit), false);
});

test("stale candidate lease is rejected before any metadata mutation", async () => {
    const source = evidence();
    const redis = new FakeAtomicRedis(source);
    const rebaser = createRedisHistoricalXsd2SequenceRebaser({ redis });
    await assert.rejects(
        rebaser.rebase({ plan: plan(source), playerLeaseToken: "missing", playerFencingEpoch: 13, ledgerLeaseToken: LEDGER_LEASE_TOKEN }),
        errorCode("POC_STALE_WRITER")
    );
    assert.equal(JSON.parse(redis.values.get(redis.keys.operation)).sequence, 1);
});

test("an existing gameplay resolution refuses Inbox-only metadata rebase", () => {
    const source = evidence();
    source.redis.resolutionRecord = { schemaVersion: 1, operationId: C.operationId, sequence: 1 };
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_RESOLUTION_CONFLICT"));
});

test("a missing dedicated ledger lease refuses plan creation", () => {
    const source = evidence();
    source.redis.ledgerWrapper.record.leaseOwner = null;
    source.redis.ledgerWrapper.record.leaseToken = null;
    source.redis.ledgerWrapper.record.leaseExpiresAtUnixMs = null;
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_LEDGER_LEASE_REQUIRED"));
});

test("an event-index mismatch refuses metadata rebase", () => {
    const source = evidence();
    source.redis.eventIndexRecord.intent.operationId = "different-operation";
    assert.throws(() => plan(source), errorCode("POC_HISTORICAL_REBASE_EVIDENCE_INCOMPLETE"));
});
