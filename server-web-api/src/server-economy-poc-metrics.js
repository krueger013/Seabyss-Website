import { serverEconomyPocId, serverEconomyPocReadonly } from "./server-economy-poc-model.js";

function labelsKey(labels) {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) return "";
    return Object.keys(labels).sort().map((key) => `${key}=${String(labels[key])}`).join(",");
}

export function createMemoryServerEconomyPocMetrics() {
    const counters = new Map();
    const timings = new Map();
    function key(name, labels) {
        return `${serverEconomyPocId(name, "metric name", 160)}|${labelsKey(labels)}`;
    }
    function increment(name, value = 1, labels = {}) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Metric increment is invalid.");
        const metricKey = key(name, labels);
        counters.set(metricKey, (counters.get(metricKey) || 0) + value);
    }
    function observe(name, milliseconds, labels = {}) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("Metric duration is invalid.");
        const metricKey = key(name, labels);
        const current = timings.get(metricKey) || { count: 0, sumMilliseconds: 0, maximumMilliseconds: 0 };
        current.count += 1;
        current.sumMilliseconds += milliseconds;
        current.maximumMilliseconds = Math.max(current.maximumMilliseconds, milliseconds);
        timings.set(metricKey, current);
    }
    function snapshot() {
        return serverEconomyPocReadonly({
            counters: Object.fromEntries([...counters.entries()].sort()),
            timings: Object.fromEntries([...timings.entries()].sort())
        });
    }
    return Object.freeze({ increment, observe, snapshot });
}

export function createNoopServerEconomyPocMetrics() {
    return Object.freeze({ increment() {}, observe() {}, snapshot: () => ({ counters: {}, timings: {} }) });
}
