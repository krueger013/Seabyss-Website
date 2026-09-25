import { parseXsollaReversalEvent } from "./xsolla-reversal-event-processor.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createXsollaHardenedCatalogEventProcessor } from "./xsolla-hardened-catalog-processor.js";
import { createXsollaPurchaseGateProcessor } from "./xsolla-purchase-gate-processor.js";
import { resolveXsollaPremiumProduct } from "./xsolla-premium-products.js";
import { createXsollaPremiumEventProcessor, isSeabyssPremiumPlan } from "./xsolla-premium-processor.js";
import { createMonetaryV2Review, validateMonetaryV2ExecutionContext } from "./monetary-v2-payment-client.js";

const digest=s=>createHash("sha256").update(s,"utf8").digest("hex");
const identifier=s=>typeof s==="string"&&/^[A-Za-z0-9_-]{1,160}$/u.test(s);
// Local qualification implementation. The production barrier must be registered DURABLY before V2 activation.
// Append-only, fsync before returning; malformed/truncated/oversized evidence fails closed, including after restart.
export function createLocalFilePaymentAuthorityFence({filePath,environment,titleId,productionAuthority=null,initialize=false}={}) {
    validateMonetaryV2ExecutionContext(environment,titleId,productionAuthority);
    if(!path.isAbsolute(filePath)||filePath.startsWith("\\\\")) throw new TypeError("Explicit local payment fence/context required.");
    const header=JSON.stringify({schemaVersion:1,environment,titleId,...(productionAuthority?{productionAuthorityHash:productionAuthority.configurationSha256}:{})});
    if(initialize&&!fs.existsSync(filePath)) {const fd=fs.openSync(filePath,"wx",0o600);try {fs.writeFileSync(fd,header+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    function read() {
        const stat=fs.lstatSync(filePath);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576) throw new Error("PAYMENT_FENCE_INVALID");
        const raw=fs.readFileSync(filePath,"utf8");const lines=raw.split("\n");
        if(lines.shift()!==header||lines.pop()!=="")throw new Error("PAYMENT_FENCE_INVALID");
        const records=new Map();
        for(const line of lines) {const r=JSON.parse(line);if(!identifier(r.recipient)||!Number.isSafeInteger(r.epoch)||r.epoch<1||!/^[a-f0-9]{64}$/u.test(r.sourceHash)||r.sha256!==digest(JSON.stringify([r.recipient,r.epoch,r.sourceHash])))throw new Error("PAYMENT_FENCE_INVALID");
            const prior=records.get(r.recipient);if(prior&&(prior.epoch>r.epoch||(prior.epoch===r.epoch&&prior.sourceHash!==r.sourceHash)))throw new Error("PAYMENT_FENCE_STALE_OR_CONFLICTING");if(!prior||prior.epoch<r.epoch)records.set(r.recipient,r);}
        return records;
    }
    read();
    return Object.freeze({
        async has(recipient) {return read().has(recipient);},
        async remember(proof) {
            if(proof.environment!==environment||proof.titleId!==titleId||!["V2","Migrating","Blocked"].includes(proof.mode)||!identifier(proof.recipient)||!Number.isSafeInteger(proof.epoch)||proof.epoch<1||!/^[a-f0-9]{64}$/u.test(proof.sourceHash))throw new Error("PAYMENT_FENCE_PROOF_INVALID");
            const prior=read().get(proof.recipient);if(prior&&(prior.epoch>proof.epoch||(prior.epoch===proof.epoch&&prior.sourceHash!==proof.sourceHash)))throw new Error("PAYMENT_FENCE_STALE_OR_CONFLICTING");if(prior&&prior.epoch===proof.epoch)return;
            const r={recipient:proof.recipient,epoch:proof.epoch,sourceHash:proof.sourceHash,sha256:digest(JSON.stringify([proof.recipient,proof.epoch,proof.sourceHash]))};
            const fd=fs.openSync(filePath,"a");try{fs.writeFileSync(fd,JSON.stringify(r)+"\n");fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
            read();
        }
    });
}
export function createMonetaryV2EventRouter({enabled=false,resolveAuthority,fence,legacyProcessor,v2Processor}={}) {
    if(!fence||typeof fence.has!=="function"||typeof fence.remember!=="function"||typeof legacyProcessor!=="function"||typeof v2Processor!=="function"||(enabled&&typeof resolveAuthority!=="function"))throw new TypeError("Durable payment authority routing required.");
    return async event=> {
        if(!identifier(event?.userId))throw new Error("PAYMENT_AUTHORITY_UNKNOWN");
        const fenced=await fence.has(event.userId);
        // A line checksum cannot prove that a whole record was not deleted. Once a fence is configured, disabling V2 therefore suspends ALL routing; absence never authorizes legacy.
        if(!enabled)throw new Error("V2_CONFIGURED_DISABLED_NO_LEGACY_FALLBACK");
        const proof=await resolveAuthority(event.userId);
        if(proof?.recipient!==event.userId||!["V1","V2","Migrating","Blocked"].includes(proof.mode))throw new Error("PAYMENT_AUTHORITY_UNKNOWN");
        if(proof.mode==="V1") {if(fenced)throw new Error("V2_ACCOUNT_NO_DOWNGRADE");return legacyProcessor(event);}
        await fence.remember(proof);
        if(proof.mode!=="V2")throw new Error("PAYMENT_AUTHORITY_NOT_ACTIVE");
        return v2Processor(event);
    };
}
// Compose inside the EXISTING signature-verified processEvent seam. No new listener.
export function createMonetaryV2XsollaComposition({ client, fence, legacyProcessor,
    legacyReceiptProcessor = null, holdInbox = null, hardenedOptions = {}, gateOptions = {}, legacyPremiumOptions = {} } = {}) {
    if (!client || typeof client.authority !== "function" || typeof client.submit !== "function")
        throw new TypeError("Private payment service required.");
    validateMonetaryV2ExecutionContext(client.environment,client.titleId,client.productionAuthority ?? null);
    const otherEvents = createMonetaryV2EventRouter({ enabled: client.enabled,
        resolveAuthority: recipient => client.authority(recipient), fence,
        legacyProcessor: client.environment === "production"
            ? async () => { throw new Error("PRODUCTION_V1_PAYMENT_REQUIRES_MIGRATION"); } : legacyProcessor,
        async v2Processor(event) {
            if (["refund", "partial_refund", "order_canceled", "dispute"].includes(event.notificationType)) {
                if (typeof client.review !== "function") throw new Error("MONETARY_V2_REVERSAL_REQUIRES_DURABLE_MANUAL_REVIEW");
                await client.review(createMonetaryV2Review(parseXsollaReversalEvent(event), event.notificationType, client));
                return "monetary_v2_reversal_manual_review";
            }
            return "validated_no_grant";
        }
    });
    const inFlight = new Map(); let timer = null, cycle = null, cursor = "", lastError = null, closing = false;
    function outcome(entry) {
        if (entry.quarantine) return "monetary_v2_quarantined";
        if (!entry.handoff) return "monetary_v2_durably_queued";
        if (entry.handoff.authority === "V1") return "legacy_payment_durably_queued";
        return entry.handoff.status === "Completed" ? "monetary_v2_completed" :
            entry.handoff.status === "ManualReview" ? "monetary_v2_manual_review" : "monetary_v2_durably_queued";
    }
    function deliver(entry) {
        // A scan snapshot can become stale while a prior receipt awaits transport.
        // Refresh under exclusive ownership before any state-dependent route or send.
        entry = holdInbox.get(entry.operationId);
        if (entry.handoff || entry.quarantine) return Promise.resolve(outcome(entry));
        if (inFlight.has(entry.operationId)) return inFlight.get(entry.operationId);
        const execution = (async () => {
            try {
                // Admission is already fsynced. Unavailable authority only defers the held receipt.
                if (!client.enabled) throw new Error("V2_CONFIGURED_DISABLED_NO_LEGACY_FALLBACK");
                const proof = await client.authority(entry.request.recipient);
                if (proof?.environment !== client.environment || proof.titleId !== client.titleId ||
                    proof.recipient !== entry.request.recipient || !["V1", "V2", "Migrating", "Blocked"].includes(proof.mode))
                    throw new Error("PAYMENT_AUTHORITY_UNKNOWN");
                let status, reviewReason = null;
                if (proof.mode === "V1") {
                    if (client.environment === "production") throw new Error("PRODUCTION_V1_PAYMENT_REQUIRES_MIGRATION");
                    if (await fence.has(entry.request.recipient)) throw new Error("V2_ACCOUNT_NO_DOWNGRADE");
                    if (typeof legacyReceiptProcessor !== "function") throw new Error("LEGACY_DURABLE_RECEIPT_PROCESSOR_REQUIRED");
                    // A crash after this marker cannot authorize an unproven second V2 grant.
                    holdInbox.markLegacyAttempt(entry.operationId, entry.request.canonicalPayloadSha256);
                    const result = await legacyReceiptProcessor(entry.receipt);
                    status = result?.status;
                    if (!["checkpoints_pending", "already_completed"].includes(status) ||
                        result?.transaction?.providerTransactionId !== entry.request.transactionId ||
                        result.transaction.playFabId !== entry.request.recipient ||
                        result.transaction.planHash !== entry.request.productPlanHash)
                        throw new Error("LEGACY_DURABLE_RECEIPT_PROOF_INVALID");
                } else {
                    await fence.remember(proof);
                    if (proof.mode !== "V2") throw new Error("PAYMENT_AUTHORITY_NOT_ACTIVE");
                    if (entry.legacyAttempt) {
                        const quarantined = holdInbox.quarantineLegacyAttempt(entry.operationId, proof);
                        lastError = "PAYMENT_LEGACY_HANDOFF_REQUIRES_RECONCILIATION";
                        return outcome(quarantined);
                    }
                    // The actual client validates identity/hash and durable service status before returning.
                    const result = await client.submit(entry.request);
                    status = result?.status; reviewReason = result?.reviewReason ?? null;
                    if (!["Pending", "Completed", "ManualReview"].includes(status) ||
                        result.operationId !== entry.operationId ||
                        result.canonicalPayloadSha256 !== entry.request.canonicalPayloadSha256)
                        throw new Error("MONETARY_V2_DURABLE_RECEIPT_PROOF_INVALID");
                }
                holdInbox.handoff(entry.operationId, entry.request.canonicalPayloadSha256, proof.mode, status, reviewReason);
                lastError = null;
                return outcome({ ...entry, handoff: { authority: proof.mode, status } });
            } catch (error) {
                // A queued acknowledgment promises durable custody, never successful fulfillment.
                lastError = /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message) ? error.message : "PAYMENT_HOLD_RECOVERY_FAILED";
                return "monetary_v2_durably_queued";
            }
        })();
        inFlight.set(entry.operationId, execution);
        return execution.finally(() => inFlight.delete(entry.operationId));
    }
    const processEvent = async event => {
        if (!["payment", "order_paid"].includes(event?.notificationType)) return otherEvents(event);
        if (closing) throw new Error("PAYMENT_HOLD_CLOSED");
        if (!holdInbox || typeof holdInbox.admit !== "function") throw new Error("DURABLE_PAYMENT_HOLD_INBOX_REQUIRED");
        // A configured disabled adapter does not reopen legacy routing. Valid paid receipts can
        // still enter durable custody; recovery waits for explicit configuration restoration.
        await holdInbox.acquireOwnership();
        let admitted = null;
        if (client.environment === "production" && event.notificationType === "payment" &&
            isSeabyssPremiumPlan(event.payload,legacyPremiumOptions.premiumPlanId,legacyPremiumOptions.premiumPlanExternalId)) {
            const capturedAt=new Date();
            const capture=createXsollaPremiumEventProcessor({
                premiumPlanId:legacyPremiumOptions.premiumPlanId,premiumPlanExternalId:legacyPremiumOptions.premiumPlanExternalId,
                validateUser:hardenedOptions.validateUser,now:()=>capturedAt,
                async persistPremiumEntitlement(receipt){
                    admitted=holdInbox.admitLegacySubscription(receipt,event.payload,String(legacyPremiumOptions.premiumPlanId),
                        String(legacyPremiumOptions.premiumPlanExternalId),capturedAt.toISOString());
                }
            });
            await capture(event);
            if(!admitted)throw new Error("MONETARY_V2_NO_DURABLE_PAYMENT_RESULT");
            return outcome(admitted);
        }
        const hardened = createXsollaHardenedCatalogEventProcessor({ ...hardenedOptions,
            allowDiamondProductionGrants: client.environment === "production",
            allowStarterProductionGrants: client.environment === "production",
            capturePremiumProductionReceipts: client.environment === "production",
            persistDiamondPackReceiptV2: null, persistStarterPackReceiptV2: null, fallbackProcessor: null,
            async persistCatalogReceipt(receipt) { admitted = holdInbox.admit(receipt); }
        });
        const gate = createXsollaPurchaseGateProcessor({ ...gateOptions, hardenedEnabled: true,
            hardenedProcessor: hardened, legacyProcessor: null, reversalProcessor: null });
        // New Premium checkout stays disabled. An already-paid known Premium callback
        // must still undergo full validation and durable custody, then proof-or-quarantine.
        if (client.environment === "production" &&
            resolveXsollaPremiumProduct(event.payload, event.notificationType)) await hardened(event);
        else await gate(event);
        if (!admitted) throw new Error("MONETARY_V2_NO_DURABLE_PAYMENT_RESULT");
        return deliver(admitted);
    };
    processEvent.recoverPending = () => {
        if (cycle) return cycle;
        cycle = (async () => {
            if (!holdInbox || closing) return;
            await holdInbox.acquireOwnership();
            for (const entry of holdInbox.pending(8, cursor)) { cursor = entry.operationId; await deliver(entry); }
        })().finally(() => { cycle = null; });
        return cycle;
    };
    processEvent.startRecovery = async () => {
        if (timer || !holdInbox) return;
        await holdInbox.acquireOwnership();
        if (closing) throw new Error("PAYMENT_HOLD_CLOSED");
        const tick = () => { void processEvent.recoverPending().catch(() => { lastError = "PAYMENT_HOLD_SCAN_FAILED"; }); };
        timer = setInterval(tick, 2000); timer.unref?.(); tick();
    };
    processEvent.stopRecovery = async () => {
        closing = true; clearInterval(timer); timer = null;
        // Keep ownership until every outstanding handoff settles. The V2 transport has a
        // timeout; legacy receipt persistence retains its existing timeout contract.
        // Never unlock while a late legacy write may still be running.
        if (cycle) await cycle;
        await Promise.allSettled([...inFlight.values()]);
        await holdInbox?.close();
    };
    processEvent.quarantinePage = (limit, after) => holdInbox?.quarantinePage(limit, after);
    processEvent.recoveryHealth = () => {
        const health = holdInbox?.health();
        return { ...health, running: timer !== null, lastError,
            state: health?.quarantined > 0 ? "RECONCILING" : health?.retryable > 0 || lastError ? "DEGRADED" : "HEALTHY" };
    };
    return Object.freeze(processEvent);
}
