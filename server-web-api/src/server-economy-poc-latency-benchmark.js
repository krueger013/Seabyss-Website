import { serverEconomyPocPositive, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

function defaultDelay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Deterministic local latency model. Every awaited step represents one mocked
 * provider/store round trip; it performs no network request.
 */
export async function runServerEconomyPocLoginLatencyBenchmark({
    receiptCount = 12,
    mockedRoundTripMilliseconds = 5,
    delay = defaultDelay,
    monotonicMilliseconds = () => performance.now()
} = {}) {
    const receipts = serverEconomyPocPositive(receiptCount, "receiptCount");
    const latency = serverEconomyPocPositive(mockedRoundTripMilliseconds, "mockedRoundTripMilliseconds");
    if (typeof delay !== "function" || typeof monotonicMilliseconds !== "function") {
        throw new TypeError("Latency benchmark dependencies are invalid.");
    }

    const historicalStart = monotonicMilliseconds();
    for (let index = 0; index < receipts; index += 1) {
        await delay(latency); // receipt scan/read
        await delay(latency); // sequential provider grant
        await delay(latency); // sequential checkpoint write
    }
    const historicalElapsedMilliseconds = monotonicMilliseconds() - historicalStart;

    const snapshotStart = monotonicMilliseconds();
    await delay(latency); // one canonical snapshot read
    const snapshotElapsedMilliseconds = monotonicMilliseconds() - snapshotStart;

    return serverEconomyPocReadonly({
        simulationType: "deterministic_local_mock_with_awaited_latency",
        assumptions: {
            receiptCount: receipts,
            mockedRoundTripMilliseconds: latency,
            historicalRoundTripsPerReceipt: 3,
            canonicalSnapshotRoundTrips: 1,
            networkUsed: false
        },
        historicalLogin: {
            roundTrips: receipts * 3,
            elapsedMilliseconds: historicalElapsedMilliseconds
        },
        canonicalSnapshotLogin: {
            roundTrips: 1,
            elapsedMilliseconds: snapshotElapsedMilliseconds
        },
        measuredSpeedup: historicalElapsedMilliseconds / Math.max(0.001, snapshotElapsedMilliseconds)
    });
}
