import { createServerEconomyPocRuntimeEngine } from "./server-economy-poc-runtime-engine.js";
import {
    createRoutedServerEconomyPocBatchService,
    createRoutedServerEconomyPocConsumerHub
} from "./server-economy-poc-routed-consumers.js";
import { createServerEconomyPocGameplayGateway } from "./server-economy-poc-gameplay-gateway.js";
import {
    enqueueValidatedXsollaReceiptIntoServerEconomyPoc,
    mapValidatedXsollaReceiptToServerEconomyPocOperation
} from "./server-economy-poc-receipt-mapper.js";
import { createServerEconomyPocAtomicEventInbox } from "./server-economy-poc-atomic-event-inbox.js";
import {
    createMemoryServerEconomyPocOperationInbox,
    createMemoryServerEconomyPocPlayerLeases,
    createMemoryServerEconomyPocSnapshotStore,
    createMemoryServerEconomyPocWalStore
} from "./server-economy-poc-memory-stores.js";
import { createMemoryServerEconomyPocMetrics } from "./server-economy-poc-metrics.js";
import { serverEconomyPocReadonly } from "./server-economy-poc-model.js";

export function createServerEconomyPoc({
    snapshotStore,
    walStore,
    operationInbox,
    playerLeases,
    sequenceLeases = playerLeases,
    metrics = createMemoryServerEconomyPocMetrics(),
    authorizeGameplay = async () => ({ authorized: false }),
    batchIntervalMilliseconds = 1000,
    maximumPlayersPerTick = 100,
    nowMilliseconds = () => Date.now(),
    monotonicMilliseconds = () => performance.now(),
    uniqueEventGuard = true,
    eventIndexStore = null,
    ...engineOptions
} = {}) {
    const guardedInbox = uniqueEventGuard
        ? createServerEconomyPocAtomicEventInbox(operationInbox, { eventIndexStore })
        : operationInbox;
    const engine = createServerEconomyPocRuntimeEngine({
        ...engineOptions,
        snapshotStore,
        walStore,
        operationInbox: guardedInbox,
        playerLeases,
        sequenceLeases,
        metrics,
        nowMilliseconds,
        monotonicMilliseconds
    });
    const consumers = createRoutedServerEconomyPocConsumerHub({
        engine,
        metrics,
        monotonicMilliseconds
    });
    const batchService = createRoutedServerEconomyPocBatchService({
        consumerHub: consumers,
        intervalMilliseconds: batchIntervalMilliseconds,
        maximumPlayers: maximumPlayersPerTick
    });
    const gameplay = createServerEconomyPocGameplayGateway({
        engine,
        authorize: authorizeGameplay,
        nowMilliseconds
    });

    async function enqueueValidatedXsollaReceipt(projection) {
        return enqueueValidatedXsollaReceiptIntoServerEconomyPoc({ engine, projection });
    }

    async function consumeValidatedXsollaReceipt(projection, { preferOnline = true } = {}) {
        const enqueued = await enqueueValidatedXsollaReceipt(projection);
        const consumed = await consumers.consumeHighValue({
            playFabId: enqueued.operation.playFabId,
            operationId: enqueued.operation.operationId,
            preferOnline
        });
        return serverEconomyPocReadonly({ ...enqueued, consumed });
    }

    function metricsSnapshot() {
        return serverEconomyPocReadonly(metrics.snapshot());
    }

    return Object.freeze({
        engine,
        consumers,
        gameplay,
        batchService,
        enqueueValidatedXsollaReceipt,
        consumeValidatedXsollaReceipt,
        mapValidatedXsollaReceipt: mapValidatedXsollaReceiptToServerEconomyPocOperation,
        registerOnlineSession: consumers.registerOnlineSession,
        unregisterOnlineSession: consumers.unregisterOnlineSession,
        offlineTick: consumers.offlineTick,
        snapshotOnlyLogin: consumers.snapshotOnlyLogin,
        appendOnlineEliteBallDelta: consumers.appendOnlineEliteBallDelta,
        flushOnlineEliteBall: consumers.flushOnlineEliteBall,
        readSnapshot: engine.readSnapshot,
        metricsSnapshot,
        wiredToServer: false,
        purchasesEnabled: false,
        localPocOnly: true
    });
}

export function createMemoryServerEconomyPocHarness({
    clock = { now: 1_000_000 },
    metrics = createMemoryServerEconomyPocMetrics(),
    authorizeGameplay = async ({ playFabId }) => ({ authorized: true, playFabId }),
    ...options
} = {}) {
    const nowMilliseconds = () => clock.now;
    const leases = createMemoryServerEconomyPocPlayerLeases({ nowMilliseconds });
    const snapshotStore = createMemoryServerEconomyPocSnapshotStore({
        leases,
        nowMilliseconds
    });
    const walStore = createMemoryServerEconomyPocWalStore({ leases });
    const operationInbox = createMemoryServerEconomyPocOperationInbox({
        leases,
        nowMilliseconds
    });
    const poc = createServerEconomyPoc({
        ...options,
        snapshotStore,
        walStore,
        operationInbox,
        playerLeases: leases,
        sequenceLeases: leases,
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
