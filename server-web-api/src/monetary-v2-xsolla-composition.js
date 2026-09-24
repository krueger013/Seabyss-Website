import { parseXsollaReversalEvent } from "./xsolla-reversal-event-processor.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createXsollaHardenedCatalogEventProcessor } from "./xsolla-hardened-catalog-processor.js";
import { createXsollaPurchaseGateProcessor } from "./xsolla-purchase-gate-processor.js";
import { createVerifiedMonetaryV2Payment,createMonetaryV2Review } from "./monetary-v2-payment-client.js";

const digest=s=>createHash("sha256").update(s,"utf8").digest("hex");
const identifier=s=>typeof s==="string"&&/^[A-Za-z0-9_-]{1,160}$/u.test(s);
// Local qualification implementation. The production barrier must be registered DURABLY before V2 activation.
// Append-only, fsync before returning; malformed/truncated/oversized evidence fails closed, including after restart.
export function createLocalFilePaymentAuthorityFence({filePath,environment,titleId,initialize=false}={}) {
    if(!path.isAbsolute(filePath)||filePath.startsWith("\\\\")||!((environment==="local"&&titleId==="LOCAL")||(environment==="sandbox"&&titleId==="1D0C16"))) throw new TypeError("Explicit local payment fence/context required.");
    const header=JSON.stringify({schemaVersion:1,environment,titleId});
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
// Compose inside the EXISTING signature-verified processEvent seam. No listener, authentication bypass, or legacy receipt writer.
export function createMonetaryV2XsollaComposition({client,fence,legacyProcessor,hardenedOptions={},gateOptions={}}={}) {
    if(!client||typeof client.authority!=="function"||typeof client.submit!=="function")throw new TypeError("Private payment service required.");
    return createMonetaryV2EventRouter({enabled:client.enabled,resolveAuthority:r=>client.authority(r),fence,legacyProcessor,
        async v2Processor(event) {
            if(["refund","partial_refund","order_canceled","dispute"].includes(event.notificationType)) {
                if(typeof client.review!=="function")throw new Error("MONETARY_V2_REVERSAL_REQUIRES_DURABLE_MANUAL_REVIEW");
                const reversal=parseXsollaReversalEvent(event);
                await client.review(createMonetaryV2Review(reversal,event.notificationType,client));
                return "monetary_v2_reversal_manual_review";
            }
            if(!["payment","order_paid"].includes(event.notificationType))return "validated_no_grant";
            let fulfillment=null;
            const hardened=createXsollaHardenedCatalogEventProcessor({...hardenedOptions,
                allowDiamondProductionGrants:false,allowStarterProductionGrants:false,
                persistDiamondPackReceiptV2:null,persistStarterPackReceiptV2:null,fallbackProcessor:null,
                async persistCatalogReceipt(receipt) {
                    const request=createVerifiedMonetaryV2Payment(receipt,{environment:client.environment,titleId:client.titleId});
                    fulfillment=await client.submit(request);
                }});
            const gate=createXsollaPurchaseGateProcessor({...gateOptions,hardenedEnabled:true,hardenedProcessor:hardened,legacyProcessor:null,reversalProcessor:null});
            await gate(event);
            if(!fulfillment)throw new Error("MONETARY_V2_NO_DURABLE_PAYMENT_RESULT");
            return fulfillment.status === "Completed" ? "monetary_v2_completed" : fulfillment.status === "Pending" ? "monetary_v2_durably_queued" : "monetary_v2_manual_review";
        }
    });
}