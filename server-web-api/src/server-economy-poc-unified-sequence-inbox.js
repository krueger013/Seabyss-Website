import { randomUUID } from "node:crypto";
import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * One monotonic high-value sequence domain per PlayFabId.
 *
 * Every producer (gameplay, xsd2 and any future authoritative xss2 sub-grant)
 * reaches this boundary.  The Redis counter is first raised to the durable
 * provider cursor while the player allocation lease is current, then the
 * operation and its sequence are persisted atomically by the underlying store.
 */
export function createServerEconomyPocUnifiedSequenceInbox({
    operationInbox,
    snapshotStore,
    sequenceLeases,
    owner = `server-economy-poc-sequence-${process.pid}`,
    leaseTtlMilliseconds = 15_000,
    maximumAcquireAttempts = 64,
    retryDelayMilliseconds = 1,
    tokenFactory = () => randomUUID()
} = {}) {
    for (const method of ["submit", "get", "scanAfter", "claim", "ack", "releaseClaim", "listPlayersWithPending"]) {
        if (typeof operationInbox?.[method] !== "function") {
            throw new TypeError(`operationInbox.${method} is required.`);
        }
    }
    if (typeof snapshotStore?.read !== "function") {
        throw new TypeError("snapshotStore.read is required for unified sequence allocation.");
    }
    for (const method of ["acquire", "release"]) {
        if (typeof sequenceLeases?.[method] !== "function") {
            throw new TypeError(`sequenceLeases.${method} is required.`);
        }
    }
    const allocationOwner = serverEconomyPocId(owner, "sequence allocator owner", 160);
    const ttl = serverEconomyPocPositive(leaseTtlMilliseconds, "sequence allocator lease TTL");
    const maximumAttempts = serverEconomyPocPositive(
        maximumAcquireAttempts,
        "sequence allocator maximum acquire attempts"
    );
    const retryDelay = serverEconomyPocNonNegative(
        retryDelayMilliseconds,
        "sequence allocator retry delay"
    );
    if (typeof tokenFactory !== "function") throw new TypeError("sequence allocator tokenFactory is required.");

    async function acquire(playFabId) {
        for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
            const token = serverEconomyPocId(tokenFactory(), "sequence allocator lease token", 255);
            const result = await sequenceLeases.acquire({
                playFabId,
                owner: allocationOwner,
                token,
                ttlMilliseconds: ttl
            });
            if (result?.status === "acquired") return { token, lease: result.lease };
            if (result?.status !== "busy") {
                serverEconomyPocFail(
                    "POC_SEQUENCE_ALLOCATOR_PROTOCOL",
                    "Sequence allocator lease returned an unknown status.",
                    { retryable: true }
                );
            }
            if (attempt < maximumAttempts) await wait(retryDelay);
        }
        serverEconomyPocFail(
            "POC_SEQUENCE_ALLOCATOR_BUSY",
            "The shared financial sequence allocator is busy.",
            { retryable: true, statusCode: 409 }
        );
    }

    async function submit(operation) {
        const playFabId = serverEconomyPocId(operation?.playFabId, "playFabId", 160);
        const operationId = serverEconomyPocId(operation?.operationId, "operationId", 200);
        const existing = await operationInbox.get(playFabId, operationId);
        if (existing) {
            if (existing.operation.immutableHash !== operation.immutableHash) {
                serverEconomyPocFail(
                    "POC_OPERATION_IDEMPOTENCY_CONFLICT",
                    "operationId is bound to another high-value operation."
                );
            }
            return serverEconomyPocReadonly({ status: "existing", record: existing });
        }

        const allocation = await acquire(playFabId);
        try {
            const raced = await operationInbox.get(playFabId, operationId);
            if (raced) {
                if (raced.operation.immutableHash !== operation.immutableHash) {
                    serverEconomyPocFail(
                        "POC_OPERATION_IDEMPOTENCY_CONFLICT",
                        "operationId is bound to another high-value operation."
                    );
                }
                return serverEconomyPocReadonly({ status: "existing", record: raced });
            }
            const snapshot = await snapshotStore.read(playFabId);
            const providerCursor = serverEconomyPocNonNegative(
                snapshot?.highValueAppliedThroughSequence,
                "provider high-value cursor"
            );
            return await operationInbox.submit(operation, {
                minimumSequenceExclusive: providerCursor,
                playerLeaseToken: allocation.token,
                playerFencingEpoch: allocation.lease.epoch
            });
        } finally {
            await sequenceLeases.release({
                playFabId,
                token: allocation.token,
                epoch: allocation.lease.epoch
            });
        }
    }

    return Object.freeze({
        ...operationInbox,
        submit,
        unifiedHighValueSequence: true,
        providerCursorAnchored: true,
        replayPreservesSequence: true,
        sequenceLeases
    });
}
