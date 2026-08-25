import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    createLiveDiamondsSandboxCanaryDependencies,
    readDiamondsSandboxCanaryApplyEnvironment
} from "./diamonds-sandbox-canary-apply.mjs";

const OPERATION_IDS = Object.freeze([
    "diamonds-canary-v1:grant-25",
    "diamonds-canary-v1:spend-10",
    "diamonds-canary-v1:insufficient-16"
]);

async function main() {
    const configuration = readDiamondsSandboxCanaryApplyEnvironment({ environment: process.env, mode: "verify" });
    const live = await createLiveDiamondsSandboxCanaryDependencies(configuration);
    try {
        const target = await live.dependencies.readTarget();
        const migrationProof = await live.dependencies.readMigrationProof();
        const operations = {};
        for (const operationId of OPERATION_IDS) {
            const record = await live.dependencies.readTargetOperation({ operationId });
            operations[operationId] = record === null ? null : {
                state: record.state,
                sequence: record.sequence,
                resultStatus: record.result?.status ?? null,
                resolutionState: record.result?.resolutionState ?? null,
                operationHash: record.operation?.immutableHash ?? null
            };
        }
        const providerTransactionId = await live.dependencies.getSyntheticProviderTransactionId();
        let transaction = null;
        try {
            const item = await live.dependencies.readLedgerTransaction({ providerTransactionId });
            transaction = { state: item.state, checkpoints: Object.keys(item.checkpoints || {}).sort() };
        } catch (error) {
            transaction = { state: "absent", code: error?.code || null };
        }
        process.stdout.write(`${JSON.stringify({
            playFabId: configuration.playFabId,
            target: {
                diamonds: target.diamonds,
                revision: target.revision,
                fencingEpoch: target.fencingEpoch,
                highValueAppliedThroughSequence: target.highValueAppliedThroughSequence
            },
            migrationProof: {
                state: migrationProof.state,
                targetValue: migrationProof.targetValue,
                targetOnlyOperationCount: migrationProof.targetOnlyOperationCount
            },
            operations,
            syntheticXsd2: { providerTransactionId, transaction }
        })}\n`);
    } finally {
        await live.close();
    }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({ code: error?.code || "CANARY_INSPECT_FAILED", message: error?.message })}\n`);
        process.exitCode = 1;
    });
}
