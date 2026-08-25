import {
    createServerEconomyPocHighValueOperation,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-domain-model.js";
import { createServerEconomyPocEngine } from "./server-economy-poc-engine.js";
import {
    createStableServerEconomyPocOperationInbox,
    createStableServerEconomyPocWalStore
} from "./server-economy-poc-stable-stores.js";
import {
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";
import {
    createServerEconomyPocUnifiedSequenceInbox
} from "./server-economy-poc-unified-sequence-inbox.js";

function requireStore(value, name, methods) {
    if (!value || methods.some((method) => typeof value[method] !== "function")) {
        throw new TypeError(`${name} does not implement the server economy POC interface.`);
    }
}

function normalizedPremium(current, operation) {
    if (operation.premium === null) return serverEconomyPocClone(current.premium);
    const effectiveAtUnixMs = serverEconomyPocNonNegative(
        operation.effectiveAtUnixMs ?? operation.createdAtUnixMs,
        "operation.effectiveAtUnixMs"
    );
    const activeAtEffectiveTime = current.premium.tier > 0 &&
        current.premium.expiresAtUnixMs > effectiveAtUnixMs;
    const base = activeAtEffectiveTime ? current.premium.expiresAtUnixMs : effectiveAtUnixMs;
    const durationMilliseconds = operation.premium.durationSeconds * 1000;
    const expiresAtUnixMs = base + durationMilliseconds;
    if (!Number.isSafeInteger(durationMilliseconds) || !Number.isSafeInteger(expiresAtUnixMs)) {
        serverEconomyPocFail("POC_PREMIUM_OVERFLOW", "Premium expiration is not representable.");
    }
    return {
        tier: activeAtEffectiveTime
            ? Math.max(current.premium.tier, operation.premium.tier)
            : operation.premium.tier,
        activatedAtUnixMs: activeAtEffectiveTime
            ? current.premium.activatedAtUnixMs
            : effectiveAtUnixMs,
        expiresAtUnixMs
    };
}

async function recordAtSequence(inbox, playFabId, sequence) {
    const page = await inbox.scanAfter({
        playFabId,
        afterSequence: sequence - 1,
        limit: 1
    });
    const record = page.entries[0];
    if (!record || record.sequence !== sequence) {
        serverEconomyPocFail(
            "POC_OPERATION_ORDER_BLOCKED",
            "The durable operation for the intended snapshot sequence is absent.",
            { retryable: true }
        );
    }
    return record;
}

/**
 * Final local POC engine.
 *
 * Economic intent time is persisted in the inbox, while leases, claims and
 * snapshot updatedAt use the real processing clock.  This keeps Premium
 * deterministic across retries without allowing an old receipt to move the
 * provider snapshot clock backwards.
 */
export function createServerEconomyPocRuntimeEngine({
    snapshotStore,
    operationInbox,
    walStore,
    playerLeases,
    sequenceLeases = playerLeases,
    nowMilliseconds = () => Date.now(),
    ...options
} = {}) {
    requireStore(snapshotStore, "snapshotStore", [
        "read", "compareAndSet", "verifyHighValueOperationProof", "readAmmoBatchProof"
    ]);
    if (typeof nowMilliseconds !== "function") throw new TypeError("Runtime engine clock is required.");
    const sequencedInbox = createServerEconomyPocUnifiedSequenceInbox({
        operationInbox,
        snapshotStore,
        sequenceLeases
    });
    const stableInbox = createStableServerEconomyPocOperationInbox(sequencedInbox);
    const stableWal = createStableServerEconomyPocWalStore(walStore);
    const processingNow = () => serverEconomyPocNonNegative(nowMilliseconds(), "processing clock");

    const deterministicSnapshotStore = Object.freeze({
        async read(playFabId) {
            return snapshotStore.read(playFabId);
        },
        async compareAndSet(input) {
            const current = await snapshotStore.read(input.playFabId);
            const next = serverEconomyPocClone(input.nextSnapshot);
            if (next.highValueAppliedThroughSequence === current.highValueAppliedThroughSequence + 1) {
                const record = await recordAtSequence(
                    stableInbox,
                    input.playFabId,
                    next.highValueAppliedThroughSequence
                );
                next.premium = normalizedPremium(current, record.operation);
            }
            next.updatedAtUnixMs = Math.max(current.updatedAtUnixMs, processingNow());
            validateServerEconomyPocSnapshot(next, input.playFabId);
            return snapshotStore.compareAndSet({ ...input, nextSnapshot: serverEconomyPocReadonly(next) });
        },
        async verifyHighValueOperationProof(input) {
            return snapshotStore.verifyHighValueOperationProof(input);
        },
        durable: snapshotStore.durable === true,
        async readAmmoBatchProof(playFabId) {
            return snapshotStore.readAmmoBatchProof(playFabId);
        },
        provider: snapshotStore.provider || "injected_snapshot_store",
        deterministicPremiumTime: true,
        monotonicProcessingTime: true,
        underlying: snapshotStore
    });

    const acknowledgingInbox = Object.freeze({
        ...stableInbox,
        async ack(input) {
            const snapshot = await deterministicSnapshotStore.read(input.playFabId);
            const normalizedResult = {
                ...serverEconomyPocClone(input.result),
                premium: serverEconomyPocClone(snapshot.premium),
                revision: snapshot.revision
            };
            return stableInbox.ack({ ...input, result: serverEconomyPocReadonly(normalizedResult) });
        }
    });

    const base = createServerEconomyPocEngine({
        ...options,
        snapshotStore: deterministicSnapshotStore,
        operationInbox: acknowledgingInbox,
        walStore: stableWal,
        playerLeases,
        nowMilliseconds
    });

    async function enqueueAuthoritativeHighValueOperation(input = {}) {
        const effectiveAtUnixMs = serverEconomyPocNonNegative(
            input.effectiveAtUnixMs,
            "effectiveAtUnixMs"
        );
        const operation = createServerEconomyPocHighValueOperation({
            ...input,
            createdAtUnixMs: effectiveAtUnixMs
        });
        return acknowledgingInbox.submit(serverEconomyPocReadonly({
            ...serverEconomyPocClone(operation),
            effectiveAtUnixMs
        }));
    }

    async function normalizeOutput(playFabId, output) {
        const snapshot = await deterministicSnapshotStore.read(playFabId);
        return serverEconomyPocReadonly({
            ...serverEconomyPocClone(output),
            snapshot,
            ...(output.result ? {
                result: {
                    ...serverEconomyPocClone(output.result),
                    premium: snapshot.premium,
                    revision: snapshot.revision
                }
            } : {})
        });
    }

    async function processHighValueOperation(input = {}) {
        const player = serverEconomyPocId(input.playFabId, "playFabId", 160);
        return normalizeOutput(player, await base.processHighValueOperation(input));
    }

    async function nextPending(playFabId) {
        let cursor = 0;
        for (;;) {
            const page = await acknowledgingInbox.scanAfter({
                playFabId,
                afterSequence: cursor,
                limit: 100
            });
            const pending = page.entries.find((entry) => entry.state !== "Acked");
            if (pending) return pending;
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= page.nextSequence) return null;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function processNextHighValue(playFabId, { consumer = "offline" } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const pending = await nextPending(player);
        if (!pending) return Object.freeze({ status: "empty" });
        return processHighValueOperation({
            playFabId: player,
            operationId: pending.operationId,
            consumer
        });
    }

    async function drainHighValue(playFabId, { consumer = "offline", maximumOperations = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumOperations, "maximumOperations");
        const results = [];
        for (let index = 0; index < maximum; index += 1) {
            const result = await processNextHighValue(playFabId, { consumer });
            if (result.status === "empty") break;
            results.push(result);
        }
        return Object.freeze(results);
    }

    return Object.freeze({
        enqueueXsollaHighValueOperation: base.enqueueXsollaHighValueOperation,
        enqueueAuthoritativeHighValueOperation,
        appendEliteBallDelta: base.appendEliteBallDelta,
        processHighValueOperation,
        processNextHighValue,
        drainHighValue,
        flushEliteBall: base.flushEliteBall,
        readSnapshot: base.readSnapshot,
        stores: Object.freeze({
            ...base.stores,
            snapshotStore: deterministicSnapshotStore,
            operationInbox: acknowledgingInbox,
            walStore: stableWal
        }),
        configuration: base.configuration,
        deterministicEffectiveTime: true,
        monotonicProcessingTime: true,
        stableIntentIdentity: true,
        unifiedHighValueSequence: true,
        providerCursorAnchoredSequence: true
    });
}
