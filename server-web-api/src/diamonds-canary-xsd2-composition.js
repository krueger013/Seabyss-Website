import {
    createDiamondsCanaryXsd2CanonicalTargetExecutor
} from "./diamonds-canary-xsd2-canonical-target-executor.js";
import {
    createDiamondsCanaryXsd2LedgerExecutor
} from "./diamonds-canary-xsd2-ledger-executor.js";
import {
    createDiamondsCanaryXsd2PaymentProducer
} from "./diamonds-canary-xsd2-payment-producer.js";

/** Composes the existing certified components; it creates no mutation engine. */
export function createDiamondsCanaryXsd2Composition({
    ledger,
    loadXsollaV2Receipt,
    shadowProducer,
    canonicalRuntime,
    migrationProofCompanion = canonicalRuntime,
    verifyCanaryReadiness,
    policy,
    workerId,
    workerOptions = {}
} = {}) {
    const canonicalTargetExecutor = createDiamondsCanaryXsd2CanonicalTargetExecutor({
        canonicalRuntime,
        migrationProofCompanion
    });
    const ledgerTargetExecutor = createDiamondsCanaryXsd2LedgerExecutor({
        ledger,
        targetExecutor: canonicalTargetExecutor,
        workerId,
        workerOptions
    });
    const producer = createDiamondsCanaryXsd2PaymentProducer({
        ledger,
        loadXsollaV2Receipt,
        shadowProducer,
        targetExecutor: ledgerTargetExecutor,
        verifyCanaryReadiness,
        policy
    });
    return Object.freeze({
        producer,
        canonicalTargetExecutor,
        ledgerTargetExecutor,
        route: "ledger_receipt_plan_to_canonical_inbox_wal_playfab_target"
    });
}
