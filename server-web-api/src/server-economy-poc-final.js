import { createServerEconomyPoc } from "./server-economy-poc.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases,
    createMemoryServerEconomyPocSnapshotStore,
    createMemoryServerEconomyPocWalStore
} from "./server-economy-poc-memory-stores.js";
import { createMemoryServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import {
    createServerEconomyPocOnlineHandshakeBatchService,
    createServerEconomyPocOnlineHandshakeConsumerHub
} from "./server-economy-poc-online-handshake-consumers.js";
import { createStrictServerEconomyPocGameplayGateway } from "./server-economy-poc-strict-gameplay-gateway.js";
import { serverEconomyPocId, serverEconomyPocPositive, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

export function createFinalServerEconomyPoc(options = {}) {
    const base = createServerEconomyPoc(options);
    const gameplay = createStrictServerEconomyPocGameplayGateway({
        engine: base.engine,
        authorize: options.authorizeGameplay || (async () => ({ authorized: false })),
        gameplayResolutionStore: options.gameplayResolutionStore,
        nowMilliseconds: options.nowMilliseconds,
        tokenFactory: options.gameplayTokenFactory,
        workerId: options.gameplayWorkerId,
        providerRetryMaximumAttempts: options.providerRetryMaximumAttempts,
        providerRetryBackoffBaseMilliseconds: options.providerRetryBackoffBaseMilliseconds,
        providerRetryBackoffMaximumMilliseconds: options.providerRetryBackoffMaximumMilliseconds,
        providerRetryJitterRatio: options.providerRetryJitterRatio,
        providerRetryRandom: options.providerRetryRandom
    });

    async function processHighValueOperation(input = {}) {
        const record = await base.engine.stores.operationInbox.get(input.playFabId, input.operationId);
        if (record?.operation?.kind === "trusted_gameplay") {
            return gameplay.consumeTrustedGameplayOperation(input);
        }
        return base.engine.processHighValueOperation(input);
    }

    async function nextPending(playFabId) {
        let cursor = 0;
        for (;;) {
            const page = await base.engine.stores.operationInbox.scanAfter({
                playFabId,
                afterSequence: cursor,
                limit: 100
            });
            const pending = page.entries.find((entry) => entry.state !== "Acked");
            if (pending) return pending;
            if (page.entries.length === 0 || page.entries.at(-1).sequence >= page.nextSequence) return null;
            cursor = page.entries.at(-1).sequence;
        }
    }

    async function processNextHighValue(playFabId, { consumer = "offline" } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const pending = await nextPending(player);
        if (!pending) return Object.freeze({ status: "empty" });
        return processHighValueOperation({ playFabId: player, operationId: pending.operationId, consumer });
    }

    async function drainHighValue(playFabId, { consumer = "offline", maximumOperations = 100 } = {}) {
        const maximum = serverEconomyPocPositive(maximumOperations, "maximumOperations");
        const results = [];
        for (let index = 0; index < maximum; index += 1) {
            const result = await processNextHighValue(playFabId, { consumer });
            if (result.status === "empty") break;
            results.push(result);
        }
        return Object.freeze(results);
    }

    const engine = Object.freeze({
        ...base.engine,
        processHighValueOperation,
        processNextHighValue,
        drainHighValue
    });
    const consumers = createServerEconomyPocOnlineHandshakeConsumerHub({
        engine,
        metrics: options.metrics,
        monotonicMilliseconds: options.monotonicMilliseconds
    });
    const batchService = createServerEconomyPocOnlineHandshakeBatchService({
        consumerHub: consumers,
        intervalMilliseconds: options.batchIntervalMilliseconds || 1000,
        maximumPlayers: options.maximumPlayersPerTick || 100
    });

    async function consumeValidatedXsollaReceipt(projection, { preferOnline = true } = {}) {
        const enqueued = await base.enqueueValidatedXsollaReceipt(projection);
        const consumed = await consumers.consumeHighValue({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId,
            preferOnline
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    return Object.freeze({
        ...base,
        engine,
        consumers,
        gameplay,
        batchService,
        consumeValidatedXsollaReceipt,
        registerOnlineSession: consumers.registerOnlineSession,
        unregisterOnlineSession: consumers.unregisterOnlineSession,
        offlineTick: consumers.offlineTick,
        snapshotOnlyLogin: consumers.snapshotOnlyLogin,
        appendOnlineEliteBallDelta: consumers.appendOnlineEliteBallDelta,
        flushOnlineEliteBall: consumers.flushOnlineEliteBall,
        terminalGameplayDispatch: true
    });
}

export function createFinalMemoryServerEconomyPocHarness({
    clock = { now: 1_000_000 },
    metrics = createMemoryServerEconomyPocMetrics(),
    authorizeGameplay = async ({ playFabId }) => ({ authorized: true, playFabId }),
    ...options
} = {}) {
    const nowMilliseconds = () => clock.now;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds });
    const snapshotStore = createMemoryServerEconomyPocSnapshotStore({ leases, nowMilliseconds });
    const walStore = createMemoryServerEconomyPocWalStore({ leases });
    const operationInbox = createMemoryServerEconomyPocOperationInbox({ leases, nowMilliseconds });
    const poc = createFinalServerEconomyPoc({
        ...options,
        snapshotStore,
        walStore,
        operationInbox,
        playerLeases: leases,
        metrics,
        authorizeGameplay,
        nowMilliseconds
    });
    return Object.freeze({
        poc,
        clock,
        metrics,
        stores: Object.freeze({ leases, snapshotStore, walStore, operationInbox }),
        memoryOnly: true,
        productionDurability: false
    });
}
