import { createHash } from "node:crypto";
import http from "node:http";
import { getXsollaProductPlan } from "./xsolla-product-plan-registry.js";

const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/u.test(value);
export function monetaryV2PaymentCanonical(p) {
    if (p?.schemaVersion !== 1 || p.provider !== "xsolla" ||
        !((p.environment === "local" && p.titleId === "LOCAL") || (p.environment === "sandbox" && p.titleId === "1D0C16")) ||
        typeof p.transactionId !== "string" || !/^[1-9][0-9]{0,18}$/u.test(p.transactionId) || BigInt(p.transactionId) > 9223372036854775807n ||
        !identifier(p.recipient) || !identifier(p.productId) || !identifier(p.sku) ||
        !Number.isSafeInteger(p.productPlanVersion) || p.productPlanVersion < 1 || p.productPlanVersion > 100000 ||
        !/^[a-f0-9]{64}$/u.test(p.productPlanHash) || p.quantity !== 1 ||
        !Number.isSafeInteger(p.amountMinor) || p.amountMinor < 1 || p.amountMinor > 2147483647 ||
        !/^[A-Z]{3}$/u.test(p.currency) || !["xsd1", "xsd2", "xss1", "xss2", "xsp1", "xsp2"].includes(p.receiptAlias)) throw new TypeError("Invalid Monetary V2 payment contract.");
    return JSON.stringify([1,p.environment,p.titleId,"xsolla",p.transactionId,p.recipient,p.productId,p.sku,
        p.productPlanVersion,p.productPlanHash,1,p.amountMinor,p.currency]);
}
export const monetaryV2PaymentOperationId = p => "xsolla_" + hash(`${p.environment}\n${p.titleId}\n${p.transactionId}`);
export function createVerifiedMonetaryV2Payment(receipt, { environment, titleId, receiptAlias } = {}) {
    const plan = getXsollaProductPlan(receipt?.xsollaSku, receipt?.productPlanVersion);
    if (receipt?.provider !== "xsolla" || receipt.providerTransactionId !== receipt.transactionId ||
        receipt.userId !== receipt.playFabId || receipt.environment !== "sandbox" ||
        receipt.source !== "xsolla_sandbox" || receipt.productId !== plan.productId ||
        receipt.productType !== plan.productType || receipt.currency !== plan.currency ||
        receipt.unitAmountMinor !== plan.unitAmountMinor || receipt.totalAmountMinor !== plan.unitAmountMinor ||
        receipt.quantity !== 1 || receipt.promotionPolicy !== "disabled") throw new TypeError("Verified catalog receipt required.");
    const p = { schemaVersion:1, environment, titleId, provider:"xsolla", transactionId:receipt.transactionId,
        recipient:receipt.playFabId, productId:plan.productId, sku:plan.sku, productPlanVersion:plan.planVersion,
        productPlanHash:plan.planHash, quantity:1, amountMinor:plan.unitAmountMinor, currency:plan.currency,
        receiptAlias: receiptAlias ?? (plan.productType === "diamond_pack" ? "xsd2" : plan.productType === "premium" ? "xsp2" : "xss2") };
    if (p.receiptAlias.startsWith("xsd") !== (plan.productType === "diamond_pack") || p.receiptAlias.startsWith("xsp") !== (plan.productType === "premium")) throw new TypeError("Receipt alias family mismatch.");
    return Object.freeze({...p, canonicalPayloadSha256:hash(monetaryV2PaymentCanonical(p))});
}
function localOrigin(value) {
    const u = new URL(value);
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !/^\d+$/u.test(u.port) || Number(u.port) < 1024 ||
        u.pathname !== "/" || u.search || u.hash || u.username || u.password) throw new TypeError("Payment service must use explicit literal high-port loopback.");
    return u;
}
export function localPaymentHttpTransport({url, headers, body, signal}) {
    return new Promise((resolve,reject) => {
        const request = http.request(url,{method:body === null ? "GET" : "POST",headers,agent:false,signal},response => {
            const chunks=[]; let length=0;
            response.on("data",chunk => {length+=chunk.length;if(length>65536){response.destroy(new Error("Payment response too large."));return;}chunks.push(chunk);});
            response.on("error",reject);
            response.on("end",()=>{try{resolve({status:response.statusCode,body:new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))});}catch(error){reject(error);}});
        });
        request.on("error",reject); request.end(body ?? undefined);
    });
}
export function createMonetaryV2PaymentClient({enabled=false,environment="local",titleId="LOCAL",origin="http://127.0.0.1:55160/",token="",transport=localPaymentHttpTransport,timeoutMs=10000}={}) {
    if (!((environment === "local" && titleId === "LOCAL") || (environment === "sandbox" && titleId === "1D0C16"))) throw new TypeError("Payment context is not local/sandbox.");
    const base=localOrigin(origin);
    if (!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>30000 || typeof transport!=="function") throw new TypeError("Invalid bounded payment transport.");
    if (enabled && (typeof token!=="string" || !/^[\x21-\x7e]{64,256}$/u.test(token))) throw new TypeError("Private payment service token required.");
    async function call(path,body) {
        if (!enabled) throw new Error("MONETARY_V2_DISABLED");
        const controller=new AbortController(); let timer;
        try {
            const timed=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error("MONETARY_V2_RESPONSE_UNKNOWN"));},timeoutMs);});
            const result=await Promise.race([transport({url:new URL(path,base),headers:{"Content-Type":"application/json","X-Seabyss-Monetary-Token":token},body:body===null?null:JSON.stringify(body),signal:controller.signal}),timed]);
            if (!result || typeof result.body!=="string" || Buffer.byteLength(result.body)>65536 || ![200,202].includes(result.status)) throw new Error("MONETARY_V2_RESPONSE_UNKNOWN");
            return {status:result.status,value:JSON.parse(result.body)};
        } catch { throw new Error("MONETARY_V2_RESPONSE_UNKNOWN"); } finally { clearTimeout(timer); }
    }
    return Object.freeze({enabled,environment,titleId,
        async authority(recipient) {
            if (!identifier(recipient)) throw new TypeError("Invalid payment recipient.");
            const {status,value:p}=await call(`/v2/payments/authority/${recipient}`,null);
            if(status!==200||p?.environment!==environment||p.titleId!==titleId||p.recipient!==recipient||
                !["V1","V2","Migrating","Blocked"].includes(p.mode)||!Number.isSafeInteger(p.epoch)||p.epoch<1||
                !/^[a-f0-9]{64}$/u.test(p.sourceHash)) throw new Error("MONETARY_V2_AUTHORITY_UNKNOWN");
            return Object.freeze(p);
        },
        async review(p) {
            if(p.environment!==environment||p.titleId!==titleId||p.evidenceSha256!==monetaryV2ReviewProof(p))throw new TypeError("Reversal context/proof mismatch.");
            const {status,value:r}=await call("/v2/payments/review",p);
            const operation="xsolla_"+hash(`${environment}\n${titleId}\n${p.transactionId}`);
            if(status!==200||r?.status!=="ManualReview"||r.operationId!==operation||r.reversalEventId!==p.reversalEventId||r.evidenceSha256!==p.evidenceSha256||r.policy!=="manual_review_no_automatic_clawback"||!["Matched","Unmatched"].includes(r.correlation))throw new Error("MONETARY_V2_RESPONSE_UNKNOWN");
            return Object.freeze(r);
        },
        async submit(p) {
            if(p.environment!==environment||p.titleId!==titleId||p.canonicalPayloadSha256!==hash(monetaryV2PaymentCanonical(p))) throw new TypeError("Payment canonical/context mismatch.");
            const {status,value:r}=await call("/v2/payments/verified",p);
            if(r?.operationId!==monetaryV2PaymentOperationId(p)||r.canonicalPayloadSha256!==p.canonicalPayloadSha256||
                !["Pending","Completed","ManualReview"].includes(r.status)||
                (r.status==="Completed" ? status!==200||r.committed?.operationId!==r.operationId||!/^[a-f0-9]{64}$/u.test(r.committed.payloadHash)||!Array.isArray(r.committed.accounts)||r.committed.accounts.length!==1||r.committed.accounts[0].account!==p.recipient||!Number.isSafeInteger(r.committed.accounts[0].sequence)||r.committed.accounts[0].sequence<1||!/^[a-f0-9]{64}$/u.test(r.committed.accounts[0].headHash)||!Number.isSafeInteger(r.committed.accounts[0].ownerEpoch)||r.committed.accounts[0].ownerEpoch<1||![r.committed.accounts[0].gold,r.committed.accounts[0].diamonds].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647) : r.committed!=null) ||
                (r.status==="Pending" && status!==202)|| (r.status==="ManualReview" && (status!==200||typeof r.reviewReason!=="string"||!r.reviewReason||r.reviewReason.length>100))) throw new Error("MONETARY_V2_RESPONSE_UNKNOWN");
            return Object.freeze(r);
        }
    });
}
export function monetaryV2ReviewProof(p) {
    if(p?.schemaVersion!==1||!((p.environment==="local"&&p.titleId==="LOCAL")||(p.environment==="sandbox"&&p.titleId==="1D0C16"))||
        typeof p.transactionId!=="string"||!/^[1-9][0-9]{0,18}$/u.test(p.transactionId)||BigInt(p.transactionId)>9223372036854775807n||!identifier(p.recipient)||
        !["refund","partial_refund","order_canceled","dispute"].includes(p.kind)||typeof p.reversalEventId!=="string"||!new RegExp(`^xsolla:${p.kind}:[a-f0-9]{64}$`,"u").test(p.reversalEventId)||
        !Number.isSafeInteger(p.amountMinor)||p.amountMinor<1||p.amountMinor>2147483647||!/^[A-Z]{3}$/u.test(p.currency)||typeof p.normalizedJson!=="string"||Buffer.byteLength(p.normalizedJson)>8192)
        throw new TypeError("Invalid normalized reversal proof.");
    const body=JSON.parse(p.normalizedJson);if(!body||Array.isArray(body)||typeof body!=="object")throw new TypeError("Missing normalized reversal body.");
    if(body.providerTransactionId!==p.transactionId||body.expectedPlayFabId!==p.recipient||body.reversalEventId!==p.reversalEventId||body.amountMinor!==p.amountMinor||body.currency!==p.currency||body.type!==(p.kind==="dispute"?"chargeback":p.kind))throw new TypeError("Normalized reversal fields differ from proof.");
    return hash(JSON.stringify([1,p.environment,p.titleId,p.transactionId,p.recipient,p.kind,p.reversalEventId,p.amountMinor,p.currency,hash(p.normalizedJson)]));
}
export function createMonetaryV2Review(reversal,kind,{environment,titleId}) {
    const p={schemaVersion:1,environment,titleId,transactionId:reversal.providerTransactionId,recipient:reversal.expectedPlayFabId,kind,
        reversalEventId:reversal.reversalEventId,amountMinor:reversal.amountMinor,currency:reversal.currency,normalizedJson:JSON.stringify(reversal)};
    return Object.freeze({...p,evidenceSha256:monetaryV2ReviewProof(p)});
}