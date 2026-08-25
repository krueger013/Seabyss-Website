import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLiveDiamondsSandboxCanaryDependencies, readDiamondsSandboxCanaryApplyEnvironment } from "./diamonds-sandbox-canary-apply.mjs";

async function main() {
    const configuration = readDiamondsSandboxCanaryApplyEnvironment({ environment: process.env, mode: "verify" });
    const live = await createLiveDiamondsSandboxCanaryDependencies(configuration);
    try {
        const state = await live.dependencies.inspectFinishState();
        const resolution = state.resolution;
        process.stdout.write(`${JSON.stringify({
            balance: state.target.diamonds,
            revision: state.target.revision,
            targetFence: state.target.fencingEpoch,
            providerFence: state.providerFence?.fencingEpoch ?? null,
            proof: state.providerProof?.reason ?? null,
            operationState: state.operation?.state ?? null,
            resolution: resolution ? {
                state: resolution.state,
                attemptCount: resolution.providerAttemptCount,
                nextAttemptAtUnixMs: resolution.nextAttemptAtUnixMs,
                lastClassification: resolution.lastProviderClassification,
                lastErrorCode: resolution.lastProviderErrorCode,
                retryBudget: resolution.retryBudget,
                attemptHistory: (resolution.providerAttemptHistory || []).map((attempt) => ({
                    attempt: attempt.attempt,
                    epoch: attempt.fencingEpoch,
                    state: attempt.state,
                    classification: attempt.classification,
                    errorCode: attempt.errorCode
                }))
            } : null
        })}\n`);
    } finally {
        await live.close();
    }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entry === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({ code: error?.code || "CANARY_RESOLUTION_INSPECT_FAILED", message: error?.message })}\n`);
        process.exitCode = 1;
    });
}
