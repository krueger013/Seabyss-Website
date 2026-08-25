import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "redis";

import { createRealDiamondsCanonicalRuntime } from "./src/diamonds-domain-server-composition.js";
import { createTrustedXsollaV2PaymentResolver } from "./src/financial-shadow-payment-producer.js";
import { createPaymentLedger } from "./src/payment-ledger.js";
import { createRedisPaymentLedgerStore } from "./src/payment-ledger-redis-store.js";
import { createPlayFabXsollaV2ReceiptReader } from "./src/playfab-xsolla-v2-receipt-reader.js";
import { parseRedisRespAof } from "./src/diamonds-canary-spend10-recovery-harness.js";
import {
    createFinancialCanaryRedisRuntimeContract,
    verifyFinancialCanaryRedisRuntime
} from "./src/financial-canary-redis-durability-contract.js";
import {
    CANARY02_XSD2_HISTORICAL_REBASE_CONTRACT as C,
    createHistoricalXsd2SequenceRebasePlan,
    createRedisHistoricalXsd2SequenceRebaser,
    historicalSequenceRebaseRedisKeys,
    validateHistoricalXsd2SequenceRebaseEvidence
} from "./src/server-economy-poc-historical-sequence-rebase.js";

const TARGET_PREFIX = "seabyss:financial:diamonds:sandbox-canary:v1:";
const LEDGER_PREFIX = "seabyss:payments:diamonds:sandbox-canary:v1:";
const AOF_FILENAME = "financial-canary.aof.1.incr.aof";
const OPERATOR_MARKER = "codex:sandbox:historical-sequence-rebase";
const LEDGER_IDENTITY = Object.freeze({
    provider: C.provider,
    providerTransactionId: C.providerTransactionId
});
const OFF_GATES = Object.freeze([
    "ShopPurchasesEnabled", "SHOP_PURCHASES_ENABLED", "PURCHASES_GLOBAL_ENABLED",
    "PURCHASES_DIAMOND_ENABLED", "PURCHASES_STARTER_ENABLED", "PURCHASES_PREMIUM_ENABLED",
    "PURCHASES_DOUBLER_ENABLED", "XSOLLA_HARDENED_CATALOG_ENABLED",
    "XSOLLA_CHECKOUT_SANDBOX_ENABLED", "XSOLLA_CHECKOUT_PRODUCTION_ENABLED",
    "XSOLLA_ALLOW_SANDBOX_GRANTS", "XSOLLA_ALLOW_STARTER_SANDBOX_GRANTS",
    "XSOLLA_ALLOW_STARTER_PRODUCTION_GRANTS", "XSOLLA_ALLOW_DIAMOND_PRODUCTION_GRANTS",
    "PAYMENT_WORKER_ENABLED", "PLAYFAB_ECONOMY_V2_ENABLED",
    "PLAYFAB_FINANCIAL_AUTHORITY_V2_ENABLED", "PLAYFAB_FINANCIAL_AUTHORITY_CUTOVER_ENABLED",
    "FINANCIAL_SHADOW_MODE_ENABLED", "FINANCIAL_DIAMONDS_CUTOVER_ENABLED",
    "FINANCIAL_DIAMONDS_MIGRATION_ENABLED", "FINANCIAL_ELITE_CUTOVER_ENABLED",
    "FINANCIAL_PREMIUM_CUTOVER_ENABLED", "FINANCIAL_ELITE_CANARY_ENABLED",
    "FINANCIAL_PREMIUM_CANARY_ENABLED", "SEABYSS_DIAMONDS_SANDBOX_CANARY_PROVIDER_WRITES_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_APPLY_ENABLED",
    "SEABYSS_DIAMONDS_SANDBOX_CANARY_STALE_LEGACY_WRITE_ENABLED"
]);

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requireCondition(condition, code, message) {
    if (!condition) throw coded(code, message);
}

function text(value, name, maximum = 4096) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw coded("DIAMONDS_HISTORICAL_REBASE_ENV_INVALID", `${name} is absent or invalid.`);
    }
    return value;
}

function off(environment, name) {
    const value = environment[name];
    if (value === undefined || value === null || value === "" || value === "false") return;
    throw coded("DIAMONDS_HISTORICAL_REBASE_UNSAFE_GATE", `${name} must remain false.`);
}

function loopbackRedisUrl(value, expectedPort) {
    const selected = text(value, "FINANCIAL_REDIS_URL", 8192);
    let parsed;
    try { parsed = new URL(selected); } catch {
        throw coded("DIAMONDS_HISTORICAL_REBASE_REDIS_INVALID", "Redis URL is invalid.");
    }
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) ||
        !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) || !parsed.password ||
        Number(parsed.port) !== expectedPort) {
        throw coded("DIAMONDS_HISTORICAL_REBASE_REDIS_NOT_ISOLATED",
            "Historical rebase requires the exact authenticated canary02 Redis endpoint.");
    }
    return selected;
}

function exactAofPath(environment) {
    const localAppData = resolve(text(environment.LOCALAPPDATA, "LOCALAPPDATA", 1024));
    const expectedRoot = resolve(localAppData, "SeabyssCodex", "financial-canary-memurai", "canary02");
    const selected = resolve(environment.SEABYSS_DIAMONDS_HISTORICAL_REBASE_AOF_PATH ||
        resolve(expectedRoot, "runtime", "data", "appendonlydir", AOF_FILENAME));
    const pathRelative = relative(expectedRoot, selected);
    if (!isAbsolute(selected) || pathRelative === "" || pathRelative === ".." ||
        pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative) || basename(selected) !== AOF_FILENAME) {
        throw coded("DIAMONDS_HISTORICAL_REBASE_AOF_PATH_INVALID",
            "AOF must be the exact isolated canary02 append-only file.");
    }
    return selected;
}

function readEnvironment(mode, environment = process.env) {
    if (!new Set(["preflight", "apply"]).has(mode)) {
        throw coded("DIAMONDS_HISTORICAL_REBASE_MODE_INVALID", "Mode must be preflight or apply.");
    }
    const titleId = text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID,
        "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_TITLE_ID", 64);
    const singular = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_ID", 160);
    const plural = text(environment.FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS,
        "FINANCIAL_DIAMONDS_CANARY_PLAYFAB_IDS", 160);
    requireCondition(titleId === C.titleId && titleId !== C.productionTitleId,
        "DIAMONDS_HISTORICAL_REBASE_TITLE_FORBIDDEN", "Only isolated Sandbox 1D0C16 is accepted.");
    requireCondition(singular === C.playFabId && plural === C.playFabId &&
        !singular.includes("*") && !singular.includes(","),
        "DIAMONDS_HISTORICAL_REBASE_CANARY_INVALID", "One exact canary_02 PlayFabId is required.");
    requireCondition(environment.NODE_ENV !== "production" &&
        environment.FINANCIAL_DIAMONDS_MODE === "Canary" &&
        environment.FINANCIAL_DIAMONDS_CANARY_ENABLED === "true" &&
        environment.FINANCIAL_ELITE_MODE === "Legacy" && environment.FINANCIAL_PREMIUM_MODE === "Legacy",
        "DIAMONDS_HISTORICAL_REBASE_DOMAIN_MODE_INVALID",
        "Exact Sandbox Canary/Legacy domain modes are required.");
    for (const gate of OFF_GATES) off(environment, gate);
    if (mode === "preflight") {
        requireCondition(environment.SEABYSS_DIAMONDS_HISTORICAL_SEQUENCE_REBASE_PREFLIGHT_ENABLED === "true",
            "DIAMONDS_HISTORICAL_REBASE_PREFLIGHT_ENABLE_REQUIRED",
            "Explicit read-only preflight enable is required.");
        off(environment, "SEABYSS_DIAMONDS_HISTORICAL_SEQUENCE_REBASE_ENABLED");
    } else {
        requireCondition(environment.SEABYSS_DIAMONDS_HISTORICAL_SEQUENCE_REBASE_ENABLED === "true",
            "DIAMONDS_HISTORICAL_REBASE_ENABLE_REQUIRED", "Explicit metadata rebase enable is required.");
        off(environment, "SEABYSS_DIAMONDS_HISTORICAL_SEQUENCE_REBASE_PREFLIGHT_ENABLED");
    }
    const redisRuntime = createFinancialCanaryRedisRuntimeContract({
        localAppData: environment.LOCALAPPDATA,
        runtimeRoot: environment.SEABYSS_FINANCIAL_CANARY_REDIS_RUNTIME_ROOT || null
    });
    const statePath = resolve(redisRuntime.runtimeDirectory, "state.json");
    const redisState = parseJson(readFileSync(statePath, "utf8"), "canary02 Redis state file");
    return Object.freeze({
        mode,
        titleId,
        playFabId: singular,
        secretKey: text(environment.PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY,
            "PLAYFAB_SEABYSS_FINANCIAL_SANDBOX_SECRET_KEY", 4096),
        redisUrl: loopbackRedisUrl(
            environment.FINANCIAL_REDIS_URL || environment.TEST_REDIS_URL,
            redisRuntime.port
        ),
        redisRuntime,
        redisState,
        aofPath: exactAofPath(environment)
    });
}

function sha256Buffer(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function parseJson(value, label) {
    try {
        const parsed = JSON.parse(value);
        requireCondition(parsed && typeof parsed === "object" && !Array.isArray(parsed),
            "DIAMONDS_HISTORICAL_REBASE_AOF_INVALID", `${label} is malformed.`);
        return parsed;
    } catch (error) {
        if (error?.code) throw error;
        throw coded("DIAMONDS_HISTORICAL_REBASE_AOF_INVALID", `${label} is malformed.`);
    }
}

export function validateHistoricalRebaseAofContinuation(commands) {
    const keys = historicalSequenceRebaseRedisKeys();
    const selfTestKey = /^seabyss:financial-canary:selftest:(?:value|lease):[a-f0-9]{32}$/u;
    const leaseEpochKey = `${keys.lease}-epoch`;
    const runtimeIdentityKey = "seabyss:financial-canary:runtime-identity:v1";
    let transactionOpen = false;
    let transactionWrites = new Set();
    let transactionRecords = Object.create(null);
    let durableRebaseCommit = null;
    let durableRebaseCommitCount = 0;
    const markRebaseWrite = (name, value = true) => {
        requireCondition(transactionOpen,
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
            "Historical rebase metadata must be one atomic Redis transaction.");
        transactionWrites.add(name);
        transactionRecords[name] = value;
    };
    for (const command of commands) {
        const name = String(command[0] || "").toUpperCase();
        const key = command[1];
        if (name === "SELECT") {
            requireCondition(command.length === 2 && key === "0" && !transactionOpen,
                "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
                "AOF continuation selects an unexpected Redis database.");
            continue;
        }
        if (name === "MULTI") {
            requireCondition(command.length === 1 && !transactionOpen,
                "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "Nested AOF MULTI is forbidden.");
            transactionOpen = true;
            transactionWrites = new Set();
            transactionRecords = Object.create(null);
            continue;
        }
        if (name === "EXEC") {
            requireCondition(command.length === 1 && transactionOpen,
                "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "Unmatched AOF EXEC is forbidden.");
            if (transactionWrites.size > 0) {
                const durableV2 = transactionWrites.has("journal") || transactionWrites.has("binding");
                const required = durableV2
                    ? ["index", "archive", "audit", "journal", "binding", "identity", "players", "operation"]
                    : ["index", "archive", "audit", "operation"];
                requireCondition(required.every((item) => transactionWrites.has(item)),
                    "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
                    "AOF contains a partial historical rebase transaction.");
                if (durableV2) {
                    const active = transactionRecords.operation;
                    const audit = transactionRecords.audit;
                    const archive = transactionRecords.archive;
                    const journal = transactionRecords.journal;
                    const binding = transactionRecords.binding;
                    requireCondition(active.sequenceRebase?.auditHash === audit.auditHash &&
                        active.sequenceRebase?.bindingHash === binding.bindingHash &&
                        archive.auditHash === audit.auditHash && journal.auditHash === audit.auditHash &&
                        journal.bindingHash === binding.bindingHash &&
                        journal.operationId === active.operationId && binding.operationId === active.operationId &&
                        journal.payloadHash === active.operation.immutableHash &&
                        binding.payloadHash === active.operation.immutableHash,
                    "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
                    "AOF durable rebase records do not form one immutable commit.");
                    const summary = Object.freeze({
                        operationId: active.operationId,
                        payloadHash: active.operation.immutableHash,
                        originalSequence: active.originalSequence,
                        activeSequence: active.activeSequence,
                        auditHash: audit.auditHash,
                        bindingHash: binding.bindingHash,
                        journalHash: journal.journalHash
                    });
                    if (durableRebaseCommit !== null) {
                        requireCondition(JSON.stringify(durableRebaseCommit) === JSON.stringify(summary),
                            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
                            "AOF contains conflicting durable rebase commits.");
                    }
                    durableRebaseCommit = summary;
                    durableRebaseCommitCount += 1;
                }
            }
            transactionOpen = false;
            transactionWrites = new Set();
            transactionRecords = Object.create(null);
            continue;
        }
        if (name === "SET" && selfTestKey.test(key)) {
            requireCondition(command.length === 5 && new Set(["PX", "PXAT"]).has(String(command[3]).toUpperCase()) &&
                Number(command[4]) > 0, "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
            "AOF self-test SET is malformed.");
            continue;
        }
        if (name === "DEL" && command.slice(1).every((item) => selfTestKey.test(item))) continue;
        if (name === "SET" && key === keys.ledger) {
            const wrapper = parseJson(command[2], "continued payment ledger");
            requireCondition(wrapper.immutableHash === C.ledgerImmutableHash &&
                wrapper.record?.providerTransactionId === C.providerTransactionId &&
                wrapper.record?.receiptId === C.receiptId && wrapper.record?.playFabId === C.playFabId &&
                wrapper.record?.planHash === C.planHash,
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF ledger continuation is untrusted.");
            continue;
        }
        if (name === "SET" && key === leaseEpochKey) {
            requireCondition(command.length === 3 && Number(command[2]) >= 1,
                "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF lease epoch is invalid.");
            continue;
        }
        if (name === "INCR" && key === leaseEpochKey && command.length === 2) continue;
        if (name === "SET" && key === keys.lease) {
            const lease = parseJson(command[2], "continued player lease");
            requireCondition(lease.schemaVersion === 1 && lease.playFabId === C.playFabId &&
                /^[a-f0-9]{64}$/u.test(lease.tokenDigest) && Number.isSafeInteger(lease.epoch) && lease.epoch > 0 &&
                command.length === 5 && new Set(["PX", "PXAT"]).has(String(command[3]).toUpperCase()),
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF player lease is invalid.");
            continue;
        }
        if (name === "DEL" && command.length === 2 && key === keys.lease) continue;
        if (name === "SET" && key === keys.sequence) {
            requireCondition(command.length === 3 && Number(command[2]) === C.rebasedSequence,
                "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF active counter is not seq3.");
            markRebaseWrite("counter");
            continue;
        }
        if (name === "ZREM" && key === keys.index && command.length === 3 && command[2] === keys.operation) {
            markRebaseWrite("index");
            continue;
        }
        if (name === "ZADD" && key === keys.index) {
            requireCondition(command.length === 4 && Number(command[2]) === C.rebasedSequence &&
                command[3] === keys.operation, "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
            "AOF active sequence index is invalid.");
            markRebaseWrite("index");
            continue;
        }
        if (name === "SET" && key === keys.audit) {
            const audit = parseJson(command[2], "continued rebase audit");
            requireCondition(audit.operationId === C.operationId && audit.payloadHash === C.operationImmutableHash &&
                audit.originalSequence === 1 && audit.rebasedSequence === 3 &&
                audit.providerCursorAtRebase === 2 && audit.reason === C.reason &&
                /^[a-f0-9]{64}$/u.test(audit.auditHash),
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF rebase audit is invalid.");
            markRebaseWrite("audit", audit);
            continue;
        }
        if (name === "SET" && key === keys.archive) {
            const archive = parseJson(command[2], "continued original archive");
            requireCondition(archive.kind === "HistoricalSequenceRebaseArchive" &&
                archive.originalRecord?.operationId === C.operationId &&
                archive.originalRecord?.sequence === 1 &&
                archive.originalRecord?.operation?.immutableHash === C.operationImmutableHash,
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF original archive is invalid.");
            markRebaseWrite("archive", archive);
            continue;
        }
        if (name === "SET" && key === keys.operation) {
            const active = parseJson(command[2], "continued active operation");
            requireCondition(active.operationId === C.operationId && active.sequence === 3 &&
                active.operation?.immutableHash === C.operationImmutableHash && active.state === "Pending" &&
                active.result === null && active.ackedAtUnixMs === null && active.sequenceRebase,
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF active operation is invalid.");
            markRebaseWrite("operation", active);
            continue;
        }
        if (name === "SET" && key === keys.journal) {
            const journal = parseJson(command[2], "continued rebase journal");
            requireCondition(journal.kind === "HistoricalSequenceRebaseCommit" &&
                journal.operationId === C.operationId && journal.payloadHash === C.operationImmutableHash &&
                journal.originalSequence === 1 && journal.activeSequence === 3 &&
                /^[a-f0-9]{64}$/u.test(journal.journalHash),
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF rebase journal is invalid.");
            markRebaseWrite("journal", journal);
            continue;
        }
        if (name === "SET" && key === keys.activeBinding) {
            const binding = parseJson(command[2], "continued active binding");
            requireCondition(binding.kind === "HistoricalSequenceActiveBinding" &&
                binding.operationId === C.operationId && binding.payloadHash === C.operationImmutableHash &&
                binding.originalSequence === 1 && binding.activeSequence === 3 &&
                /^[a-f0-9]{64}$/u.test(binding.bindingHash),
            "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE", "AOF active binding is invalid.");
            markRebaseWrite("binding", binding);
            continue;
        }
        if (name === "SET" && key === keys.playerIdentity && command[2] === C.playFabId) {
            markRebaseWrite("identity");
            continue;
        }
        if (name === "SADD" && key === keys.players && command.length === 3 && command[2] === keys.playerHash) {
            markRebaseWrite("players");
            continue;
        }
        if (name === "SET" && key === runtimeIdentityKey && /^canary02-[a-f0-9]{32}$/u.test(command[2])) continue;
        throw coded("DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
            `AOF continuation command ${name || "<empty>"} is not part of the exact rebase lifecycle.`);
    }
    requireCondition(!transactionOpen, "DIAMONDS_HISTORICAL_REBASE_AOF_CONTINUATION_UNSAFE",
        "AOF continuation ends inside MULTI.");
    return Object.freeze({
        durableRebaseCommitCount,
        durableRebaseCommit
    });
}

export function readCertifiedAof(aofPath) {
    const buffer = readFileSync(aofPath);
    const digest = sha256Buffer(buffer);
    requireCondition(buffer.length >= C.persistenceAofBytes,
        "DIAMONDS_HISTORICAL_REBASE_AOF_DIGEST_MISMATCH",
        "The preserved canary02 AOF is shorter than the certified historical evidence.");
    const certifiedPrefix = buffer.subarray(0, C.persistenceAofBytes);
    const certifiedDigest = sha256Buffer(certifiedPrefix);
    requireCondition(certifiedDigest === C.persistenceAofSha256,
        "DIAMONDS_HISTORICAL_REBASE_AOF_DIGEST_MISMATCH",
        "The certified canary02 AOF prefix differs from the historical evidence.");
    const certifiedCommands = parseRedisRespAof(certifiedPrefix);
    const commands = parseRedisRespAof(buffer);
    const continuation = validateHistoricalRebaseAofContinuation(commands.slice(certifiedCommands.length));
    const keys = historicalSequenceRebaseRedisKeys();
    let sequenceCounter = 0;
    const reservations = [];
    const operationWrites = [];
    const index = new Map();
    let resolutionPresent = false;
    let eventIndexRaw = null;
    for (let position = 0; position < certifiedCommands.length; position += 1) {
        const command = certifiedCommands[position];
        const name = String(command[0] || "").toUpperCase();
        if (name === "SET" && command[1] === keys.sequence) {
            sequenceCounter = Number(command[2]);
        } else if (name === "INCR" && command[1] === keys.sequence) {
            const before = sequenceCounter;
            sequenceCounter += 1;
            reservations.push({ position, before, after: sequenceCounter });
        } else if (name === "SET" && command[1] === keys.operation) {
            const record = parseJson(command[2], "historical Inbox AOF record");
            if (record.operationId === C.operationId) operationWrites.push({ position, record });
        } else if (name === "SET" && command[1] === keys.resolution) {
            resolutionPresent = true;
        } else if ((name === "DEL" || name === "UNLINK") && command.slice(1).includes(keys.resolution)) {
            resolutionPresent = false;
        } else if (name === "SET" && command[1] === keys.eventIndex) {
            eventIndexRaw = command[2];
        } else if (name === "ZADD" && command[1] === keys.index) {
            for (let indexPosition = 2; indexPosition + 1 < command.length; indexPosition += 2) {
                index.set(command[indexPosition + 1], Number(command[indexPosition]));
            }
        } else if (name === "ZREM" && command[1] === keys.index) {
            for (const member of command.slice(2)) index.delete(member);
        }
    }
    const firstOperationWrite = operationWrites[0];
    const lastOperationWrite = operationWrites.at(-1);
    const reservation = reservations.filter((item) => item.position < (firstOperationWrite?.position ?? -1)).at(-1);
    requireCondition(firstOperationWrite && lastOperationWrite &&
        firstOperationWrite.record.sequence === C.originalSequence &&
        lastOperationWrite.record.sequence === C.originalSequence &&
        lastOperationWrite.record.state === "Pending" && lastOperationWrite.record.result === null &&
        lastOperationWrite.record.ackedAtUnixMs === null && lastOperationWrite.record.claimOwner === null &&
        lastOperationWrite.record.operation?.immutableHash === C.operationImmutableHash,
        "DIAMONDS_HISTORICAL_REBASE_AOF_OPERATION_MISMATCH",
        "AOF does not preserve the exact never-ACKed historical operation.");
    requireCondition(reservation?.before === C.historicalCounterBeforeAllocation &&
        reservation.after === C.historicalReservedSequence && sequenceCounter === C.historicalReservedSequence,
        "DIAMONDS_HISTORICAL_REBASE_AOF_ALLOCATOR_MISMATCH",
        "AOF does not prove the orphaned sequence 3 reservation.");
    requireCondition(index.get(keys.operation) === C.originalSequence &&
        ![...index.entries()].some(([member, score]) => member !== keys.operation && score === C.rebasedSequence),
        "DIAMONDS_HISTORICAL_REBASE_AOF_INDEX_MISMATCH",
        "AOF Inbox index does not prove seq1 with seq3 unoccupied.");
    requireCondition(resolutionPresent === false,
        "DIAMONDS_HISTORICAL_REBASE_RESOLUTION_CONFLICT",
        "AOF contains a durable xsd2 gameplay resolution.");
    const eventIndex = parseJson(eventIndexRaw, "historical event-index AOF record");
    requireCondition(eventIndex.immutableHash === C.eventIndexImmutableHash &&
        eventIndex.identity === C.eventIndexIdentity && eventIndex.intent?.operationId === C.operationId,
        "DIAMONDS_HISTORICAL_REBASE_EVENT_INDEX_CONFLICT",
        "AOF event-index differs from the immutable historical intent.");
    return Object.freeze({
        persistenceDigest: digest,
        totalBytes: buffer.length,
        fileCount: 1,
        aofSha256: certifiedDigest,
        aofBytes: certifiedPrefix.length,
        currentAofSha256: digest,
        currentAofBytes: buffer.length,
        commandCount: commands.length,
        benignContinuationCommands: commands.length - certifiedCommands.length,
        continuation,
        allocatorHistory: Object.freeze({
            counterBeforeAllocation: reservation.before,
            incrementReservedSequence: reservation.after,
            persistedOperationSequence: firstOperationWrite.record.sequence,
            persistedIndexSequence: index.get(keys.operation),
            rebasedSequenceRecordAbsent: true
        })
    });
}

async function redisHealth(redis, configuration) {
    const runtime = await verifyFinancialCanaryRedisRuntime({
        redis,
        contract: configuration.redisRuntime,
        state: configuration.redisState
    });
    const server = await redis.sendCommand(["INFO", "server"]);
    const version = /redis_version:([^\r\n]+)/u.exec(server)?.[1] || "";
    requireCondition(Number(version.split(".")[0]) >= 7 && runtime.exactDataset === true,
        "DIAMONDS_HISTORICAL_REBASE_REDIS_UNSAFE",
        "Redis must be 7+ and bound to the exact canary02 persistence dataset.");
    return Object.freeze({ version, ...runtime });
}

export function selectHistoricalPersistenceProvenance({ redis, aof = null }) {
    const durableParts = [redis.rebaseAudit, redis.originalArchive, redis.rebaseJournal, redis.activeBinding];
    if (durableParts.every((value) => value !== null)) {
        requireCondition(redis.rebaseAudit.certifiedAofSha256 === C.persistenceAofSha256 &&
            redis.rebaseJournal.evidenceHash === redis.rebaseAudit.evidenceHash &&
            redis.rebaseJournal.auditHash === redis.rebaseAudit.auditHash &&
            redis.activeBinding.auditHash === redis.rebaseAudit.auditHash,
        "DIAMONDS_HISTORICAL_REBASE_DURABLE_PROVENANCE_INVALID",
        "Durable rebase journal does not attest the certified historical AOF evidence.");
        return Object.freeze({
            persistenceDigest: redis.rebaseJournal.journalHash,
            totalBytes: C.persistenceAofBytes,
            fileCount: 1,
            aofSha256: C.persistenceAofSha256,
            aofBytes: C.persistenceAofBytes,
            currentAofSha256: null,
            currentAofBytes: null,
            commandCount: null,
            benignContinuationCommands: null,
            source: "durable_rebase_journal",
            allocatorHistory: Object.freeze({
                counterBeforeAllocation: C.historicalCounterBeforeAllocation,
                incrementReservedSequence: C.historicalReservedSequence,
                persistedOperationSequence: C.originalSequence,
                persistedIndexSequence: C.originalSequence,
                rebasedSequenceRecordAbsent: true
            })
        });
    }
    requireCondition(durableParts.every((value) => value === null),
        "DIAMONDS_HISTORICAL_REBASE_DURABLE_PROVENANCE_INVALID",
        "Redis contains a partial rebase journal; AOF fallback is forbidden.");
    requireCondition(aof !== null,
        "DIAMONDS_HISTORICAL_REBASE_DURABLE_PROVENANCE_INVALID",
        "Certified AOF evidence is required before the first durable rebase.");
    requireCondition(aof.continuation?.durableRebaseCommit === null,
        "DIAMONDS_HISTORICAL_REBASE_HYDRATION_MISMATCH",
        "AOF proves a durable rebase commit that the hydrated Redis dataset lost.");
    return aof;
}

async function resolveHistoricalPersistenceProvenance(configuration, resources) {
    const redis = await resources.rebaser.inspect();
    const durableParts = [redis.rebaseAudit, redis.originalArchive, redis.rebaseJournal, redis.activeBinding];
    const aof = durableParts.every((value) => value === null)
        ? readCertifiedAof(configuration.aofPath)
        : null;
    return selectHistoricalPersistenceProvenance({ redis, aof });
}

async function createResources(configuration) {
    const redis = createClient({ url: configuration.redisUrl });
    await redis.connect();
    try {
        const health = await redisHealth(redis, configuration);
        const runtime = createRealDiamondsCanonicalRuntime({
            redis,
            titleId: configuration.titleId,
            secretKey: configuration.secretKey,
            redisPrefix: TARGET_PREFIX,
            gameServerId: "diamonds-historical-sequence-rebase",
            gameServerToken: randomBytes(48).toString("base64url"),
            canaryPlayFabIds: [configuration.playFabId],
            migrationProofRequired: true
        });
        const ledger = createPaymentLedger({
            store: createRedisPaymentLedgerStore(redis, { prefix: LEDGER_PREFIX })
        });
        const resolver = createTrustedXsollaV2PaymentResolver({
            ledger,
            loadXsollaV2Receipt: createPlayFabXsollaV2ReceiptReader({
                titleId: configuration.titleId,
                secretKey: configuration.secretKey
            }),
            expectedEnvironment: "sandbox",
            allowedTransactionStates: new Set(["Failed"]),
            authorizeTransaction(transaction) {
                requireCondition(transaction.playFabId === C.playFabId &&
                    transaction.providerTransactionId === C.providerTransactionId &&
                    transaction.receiptId === C.receiptId && transaction.sku === C.sku,
                    "DIAMONDS_HISTORICAL_REBASE_TRUSTED_CHAIN_MISMATCH",
                    "Ledger identity differs from the certified xsd2 transaction.");
            }
        });
        const rebaser = createRedisHistoricalXsd2SequenceRebaser({
            redis,
            prefix: TARGET_PREFIX,
            ledgerPrefix: LEDGER_PREFIX,
            async verifyProviderPrecommit({ playerLeaseToken, playerFencingEpoch }) {
                await runtime.candidateLeases.assertCurrent({
                    playFabId: C.playFabId,
                    token: playerLeaseToken,
                    epoch: playerFencingEpoch
                });
                const readback = await runtime.proofAwarePlayFab.verifyTrustedOperation({
                    playFabId: C.playFabId,
                    operationId: C.operationId,
                    operationHash: C.operationImmutableHash,
                    delta: C.diamondsDelta
                });
                return Object.freeze({
                    titleId: C.titleId,
                    playFabId: C.playFabId,
                    operationId: C.operationId,
                    operationHash: C.operationImmutableHash,
                    diamonds: readback.snapshot.diamonds,
                    revision: readback.snapshot.revision,
                    cursor: readback.snapshot.highValueAppliedThroughSequence,
                    proofAbsent: readback.verified === false && readback.reason === "missing"
                });
            }
        });
        return Object.freeze({
            redis, runtime, ledger, resolver, health, rebaser,
            async close() { await redis.quit(); }
        });
    } catch (error) {
        await redis.quit().catch(() => redis.disconnect());
        throw error;
    }
}

async function collectEvidence(resources, provenance, { requireLedgerLease }) {
    const redisEvidence = await resources.rebaser.inspect();
    const trusted = await resources.resolver.resolveTransaction({
        providerTransactionId: C.providerTransactionId
    });
    const providerReadback = await resources.runtime.proofAwarePlayFab.verifyTrustedOperation({
        playFabId: C.playFabId,
        operationId: C.operationId,
        operationHash: C.operationImmutableHash,
        delta: C.diamondsDelta
    });
    const markerMatches = providerReadback.highValueProof?.operationId === C.operationId;
    const resultHashMatches = providerReadback.proof?.latestTargetOperation?.h === C.operationImmutableHash;
    const evidence = {
        provider: {
            titleId: C.titleId,
            playFabId: C.playFabId,
            snapshot: providerReadback.snapshot,
            migrationProof: providerReadback.proof,
            operationProof: { verified: providerReadback.verified, reason: providerReadback.reason },
            operationMarker: markerMatches ? providerReadback.highValueProof : null,
            operationResultHash: resultHashMatches ? C.operationImmutableHash : null
        },
        redis: redisEvidence,
        trusted,
        provenance
    };
    const verified = validateHistoricalXsd2SequenceRebaseEvidence({ evidence, requireLedgerLease });
    return Object.freeze({ evidence, verified, providerReadback });
}

function setObjectsCount(runtime) {
    return Number(runtime.snapshotStore.httpMetricsSnapshot().counters["playfab_set_objects_total|"] || 0);
}

function safePreflightResult(bundle, resources) {
    const providerWrites = setObjectsCount(resources.runtime);
    requireCondition(providerWrites === 0, "DIAMONDS_HISTORICAL_REBASE_PROVIDER_CHANGED",
        "Read-only historical rebase preflight attempted a provider write.");
    return Object.freeze({
        result: "preflight_pass",
        neverAppliedProof: bundle.verified.neverApplied ? "complete" : "incomplete",
        allocatorBugProven: bundle.verified.allocatorBugProven,
        orphanedReservation: C.historicalReservedSequence,
        originalSequence: C.originalSequence,
        alreadyRebased: bundle.verified.alreadyRebased,
        allocatorMetadataRecoveryRequired: bundle.verified.allocatorMetadataRecoveryRequired,
        proposedSequence: C.rebasedSequence,
        providerCursor: bundle.evidence.provider.snapshot.highValueAppliedThroughSequence,
        balance: bundle.evidence.provider.snapshot.diamonds,
        revision: bundle.evidence.provider.snapshot.revision,
        proofAbsent: bundle.evidence.provider.operationProof.reason === "missing",
        ledgerState: bundle.evidence.redis.ledgerWrapper.record.state,
        resolutionAbsent: bundle.evidence.redis.resolutionRecord === null,
        providerWrites,
        redisVersion: resources.health.version,
        productionUntouched: true
    });
}

export function validateAcquiredHistoricalRebaseLedgerLease(acquired, token) {
    const isAcquired = acquired?.status === "acquired";
    const record = acquired?.record;
    requireCondition(isAcquired && record?.state === "Failed" &&
        record?.leaseOwner === C.ledgerLeaseOwner && record?.leaseToken === token,
        "DIAMONDS_HISTORICAL_REBASE_LEDGER_LEASE_FAILED",
        "Dedicated payment transaction lease was not acquired.");
    return Object.freeze({
        acquired: true,
        record
    });
}

async function applyMetadataRebase(resources, provenance) {
    const initial = await collectEvidence(resources, provenance, { requireLedgerLease: false });
    const initialResult = safePreflightResult(initial, resources);
    const ledgerLeaseToken = randomBytes(48).toString("base64url");
    const playerLeaseToken = randomBytes(48).toString("base64url");
    let ledgerLeased = false;
    let playerLease = null;
    try {
        const acquiredTransaction = await resources.ledger.acquireLease(LEDGER_IDENTITY, {
            owner: C.ledgerLeaseOwner,
            token: ledgerLeaseToken,
            ttlMilliseconds: 30_000
        });
        ledgerLeased = acquiredTransaction?.status === "acquired";
        validateAcquiredHistoricalRebaseLedgerLease(acquiredTransaction, ledgerLeaseToken);
        const candidate = await resources.runtime.candidateLeases.acquire({
            playFabId: C.playFabId,
            owner: C.ledgerLeaseOwner,
            token: playerLeaseToken,
            ttlMilliseconds: 30_000,
            minimumEpochExclusive: initial.evidence.provider.snapshot.fencingEpoch
        });
        requireCondition(candidate.status === "acquired",
            "DIAMONDS_HISTORICAL_REBASE_PLAYER_BUSY", "Player candidate lease is busy.");
        playerLease = candidate.lease;
        await resources.runtime.candidateLeases.assertCurrent({
            playFabId: C.playFabId,
            token: playerLease.token,
            epoch: playerLease.epoch
        });
        const current = await collectEvidence(resources, provenance, { requireLedgerLease: true });
        const expectedOperationSequence = current.verified.alreadyRebased
            ? C.rebasedSequence
            : C.originalSequence;
        const allocatorMetadataMatches = current.verified.alreadyRebased
            ? current.evidence.redis.sequenceCounter === C.rebasedSequence &&
                current.evidence.redis.operationIndexScore === C.rebasedSequence
            : current.verified.allocatorMetadataRecoveryRequired
                ? current.evidence.redis.sequenceCounter === null &&
                    current.evidence.redis.operationIndexScore === null &&
                    current.evidence.redis.indexEntryCount === 0 &&
                    current.evidence.redis.pendingInboxOperationCount === 1 &&
                    current.evidence.redis.rebasedSequenceRecordCount === 0
                : current.evidence.redis.sequenceCounter === C.historicalReservedSequence &&
                    current.evidence.redis.operationIndexScore === C.originalSequence;
        requireCondition(current.evidence.provider.snapshot.diamonds === 15 &&
            current.evidence.provider.snapshot.revision === 3 &&
            current.evidence.provider.snapshot.highValueAppliedThroughSequence === 2 &&
            current.evidence.redis.operationRecord.sequence === expectedOperationSequence &&
            allocatorMetadataMatches,
            "DIAMONDS_HISTORICAL_REBASE_STATE_CHANGED",
            "Provider/Redis state changed after preflight.");
        const plan = createHistoricalXsd2SequenceRebasePlan({
            evidence: current.evidence,
            rebasedAtUnixMs: Date.now(),
            operatorMarker: OPERATOR_MARKER
        });
        const applied = await resources.rebaser.rebase({
            plan,
            playerLeaseToken: playerLease.token,
            playerFencingEpoch: playerLease.epoch,
            ledgerLeaseToken
        });
        const [afterRedis, afterProvider] = await Promise.all([
            resources.rebaser.inspect(),
            resources.runtime.proofAwarePlayFab.verifyTrustedOperation({
                playFabId: C.playFabId,
                operationId: C.operationId,
                operationHash: C.operationImmutableHash,
                delta: C.diamondsDelta
            })
        ]);
        requireCondition(["rebased", "already_rebased"].includes(applied.status) &&
            afterRedis.operationRecord.sequence === 3 &&
            afterRedis.operationRecord.originalSequence === 1 &&
            afterRedis.operationRecord.activeSequence === 3 &&
            afterRedis.operationRecord.state === "Pending" &&
            afterRedis.operationRecord.operation.immutableHash === C.operationImmutableHash &&
            afterRedis.operationIndexScore === 3 && afterRedis.sequenceCounter === 3 &&
            afterRedis.rebaseAudit?.auditHash === applied.audit.auditHash &&
            afterRedis.rebaseJournal?.journalHash === applied.rebaseJournal.journalHash &&
            afterRedis.activeBinding?.bindingHash === applied.activeBinding.bindingHash &&
            afterRedis.activeBinding?.originalSequence === 1 &&
            afterRedis.activeBinding?.activeSequence === 3 &&
            afterRedis.originalArchive?.originalRecord?.sequence === 1 &&
            afterRedis.playerIdentity === C.playFabId && afterRedis.playerRegistered === true &&
            afterRedis.targetOperationDiscovered === true &&
            afterRedis.pendingInboxOperationCount === 1 &&
            afterRedis.rebasedSequenceRecordCount === 1 &&
            (!plan.allocatorMetadataRecoveryRequired || afterRedis.indexEntryCount === 1) &&
            afterRedis.originalArchive?.originalRecord?.operationId === C.operationId && !afterRedis.rebasedSequenceOccupied &&
            afterRedis.resolutionRecord === null,
            "DIAMONDS_HISTORICAL_REBASE_READBACK_FAILED",
            "Redis metadata rebase readback is incomplete.");
        requireCondition(afterProvider.verified === false && afterProvider.reason === "missing" &&
            afterProvider.snapshot.diamonds === 15 && afterProvider.snapshot.revision === 3 &&
            afterProvider.snapshot.highValueAppliedThroughSequence === 2 &&
            setObjectsCount(resources.runtime) === 0,
            "DIAMONDS_HISTORICAL_REBASE_PROVIDER_CHANGED",
            "Provider state changed during metadata-only rebase.");
        return Object.freeze({
            result: applied.status,
            neverAppliedProof: initialResult.neverAppliedProof,
            originalSequence: 1,
            newSequence: 3,
            providerCursor: 2,
            auditPreserved: true,
            activePendingSequence: afterRedis.operationRecord.sequence,
            allocatorMetadataRecovered: plan.allocatorMetadataRecoveryRequired,
            balance: afterProvider.snapshot.diamonds,
            revision: afterProvider.snapshot.revision,
            providerWrites: 0,
            aofFsyncConfirmed: applied.durability?.aofLocalFsync === true,
            economicMutation: false,
            productionUntouched: true
        });
    } finally {
        if (playerLease) {
            await resources.runtime.candidateLeases.release({
                playFabId: C.playFabId,
                token: playerLease.token,
                epoch: playerLease.epoch
            }).catch(() => undefined);
        }
        if (ledgerLeased) {
            await resources.ledger.releaseLease(LEDGER_IDENTITY, { token: ledgerLeaseToken })
                .catch(() => undefined);
        }
    }
}

export async function runHistoricalXsd2SequenceRebase({
    mode,
    environment = process.env
} = {}) {
    const configuration = readEnvironment(mode, environment);
    const resources = await createResources(configuration);
    try {
        // On first apply, prove the immutable AOF prefix.  After a rewrite/RDB
        // restart, the atomic rebase journal is the durable attestation of that
        // exact evidence and avoids depending on a rotated multipart filename.
        const provenance = await resolveHistoricalPersistenceProvenance(configuration, resources);
        if (mode === "preflight") {
            return safePreflightResult(
                await collectEvidence(resources, provenance, { requireLedgerLease: false }),
                resources
            );
        }
        return await applyMetadataRebase(resources, provenance);
    } finally {
        await resources.close();
    }
}

async function main() {
    const result = await runHistoricalXsd2SequenceRebase({ mode: process.argv[2] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            code: error?.code || "DIAMONDS_HISTORICAL_REBASE_FAILED",
            message: error?.message || "Historical xsd2 sequence rebase failed."
        })}\n`);
        process.exitCode = 1;
    });
}
