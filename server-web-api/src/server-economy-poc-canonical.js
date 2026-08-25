import {
    createFinalServerEconomyPoc
} from "./server-economy-poc-final.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases,
    createMemoryServerEconomyPocSnapshotStore,
    createMemoryServerEconomyPocWalStore
} from "./server-economy-poc-memory-stores.js";
import { createMemoryServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import {
    enqueueFinalValidatedXsollaReceipt,
    mapValidatedXsollaReceiptToFinalServerEconomyPocOperation
} from "./server-economy-poc-receipt-mapper-final.js";
import { createServerEconomyPocTrustedDiamondsService } from "./server-economy-poc-trusted-diamonds-service.js";
import { serverEconomyPocReadonly } from "./server-economy-poc-model.js";
import { resolveServerEconomyPocProviderTransactionGuard } from "./server-economy-poc-global-identity-defaults.js";
import { createMemoryServerEconomyPocGameplayResolutionStore } from "./server-economy-poc-gameplay-resolution-store.js";

export function createCanonicalServerEconomyPoc(options = {}) {
    const providerTransactionGuard = resolveServerEconomyPocProviderTransactionGuard(
        options.operationInbox, options.providerTransactionGuard
    );
    const base = createFinalServerEconomyPoc(options);
    const trustedDiamonds = createServerEconomyPocTrustedDiamondsService({
        engine: base.engine,
        gameplayGateway: base.gameplay,
        authorizeSession: options.authorizeSession || (async () => ({ authorized: false })),
        nowMilliseconds: options.nowMilliseconds
    });

    async function enqueueValidatedXsollaReceipt(projection) {
        const operation = mapValidatedXsollaReceiptToFinalServerEconomyPocOperation(projection);
        await providerTransactionGuard.claim({
            identity: operation.providerTransactionId,
            intent: {
                providerTransactionId: operation.providerTransactionId,
                playFabId: operation.playFabId,
                sku: operation.sku,
                operationId: operation.operationId
            }
        });
        const submitted = await base.engine.enqueueAuthoritativeHighValueOperation(operation);
        return serverEconomyPocReadonly({ operation, submitted });
    }

    async function consumeValidatedXsollaReceipt(projection, { preferOnline = true } = {}) {
        const enqueued = await enqueueValidatedXsollaReceipt(projection);
        const consumed = await base.consumers.consumeHighValue({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId,
            preferOnline
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    return Object.freeze({
        ...base,
        trustedDiamonds,
        enqueueValidatedXsollaReceipt,
        consumeValidatedXsollaReceipt,
        mapValidatedXsollaReceipt: mapValidatedXsollaReceiptToFinalServerEconomyPocOperation,
        canonicalProviderTransactionIdentity: true,
        canonicalGameplayDto: true,
        providerTransactionGuard,
    });
}

export function createCanonicalMemoryServerEconomyPocHarness({
    clock = { now: 1_000_000 },
    metrics = createMemoryServerEconomyPocMetrics(),
    authorizeGameplay = async ({ playFabId }) => ({ authorized: true, playFabId }),
    authorizeSession = async (input) => ({
        authorized: true,
        playFabId: input.playFabId,
        sessionId: input.sessionId,
        sessionEpoch: input.sessionEpoch,
        principal: Object.freeze({ kind: "local_test_server" })
    }),
    ...options
} = {}) {
    const nowMilliseconds = () => clock.now;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds });
    const snapshotStore = createMemoryServerEconomyPocSnapshotStore({ leases, nowMilliseconds });
    const walStore = createMemoryServerEconomyPocWalStore({ leases });
    const operationInbox = createMemoryServerEconomyPocOperationInbox({ leases, nowMilliseconds });
    const gameplayResolutionStore = options.gameplayResolutionStore ||
        createMemoryServerEconomyPocGameplayResolutionStore();
    const poc = createCanonicalServerEconomyPoc({
        ...options,
        snapshotStore,
        walStore,
        operationInbox,
        playerLeases: leases,
        sequenceLeases: leases,
        gameplayResolutionStore,
        metrics,
        authorizeGameplay,
        authorizeSession,
        nowMilliseconds
    });
    return Object.freeze({
        poc,
        clock,
        metrics,
        stores: Object.freeze({ leases, snapshotStore, walStore, operationInbox, gameplayResolutionStore }),
        memoryOnly: true,
        productionDurability: false
    });
}
