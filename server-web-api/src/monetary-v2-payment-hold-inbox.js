import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { isSeabyssPremiumPlan, resolveXsollaPremiumPeriod } from "./xsolla-premium-processor.js";
import { createVerifiedMonetaryV2Payment, monetaryV2PaymentCanonical, monetaryV2PaymentOperationId, validateMonetaryV2ExecutionContext } from "./monetary-v2-payment-client.js";

const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const completionReserve = 1024;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

// Bounded, single-host migration custody. Kernel IPC ownership is mandatory before
// mutations; process death releases it without deleting a PID/stale-lock file.
// This is not a multi-host lock or permission to prune receipt identities. Provision
// the file/directory durably before service startup. Tests prove process-crash recovery,
// not storage-controller or power-loss guarantees on every supported filesystem.
export function createLocalPaymentHoldInbox({ filePath, environment, titleId, productionAuthority = null, initialize = false,
    maximumBytes = 16 * 1024 * 1024, maximumReceipts = 4096, maximumPending = 1024,
    boundary = () => {} } = {}) {
    validateMonetaryV2ExecutionContext(environment, titleId, productionAuthority);
    productionAuthority = productionAuthority ? Object.freeze({...productionAuthority}) : null;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.startsWith("\\\\") ||
        !Number.isSafeInteger(maximumBytes) || maximumBytes < 4096 || maximumBytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 4096 ||
        !Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > maximumReceipts ||
        typeof boundary !== "function") throw new TypeError("LOCAL_PAYMENT_HOLD_CONFIGURATION_INVALID");
    const header = JSON.stringify({ schemaVersion: 1, environment, titleId, ...(productionAuthority ? {productionAuthorityHash:productionAuthority.configurationSha256} : {}) });
    if (initialize && !fs.existsSync(filePath)) {
        const fd = fs.openSync(filePath, "wx", 0o600);
        try { fs.writeFileSync(fd, header + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (process.platform === "linux") {
            const directoryFd = fs.openSync(path.dirname(filePath), "r");
            try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        }
    }
    const canonicalPath = fs.realpathSync.native(filePath);
    const lockId = hash(process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath);
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\seabyss-payment-hold-${lockId}` :
        process.platform === "linux" ? `\0seabyss-payment-hold-${lockId}` : null;
    if (!endpoint) throw new Error("PAYMENT_HOLD_OWNERSHIP_PLATFORM_UNSUPPORTED");
    let owner = null, acquiring = null, closing = false;
    function requireOwnership() {
        if (!owner || closing) throw new Error("PAYMENT_HOLD_OWNERSHIP_REQUIRED");
    }
    async function acquireOwnership() {
        if (closing) throw new Error("PAYMENT_HOLD_CLOSED");
        if (owner) return;
        if (acquiring) return acquiring;
        acquiring = new Promise((resolve, reject) => {
            const server = net.createServer(socket => socket.destroy());
            server.once("error", () => { reject(new Error("PAYMENT_HOLD_ALREADY_OWNED_OR_UNAVAILABLE")); });
            server.listen(endpoint, () => {
                owner = server; server.unref(); resolve();
            });
        }).finally(() => { acquiring = null; });
        return acquiring;
    }
    async function close() {
        closing = true;
        if (acquiring) { try { await acquiring; } catch { /* Failed ownership has no handle to release. */ } }
        if (owner) { const server = owner; owner = null; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
    function validateEnvelope(envelope) {
        if (!exact(envelope, ["request", "receipt"])) throw new Error("PAYMENT_HOLD_ENVELOPE_INVALID");
        const reconstructed = createVerifiedMonetaryV2Payment(envelope.receipt, {
            environment, titleId, productionAuthority, receiptAlias: envelope.request?.receiptAlias
        });
        if (JSON.stringify(envelope.request) !== JSON.stringify(reconstructed))
            throw new Error("PAYMENT_HOLD_RECEIPT_CONFLICT");
        return reconstructed;
    }
    function subscriptionRequest(data) {
        if (environment !== "production" || !exact(data, ["receipt", "payloadJson", "planId", "planExternalId", "recordedAtUtc"]) ||
            !exact(data.receipt, ["playFabId", "transactionId", "activatedAtUtcIso8601", "expiresAtUtcIso8601"]) ||
            typeof data.payloadJson !== "string" || Buffer.byteLength(data.payloadJson) > 24576 ||
            typeof data.planId !== "string" || typeof data.planExternalId !== "string" ||
            typeof data.recordedAtUtc !== "string" || !Number.isFinite(Date.parse(data.recordedAtUtc)) ||
            new Date(data.recordedAtUtc).toISOString() !== data.recordedAtUtc)
            throw new Error("PAYMENT_HOLD_SUBSCRIPTION_INVALID");
        const payload = JSON.parse(data.payloadJson), receipt = data.receipt;
        if (payload.notification_type !== "payment" || Object.hasOwn(payload,"dry_run") ||
            Object.hasOwn(payload.transaction ?? {},"dry_run") || Object.hasOwn(payload.purchase?.order ?? {},"lineitems") ||
            !isSeabyssPremiumPlan(payload, data.planId, data.planExternalId) ||
            !/^[A-Za-z0-9_-]{1,160}$/.test(receipt.playFabId) || payload.user?.id !== receipt.playFabId ||
            typeof receipt.transactionId !== "string" || !/^[1-9][0-9]{0,18}$/.test(receipt.transactionId) ||
            BigInt(receipt.transactionId) > 9223372036854775807n ||
            (typeof payload.transaction?.id === "number" && !Number.isSafeInteger(payload.transaction.id)) ||
            String(payload.transaction?.id) !== receipt.transactionId)
            throw new Error("PAYMENT_HOLD_SUBSCRIPTION_INVALID");
        const period = resolveXsollaPremiumPeriod(payload, () => new Date(data.recordedAtUtc));
        if (period.activatedAtUtcIso8601 !== receipt.activatedAtUtcIso8601 || period.expiresAtUtcIso8601 !== receipt.expiresAtUtcIso8601)
            throw new Error("PAYMENT_HOLD_SUBSCRIPTION_PERIOD_CONFLICT");
        // No manufactured SKU, tier, amount or fulfillment request. Full verified parsed
        // callback is retained; this identity can only remain in manual quarantine.
        const canonical = value => value && typeof value === "object" ? Array.isArray(value)
            ? `[${value.map(canonical).join(",")}]`
            : `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
            : JSON.stringify(value);
        return {environment,titleId,transactionId:receipt.transactionId,recipient:receipt.playFabId,
            productId:"legacy_premium_subscription",productPlanVersion:null,
            canonicalPayloadSha256:hash(canonical([1,environment,titleId,receipt.transactionId,receipt.playFabId,
                data.planId,data.planExternalId,payload]))};
    }
    function read() {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
            throw new Error("PAYMENT_HOLD_FILE_INVALID");
        const bytes = fs.readFileSync(filePath);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const lines = text.split("\n");
        if (lines.shift() !== header || lines.pop() !== "") throw new Error("PAYMENT_HOLD_FILE_INVALID");
        const entries = new Map(); let sequence = 0, head = hash(header), pending = 0, quarantined = 0;
        for (const line of lines) {
            if (!line || Buffer.byteLength(line) > 32768) throw new Error("PAYMENT_HOLD_RECORD_INVALID");
            const row = JSON.parse(line);
            if (!exact(row, ["sequence", "previous", "kind", "operationId", "data", "sha256"]) ||
                row.sequence !== sequence + 1 || row.previous !== head ||
                row.sha256 !== hash(JSON.stringify([row.sequence, row.previous, row.kind, row.operationId, row.data])))
                throw new Error("PAYMENT_HOLD_CHAIN_INVALID");
            if (row.kind === "admit") {
                const request = validateEnvelope(row.data);
                if (row.operationId !== monetaryV2PaymentOperationId(request) || entries.has(row.operationId))
                    throw new Error("PAYMENT_HOLD_DUPLICATE_OR_ID_INVALID");
                entries.set(row.operationId, { operationId: row.operationId, ...row.data, handoff: null, legacyAttempt: false, quarantine: null }); pending++;
            } else if (row.kind === "legacy_subscription") {
                const request = subscriptionRequest(row.data);
                if (row.operationId !== monetaryV2PaymentOperationId(request) || entries.has(row.operationId))
                    throw new Error("PAYMENT_HOLD_DUPLICATE_OR_ID_INVALID");
                entries.set(row.operationId,{operationId:row.operationId,request,receipt:row.data.receipt,
                    legacySubscription:true,legacyEvidence:row.data,handoff:null,legacyAttempt:false,
                    quarantine:{canonicalPayloadSha256:request.canonicalPayloadSha256,
                        reason:"LEGACY_SUBSCRIPTION_REQUIRES_RECONCILIATION",recordedAtUtc:row.data.recordedAtUtc}});
                pending++;quarantined++;
            } else if (row.kind === "legacy_attempt") {
                const entry = entries.get(row.operationId);
                if (!entry || entry.handoff || entry.quarantine || entry.legacyAttempt ||
                    !exact(row.data, ["canonicalPayloadSha256"]) ||
                    row.data.canonicalPayloadSha256 !== entry.request.canonicalPayloadSha256)
                    throw new Error("PAYMENT_HOLD_LEGACY_ATTEMPT_INVALID");
                entry.legacyAttempt = true;
            } else if (row.kind === "quarantine") {
                const entry = entries.get(row.operationId), data = row.data;
                if (!entry || entry.handoff || entry.quarantine || !entry.legacyAttempt ||
                    !exact(data, ["canonicalPayloadSha256", "reason", "recordedAtUtc", "authorityEpoch", "authoritySourceHash"]) ||
                    data.canonicalPayloadSha256 !== entry.request.canonicalPayloadSha256 ||
                    data.reason !== "LEGACY_RECEIPT_OUTCOME_UNKNOWN" ||
                    typeof data.recordedAtUtc !== "string" || !Number.isFinite(Date.parse(data.recordedAtUtc)) ||
                    new Date(data.recordedAtUtc).toISOString() !== data.recordedAtUtc ||
                    !Number.isSafeInteger(data.authorityEpoch) || data.authorityEpoch < 1 ||
                    !/^[a-f0-9]{64}$/.test(data.authoritySourceHash))
                    throw new Error("PAYMENT_HOLD_QUARANTINE_INVALID");
                entry.quarantine = data; quarantined++;
            } else if (row.kind === "handoff") {
                const entry = entries.get(row.operationId);
                if (!entry || entry.handoff || entry.quarantine ||
                    !(exact(row.data, ["canonicalPayloadSha256", "authority", "status"]) ||
                      (row.data.status === "ManualReview" && exact(row.data, ["canonicalPayloadSha256", "authority", "status", "reviewReason", "recordedAtUtc"]) &&
                       typeof row.data.reviewReason === "string" && row.data.reviewReason.length > 0 && row.data.reviewReason.length <= 100 &&
                       typeof row.data.recordedAtUtc === "string" && Number.isFinite(Date.parse(row.data.recordedAtUtc)) && new Date(row.data.recordedAtUtc).toISOString() === row.data.recordedAtUtc)) ||
                    row.data.canonicalPayloadSha256 !== entry.request.canonicalPayloadSha256 ||
                    !(row.data.authority === "V1" ? ["checkpoints_pending", "already_completed"] :
                        row.data.authority === "V2" ? ["Pending", "Completed", "ManualReview"] : []).includes(row.data.status))
                    throw new Error("PAYMENT_HOLD_HANDOFF_INVALID");
                entry.handoff = row.data; pending--;
            } else throw new Error("PAYMENT_HOLD_KIND_INVALID");
            sequence = row.sequence; head = row.sha256;
        }
        if (entries.size > maximumReceipts || pending > maximumPending || sequence > maximumReceipts * 3)
            throw new Error("PAYMENT_HOLD_LIMIT_INVALID");
        return { entries, sequence, head, pending, quarantined, bytes: bytes.length };
    }
    function append(state, kind, operationId, data) {
        const row = { sequence: state.sequence + 1, previous: state.head, kind, operationId, data };
        row.sha256 = hash(JSON.stringify([row.sequence, row.previous, row.kind, row.operationId, row.data]));
        const line = JSON.stringify(row) + "\n";
        const reserved = (state.pending + (["admit","legacy_subscription"].includes(kind) ? 1 : kind === "handoff" ? -1 : 0)) * completionReserve;
        if (Buffer.byteLength(line) > 32768 || state.bytes + Buffer.byteLength(line) + reserved > maximumBytes)
            throw new Error("PAYMENT_HOLD_CAPACITY");
        boundary("before_persist", kind);
        const fd = fs.openSync(filePath, "a");
        try { fs.writeFileSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        boundary("after_persist", kind);
        read();
    }
    read();
    return Object.freeze({
        acquireOwnership, close,
        admit(receipt) {
            requireOwnership();
            const request = createVerifiedMonetaryV2Payment(receipt, { environment, titleId, productionAuthority });
            const envelope = JSON.parse(JSON.stringify({ request, receipt }));
            validateEnvelope(envelope);
            const state = read(), operationId = monetaryV2PaymentOperationId(request);
            const old = state.entries.get(operationId);
            if (old) {
                if (old.legacySubscription || old.request.canonicalPayloadSha256 !== request.canonicalPayloadSha256 ||
                    monetaryV2PaymentCanonical(old.request) !== monetaryV2PaymentCanonical(request))
                    throw new Error("PAYMENT_HOLD_CONFLICT");
                return structuredClone(old);
            }
            if (state.entries.size >= maximumReceipts || state.pending >= maximumPending)
                throw new Error("PAYMENT_HOLD_CAPACITY");
            append(state, "admit", operationId, envelope);
            return structuredClone(read().entries.get(operationId));
        },
        admitLegacySubscription(receipt, payload, planId, planExternalId, recordedAtUtc) {
            requireOwnership();
            const data={receipt:JSON.parse(JSON.stringify(receipt)),payloadJson:JSON.stringify(payload),
                planId,planExternalId,recordedAtUtc};
            const request=subscriptionRequest(data),operationId=monetaryV2PaymentOperationId(request),state=read();
            const old=state.entries.get(operationId);
            if(old){
                if(!old.legacySubscription || old.request.canonicalPayloadSha256!==request.canonicalPayloadSha256)
                    throw new Error("PAYMENT_HOLD_CONFLICT");
                return structuredClone(old);
            }
            if(state.entries.size>=maximumReceipts || state.pending>=maximumPending)throw new Error("PAYMENT_HOLD_CAPACITY");
            append(state,"legacy_subscription",operationId,data);
            return structuredClone(read().entries.get(operationId));
        },
        get(operationId) {
            requireOwnership();
            const entry = read().entries.get(operationId);
            if (!entry) throw new Error("PAYMENT_HOLD_RECEIPT_MISSING");
            return structuredClone(entry);
        },
        markLegacyAttempt(operationId, canonicalPayloadSha256) {
            requireOwnership();
            const state = read(), entry = state.entries.get(operationId);
            if (!entry || entry.quarantine || entry.request.canonicalPayloadSha256 !== canonicalPayloadSha256 || entry.handoff)
                throw new Error("PAYMENT_HOLD_LEGACY_ATTEMPT_CONFLICT");
            if (!entry.legacyAttempt) append(state, "legacy_attempt", operationId, { canonicalPayloadSha256 });
        },
        quarantineLegacyAttempt(operationId, proof, recordedAtUtc = new Date().toISOString()) {
            requireOwnership();
            const state = read(), entry = state.entries.get(operationId);
            if (!entry || !entry.legacyAttempt || entry.handoff || proof?.mode !== "V2" ||
                proof.environment !== environment || proof.titleId !== titleId || proof.recipient !== entry.request.recipient ||
                !Number.isSafeInteger(proof.epoch) || proof.epoch < 1 || !/^[a-f0-9]{64}$/.test(proof.sourceHash) ||
                !Number.isFinite(Date.parse(recordedAtUtc)) || new Date(recordedAtUtc).toISOString() !== recordedAtUtc)
                throw new Error("PAYMENT_HOLD_QUARANTINE_PROOF_INVALID");
            if (!entry.quarantine) append(state, "quarantine", operationId, {
                canonicalPayloadSha256: entry.request.canonicalPayloadSha256,
                reason: "LEGACY_RECEIPT_OUTCOME_UNKNOWN", recordedAtUtc,
                authorityEpoch: proof.epoch, authoritySourceHash: proof.sourceHash
            });
            return structuredClone(read().entries.get(operationId));
        },
        quarantinePage(limit = 50, after = "") {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof after !== "string")
                throw new TypeError("PAYMENT_HOLD_AUDIT_PAGE_INVALID");
            const entries = [...read().entries.values()].filter(entry => entry.quarantine || entry.handoff?.status === "ManualReview");
            const start = after ? entries.findIndex(entry => entry.operationId === after) + 1 : 0;
            if (after && start === 0) throw new Error("PAYMENT_HOLD_AUDIT_CURSOR_INVALID");
            const selected = entries.slice(start, start + limit);
            return { total: entries.length, next: start + selected.length < entries.length ? selected.at(-1).operationId : null,
                entries: selected.map(entry => ({ operationId: entry.operationId, transactionId: entry.request.transactionId,
                    recipient: entry.request.recipient, productId: entry.request.productId, productPlanVersion: entry.request.productPlanVersion,
                    canonicalPayloadSha256: entry.request.canonicalPayloadSha256,
                    ...(entry.quarantine ?? {reason:entry.handoff.reviewReason ?? "V2_DURABLE_MANUAL_REVIEW",recordedAtUtc:entry.handoff.recordedAtUtc ?? null,authority:"V2"}) })) };
        },
        handoff(operationId, canonicalPayloadSha256, authority, status, reviewReason = null) {
            requireOwnership();
            const state = read(), entry = state.entries.get(operationId);
            if (!entry || entry.quarantine || entry.request.canonicalPayloadSha256 !== canonicalPayloadSha256)
                throw new Error("PAYMENT_HOLD_HANDOFF_CONFLICT");
            const data = { canonicalPayloadSha256, authority, status };
            if (status === "ManualReview") {
                if (typeof reviewReason !== "string" || !reviewReason || reviewReason.length > 100) throw new Error("PAYMENT_HOLD_REVIEW_REASON_INVALID");
                data.reviewReason = reviewReason;
                data.recordedAtUtc = entry.handoff?.recordedAtUtc ?? new Date().toISOString();
            }
            if (entry.handoff) {
                if (JSON.stringify(entry.handoff) !== JSON.stringify(data)) throw new Error("PAYMENT_HOLD_HANDOFF_CONFLICT");
                return;
            }
            if (!(authority === "V1" ? ["checkpoints_pending", "already_completed"] :
                authority === "V2" ? ["Pending", "Completed", "ManualReview"] : []).includes(status))
                throw new Error("PAYMENT_HOLD_HANDOFF_INVALID");
            append(state, "handoff", operationId, data);
        },
        pending(limit = 8, after = "") {
            requireOwnership();
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new TypeError("PAYMENT_HOLD_SCAN_INVALID");
            const pending = [...read().entries.values()].filter(entry => !entry.handoff && !entry.quarantine);
            const next = pending.findIndex(entry => entry.operationId === after);
            const rotated = next < 0 ? pending : [...pending.slice(next + 1), ...pending.slice(0, next + 1)];
            return structuredClone(rotated.slice(0, limit));
        },
        canCreateCheckout() {
            if (!owner || closing) return false;
            const state = read();
            // Stop issuing new tokens while there is still room for previously issued tokens.
            // Existing receipts/duplicates are never discarded when this gate closes.
            return state.pending < Math.max(1, Math.floor(maximumPending * 0.75)) &&
                state.entries.size < Math.max(1, Math.floor(maximumReceipts * 0.75)) &&
                state.bytes + state.pending * completionReserve < Math.floor(maximumBytes * 0.75);
        },
        health() { const state = read(); const serviceReviews = [...state.entries.values()].filter(entry => entry.handoff?.status === "ManualReview").length;
            return { pending: state.pending, retryable: state.pending - state.quarantined, quarantined: state.quarantined + serviceReviews, localQuarantined: state.quarantined, serviceQuarantined: serviceReviews, receipts: state.entries.size, bytes: state.bytes, maximumBytes, maximumReceipts, maximumPending, owned: owner !== null && !closing }; }
    });
}
