import {
    PAYMENT_LEDGER_MAX_AUDIT_ENTRIES
} from "./payment-ledger.js";

function copy(value) {
    return value === null || value === undefined ? value : structuredClone(value);
}

function transactionKey(provider, providerTransactionId) {
    return `${provider}\0${providerTransactionId}`;
}

function reversalKey(provider, reversalEventId) {
    return `${provider}\0${reversalEventId}`;
}

function resourceKey(resourceType, resourceId) {
    return `${resourceType}\0${resourceId}`;
}

function indexKey(index, value) {
    return `${index}\0${value}`;
}

function addIndex(indexes, index, value, key) {
    if (value === null || value === undefined) return;
    const composite = indexKey(index, value);
    const values = indexes.get(composite) || new Set();
    values.add(key);
    indexes.set(composite, values);
}

function removeIndex(indexes, index, value, key) {
    const composite = indexKey(index, value);
    const values = indexes.get(composite);
    if (!values) return;
    values.delete(key);
    if (values.size === 0) indexes.delete(composite);
}

function page(records, cursor, limit) {
    const offset = Number(cursor);
    const items = records.slice(offset, offset + limit).map(copy);
    const nextOffset = offset + items.length;
    return {
        items,
        nextCursor: nextOffset < records.length ? String(nextOffset) : null
    };
}

function sortTransactions(entries) {
    return entries.sort((left, right) =>
        left.record.createdAtUnixMs - right.record.createdAtUnixMs ||
        transactionKey(left.record.provider, left.record.providerTransactionId)
            .localeCompare(transactionKey(right.record.provider, right.record.providerTransactionId))
    );
}

function sortReversals(entries) {
    return entries.sort((left, right) =>
        left.record.createdAtUnixMs - right.record.createdAtUnixMs ||
        reversalKey(left.record.provider, left.record.reversalEventId)
            .localeCompare(reversalKey(right.record.provider, right.record.reversalEventId))
    );
}

function appendAudit(record, audit) {
    if (record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) return false;
    record.audit.push(copy(audit));
    return true;
}

function transactionLeaseMatches(record, token, nowUnixMs, requireUnexpired = true) {
    return record.leaseToken === token &&
        (!requireUnexpired || (record.leaseExpiresAtUnixMs !== null &&
            record.leaseExpiresAtUnixMs > nowUnixMs));
}

function updated(record, atUnixMs) {
    record.updatedAtUnixMs = atUnixMs;
    record.version += 1;
}

function statusForReversal(record) {
    if (record.status === "ResolvedNoClawback") return "ReviewedNoClawback";
    if (record.type === "chargeback") return "ChargebackPendingReview";
    if (record.type === "order_canceled") return "CancellationPendingReview";
    return "RefundPendingReview";
}

export function createMemoryPaymentLedgerStore() {
    const transactions = new Map();
    const transactionIndexes = new Map();
    const reversals = new Map();
    const reversalIndexes = new Map();
    const resourceLeases = new Map();
    const resourceEpochs = new Map();

    function getTransactionEntry(provider, providerTransactionId) {
        return transactions.get(transactionKey(provider, providerTransactionId)) || null;
    }

    function transactionResult(entry, status = "ok") {
        return { status, record: copy(entry.record) };
    }

    function reversalResult(entry, status = "ok") {
        return { status, record: copy(entry.record) };
    }

    return Object.freeze({
        async insertTransaction({ record, immutableHash }) {
            const key = transactionKey(record.provider, record.providerTransactionId);
            const existing = transactions.get(key);
            if (existing) {
                return existing.immutableHash === immutableHash
                    ? transactionResult(existing, "existing")
                    : { status: "conflict" };
            }
            const entry = { immutableHash, record: copy(record) };
            transactions.set(key, entry);
            addIndex(transactionIndexes, "orderId", record.orderId, key);
            addIndex(transactionIndexes, "receiptId", record.receiptId, key);
            addIndex(transactionIndexes, "playFabId", record.playFabId, key);
            addIndex(transactionIndexes, "sku", record.sku, key);
            return transactionResult(entry, "created");
        },

        async getTransaction({ provider, providerTransactionId }) {
            return copy(getTransactionEntry(provider, providerTransactionId)?.record || null);
        },

        async mutateTransaction({
            provider,
            providerTransactionId,
            expectedVersion,
            leaseToken,
            atUnixMs,
            command
        }) {
            const entry = getTransactionEntry(provider, providerTransactionId);
            if (!entry) return { status: "missing" };
            const record = entry.record;
            if (expectedVersion !== null && expectedVersion !== undefined &&
                record.version !== expectedVersion) {
                return { status: "version_conflict", currentVersion: record.version };
            }

            if (command.type === "acquire_lease") {
                if (!command.allowedFrom.includes(record.state)) {
                    return { status: "invalid_state", currentState: record.state };
                }
                const active = record.leaseToken && record.leaseExpiresAtUnixMs > atUnixMs;
                if (active && record.leaseToken !== command.token) {
                    return { status: "busy", record: copy(record) };
                }
                if (active && record.leaseToken === command.token) {
                    return transactionResult(entry, "acquired");
                }
                record.leaseOwner = command.owner;
                record.leaseToken = command.token;
                record.leaseExpiresAtUnixMs = atUnixMs + command.ttlMilliseconds;
                record.leaseEpoch += 1;
                updated(record, atUnixMs);
                return transactionResult(entry, "acquired");
            }

            if (command.type === "renew_lease") {
                if (!transactionLeaseMatches(record, leaseToken, atUnixMs)) {
                    return { status: "lease_conflict" };
                }
                record.leaseExpiresAtUnixMs = atUnixMs + command.ttlMilliseconds;
                updated(record, atUnixMs);
                return transactionResult(entry, "renewed");
            }

            if (command.type === "release_lease") {
                if (!transactionLeaseMatches(record, leaseToken, atUnixMs, false)) {
                    return { status: "lease_conflict" };
                }
                record.leaseOwner = null;
                record.leaseToken = null;
                record.leaseExpiresAtUnixMs = null;
                updated(record, atUnixMs);
                return transactionResult(entry, "released");
            }

            if (leaseToken && !transactionLeaseMatches(record, leaseToken, atUnixMs)) {
                return { status: "lease_conflict" };
            }

            if (command.type === "transition") {
                if (!command.allowedFrom.includes(record.state)) {
                    return { status: "invalid_state", currentState: record.state };
                }
                if (!appendAudit(record, command.audit)) return { status: "capacity_exceeded" };
                record.state = command.toState;
                if (command.incrementRetry) record.retryCount += 1;
                record.lastError = command.lastError;
                updated(record, atUnixMs);
                return transactionResult(entry);
            }

            if (command.type === "begin_step") {
                record.stepJournal ||= {};
                const existing = record.stepJournal[command.name];
                if (existing) {
                    return existing.operationId === command.step.operationId
                        ? transactionResult(entry, "already_present")
                        : { status: "checkpoint_conflict" };
                }
                if (Object.keys(record.stepJournal).length >= command.maximumSteps ||
                    record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) {
                    return { status: "capacity_exceeded" };
                }
                record.stepJournal[command.name] = copy(command.step);
                record.audit.push(copy(command.audit));
                updated(record, atUnixMs);
                return transactionResult(entry);
            }

            if (command.type === "apply_step") {
                record.stepJournal ||= {};
                const existing = record.stepJournal[command.name];
                if (!existing || existing.operationId !== command.operationId) {
                    return { status: "checkpoint_conflict" };
                }
                if (existing.status === "StepApplied") {
                    return existing.resultHash === command.resultHash
                        ? transactionResult(entry, "already_present")
                        : { status: "checkpoint_conflict" };
                }
                if (existing.status !== "StepPending" ||
                    record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) {
                    return { status: "checkpoint_conflict" };
                }
                existing.status = "StepApplied";
                existing.result = copy(command.result);
                existing.resultHash = command.resultHash;
                existing.updatedAtUnixMs = atUnixMs;
                existing.appliedAtUnixMs = atUnixMs;
                record.audit.push(copy(command.audit));
                updated(record, atUnixMs);
                return transactionResult(entry);
            }

            if (command.type === "checkpoint") {
                if (command.requireAppliedStep) {
                    const appliedStep = record.stepJournal?.[command.name];
                    if (!appliedStep || appliedStep.status !== "StepApplied" ||
                        appliedStep.operationId !== command.checkpoint.operationId ||
                        appliedStep.resultHash !== command.checkpoint.resultHash) {
                        return { status: "checkpoint_conflict" };
                    }
                }
                const existing = record.checkpoints[command.name];
                if (existing) {
                    return existing.operationId === command.checkpoint.operationId &&
                        existing.resultHash === command.checkpoint.resultHash
                        ? transactionResult(entry, "already_present")
                        : { status: "checkpoint_conflict" };
                }
                if (Object.keys(record.checkpoints).length >= command.maximumCheckpoints ||
                    record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) {
                    return { status: "capacity_exceeded" };
                }
                record.checkpoints[command.name] = copy(command.checkpoint);
                record.audit.push(copy(command.audit));
                updated(record, atUnixMs);
                return transactionResult(entry);
            }

            if (command.type === "append_audit") {
                if (record.audit.length >= command.maximumAuditEntries) {
                    return { status: "capacity_exceeded" };
                }
                record.audit.push(copy(command.audit));
                updated(record, atUnixMs);
                return transactionResult(entry);
            }

            return { status: "invalid_command" };
        },

        async queryTransactions({ index, value, provider, cursor, limit }) {
            const keys = [...(transactionIndexes.get(indexKey(index, value)) || [])];
            const entries = sortTransactions(keys
                .map((key) => transactions.get(key))
                .filter((entry) => entry && (!provider || entry.record.provider === provider)));
            return page(entries.map((entry) => entry.record), cursor, limit);
        },

        async scanTransactions({ cursor, limit }) {
            const entries = sortTransactions([...transactions.values()]);
            return page(entries.map((entry) => entry.record), cursor, limit);
        },

        async insertReversal({ record, immutableHash, maximumReversals }) {
            const key = reversalKey(record.provider, record.reversalEventId);
            const existing = reversals.get(key);
            if (existing) {
                return existing.immutableHash === immutableHash
                    ? reversalResult(existing, "existing")
                    : { status: "conflict" };
            }
            const transactionEntry = getTransactionEntry(
                record.provider,
                record.providerTransactionId
            );
            if (!transactionEntry) return { status: "missing" };
            const transaction = transactionEntry.record;
            if (transaction.currency !== record.currency) return { status: "currency_conflict" };
            if (transaction.reversedAmountMinor + record.amountMinor > transaction.amountMinor) {
                return { status: "amount_exceeded" };
            }
            if (transaction.reversalIds.length >= maximumReversals ||
                transaction.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) {
                return { status: "capacity_exceeded" };
            }

            const entry = { immutableHash, record: copy(record) };
            reversals.set(key, entry);
            addIndex(reversalIndexes, "originalTransaction", record.providerTransactionId, key);
            addIndex(reversalIndexes, "playFabId", record.playFabId, key);
            addIndex(reversalIndexes, "type", record.type, key);
            addIndex(reversalIndexes, "status", record.status, key);

            transaction.reversalIds.push(record.reversalEventId);
            transaction.reversedAmountMinor += record.amountMinor;
            transaction.reversalStatus = statusForReversal(record);
            transaction.audit.push({
                actor: "system",
                action: "reversal_linked",
                reason: record.reason,
                details: {
                    reversalEventId: record.reversalEventId,
                    type: record.type,
                    amountMinor: record.amountMinor
                },
                atUnixMs: record.createdAtUnixMs
            });
            updated(transaction, record.createdAtUnixMs);
            return reversalResult(entry, "created");
        },

        async getReversal({ provider, reversalEventId }) {
            return copy(reversals.get(reversalKey(provider, reversalEventId))?.record || null);
        },

        async mutateReversal({
            provider,
            reversalEventId,
            expectedVersion,
            atUnixMs,
            command
        }) {
            const key = reversalKey(provider, reversalEventId);
            const entry = reversals.get(key);
            if (!entry) return { status: "missing" };
            const record = entry.record;
            if (expectedVersion !== null && expectedVersion !== undefined &&
                record.version !== expectedVersion) {
                return { status: "version_conflict", currentVersion: record.version };
            }
            if (command.type !== "transition" || !command.allowedFrom.includes(record.status)) {
                return { status: "invalid_state", currentState: record.status };
            }
            const transactionEntry = getTransactionEntry(provider, record.providerTransactionId);
            if (!transactionEntry) return { status: "missing" };
            if (record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES ||
                transactionEntry.record.audit.length >= PAYMENT_LEDGER_MAX_AUDIT_ENTRIES) {
                return { status: "capacity_exceeded" };
            }
            const oldStatus = record.status;
            record.status = command.toStatus;
            record.audit.push(copy(command.audit));
            updated(record, atUnixMs);
            removeIndex(reversalIndexes, "status", oldStatus, key);
            addIndex(reversalIndexes, "status", record.status, key);

            const transaction = transactionEntry.record;
            transaction.reversalStatus = statusForReversal(record);
            transaction.audit.push({
                actor: command.audit.actor,
                action: "reversal_status_updated",
                reason: command.audit.reason,
                details: {
                    reversalEventId,
                    status: command.toStatus
                },
                atUnixMs
            });
            updated(transaction, atUnixMs);
            return reversalResult(entry);
        },

        async queryReversals({ index, value, provider, cursor, limit }) {
            const keys = [...(reversalIndexes.get(indexKey(index, value)) || [])];
            const entries = sortReversals(keys
                .map((key) => reversals.get(key))
                .filter((entry) => entry && (!provider || entry.record.provider === provider)));
            return page(entries.map((entry) => entry.record), cursor, limit);
        },

        async scanReversals({ cursor, limit }) {
            const entries = sortReversals([...reversals.values()]);
            return page(entries.map((entry) => entry.record), cursor, limit);
        },

        async acquireResourceLease({
            resourceType,
            resourceId,
            owner,
            token,
            ttlMilliseconds,
            atUnixMs
        }) {
            const key = resourceKey(resourceType, resourceId);
            const existing = resourceLeases.get(key);
            if (existing && existing.expiresAtUnixMs > atUnixMs && existing.token !== token) {
                return { status: "busy", lease: copy(existing) };
            }
            if (existing && existing.expiresAtUnixMs > atUnixMs && existing.token === token) {
                return { status: "acquired", lease: copy(existing) };
            }
            const epoch = (resourceEpochs.get(key) || 0) + 1;
            resourceEpochs.set(key, epoch);
            const lease = {
                resourceType,
                resourceId,
                owner,
                token,
                epoch,
                acquiredAtUnixMs: atUnixMs,
                expiresAtUnixMs: atUnixMs + ttlMilliseconds
            };
            resourceLeases.set(key, lease);
            return { status: "acquired", lease: copy(lease) };
        },

        async renewResourceLease({
            resourceType,
            resourceId,
            token,
            ttlMilliseconds,
            atUnixMs
        }) {
            const existing = resourceLeases.get(resourceKey(resourceType, resourceId));
            if (!existing || existing.token !== token || existing.expiresAtUnixMs <= atUnixMs) {
                return { status: "lease_conflict" };
            }
            existing.expiresAtUnixMs = atUnixMs + ttlMilliseconds;
            return { status: "renewed", lease: copy(existing) };
        },

        async releaseResourceLease({ resourceType, resourceId, token }) {
            const key = resourceKey(resourceType, resourceId);
            const existing = resourceLeases.get(key);
            if (!existing || existing.token !== token) return { status: "lease_conflict" };
            resourceLeases.delete(key);
            return { status: "released", lease: copy(existing) };
        },

        async ping() {
            return true;
        }
    });
}
