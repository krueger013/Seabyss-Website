import { createHash } from "node:crypto";
import {
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocPositive,
    serverEconomyPocReadonly
} from "./server-economy-poc-model.js";

function token(playFabId, operationId) {
    return `shadow_poc_${createHash("sha256")
        .update(JSON.stringify([playFabId, operationId]), "utf8")
        .digest("hex")}`;
}

/**
 * Adapts a dedicated mirror of the canonical POC operation inbox. It refuses
 * the authoritative inbox so Shadow can never ACK an operation that still
 * needs a real financial grant.
 */
export function createFinancialShadowPocInboxAdapter({
    operationInbox,
    runtime,
    serverId,
    claimTtlMilliseconds = 15_000,
    hooks = {}
} = {}) {
    for (const method of ["submit", "scanAfter", "claim", "ack", "releaseClaim"]) {
        if (typeof operationInbox?.[method] !== "function") {
            throw new TypeError(`Financial Shadow POC mirror inbox requires ${method}.`);
        }
    }
    if (operationInbox.shadowProjectionOnly !== true ||
        typeof runtime?.projectExternalPocOperation !== "function") {
        throw new TypeError("Financial Shadow refuses an authoritative POC inbox or incomplete runtime.");
    }
    const owner = serverEconomyPocId(serverId, "Financial Shadow POC mirror serverId", 160);
    const ttl = serverEconomyPocPositive(claimTtlMilliseconds, "Financial Shadow POC mirror claim TTL");

    async function enqueueCanonicalProjection(operation) {
        if (!operation || operation.kind !== "xsolla_entitlement") {
            serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_OPERATION_INVALID", "Only canonical POC entitlements can enter the Shadow mirror.");
        }
        return operationInbox.submit(operation);
    }

    async function nextPending(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        let cursor = 0;
        for (;;) {
            const page = await operationInbox.scanAfter({ playFabId: player, afterSequence: cursor, limit: 100 });
            const pending = page.entries.find((entry) => entry.state !== "Acked");
            if (pending) return pending;
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= page.nextSequence) return null;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function consumeNext(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const pending = await nextPending(player);
        if (!pending) return Object.freeze({ status: "empty" });
        const claimToken = token(player, pending.operationId);
        const claim = await operationInbox.claim({
            playFabId: player,
            operationId: pending.operationId,
            owner,
            token: claimToken,
            ttlMilliseconds: ttl
        });
        if (claim.status === "acked") return serverEconomyPocReadonly({ status: "already_acked", record: claim.record });
        if (claim.status !== "claimed") {
            serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_INBOX_BUSY", "Shadow POC mirror operation is busy.", { retryable: true });
        }
        try {
            const projection = await runtime.projectExternalPocOperation({
                playFabId: player,
                operation: claim.record.operation,
                sequence: claim.record.sequence
            });
            await hooks.afterProjectionBeforeAck?.({ claim, projection });
            const acknowledged = await operationInbox.ack({
                playFabId: player,
                operationId: claim.record.operationId,
                claimToken,
                claimEpoch: claim.record.claimEpoch,
                result: {
                    status: "shadow_projected",
                    authoritative: false,
                    sourceAttested: true,
                    deliveryId: projection.delivery?.deliveryId || projection.deliveryId
                }
            });
            if (acknowledged.status !== "acked") {
                serverEconomyPocFail("FINANCIAL_SHADOW_EXTERNAL_ACK_FAILED", "Shadow POC mirror ACK failed.", { retryable: true });
            }
            return serverEconomyPocReadonly({ status: "projected_and_acked", projection, record: acknowledged.record });
        } catch (error) {
            if (error?.code !== "FINANCIAL_SHADOW_TEST_CRASH") {
                await operationInbox.releaseClaim({
                    playFabId: player,
                    operationId: claim.record.operationId,
                    claimToken,
                    claimEpoch: claim.record.claimEpoch
                }).catch(() => {});
            }
            throw error;
        }
    }

    return Object.freeze({
        enqueueCanonicalProjection,
        consumeNext,
        nextPending,
        source: "canonical_poc_shadow_mirror",
        authoritative: false,
        grantsRewards: false,
        acknowledgesAuthoritativeInbox: false
    });
}
