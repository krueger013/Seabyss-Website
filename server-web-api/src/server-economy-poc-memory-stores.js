import {
    createServerEconomyPocInitialSnapshot,
    serverEconomyPocClone,
    serverEconomyPocFail,
    serverEconomyPocId,
    serverEconomyPocNonNegative,
    serverEconomyPocPositive,
    serverEconomyPocReadonly,
    validateServerEconomyPocSnapshot
} from "./server-economy-poc-model.js";
import {
    sameServerEconomyPocHighValueProviderProof,
    validateServerEconomyPocHighValueProviderProof
} from "./server-economy-poc-provider-proof.js";
import { validateServerEconomyPocAmmoBatchProof } from "./server-economy-poc-ammo-proof.js";


function clockValue(nowMilliseconds) {
    return serverEconomyPocNonNegative(nowMilliseconds(), "store clock");
}

export function createMemoryServerEconomyPocPlayerLeases({
    nowMilliseconds = () => Date.now()
} = {}) {
    if (typeof nowMilliseconds !== "function") throw new TypeError("Lease clock is required.");
    const active = new Map();
    const epochs = new Map();

    function assertCurrentSync({ playFabId, token, epoch }) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const fencingEpoch = serverEconomyPocPositive(epoch, "fencing epoch");
        const lease = active.get(player);
        const nowUnixMs = clockValue(nowMilliseconds);
        if (!lease || lease.token !== leaseToken || lease.epoch !== fencingEpoch ||
            lease.expiresAtUnixMs <= nowUnixMs) {
            serverEconomyPocFail("POC_STALE_WRITER", "Player lease is absent, expired, or fenced.", { retryable: true });
        }
        return serverEconomyPocReadonly(lease);
    }

    async function acquire({
        playFabId,
        owner,
        token,
        ttlMilliseconds,
        minimumEpochExclusive = 0
    }) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const leaseOwner = serverEconomyPocId(owner, "lease owner", 160);
        const leaseToken = serverEconomyPocId(token, "lease token", 255);
        const ttl = serverEconomyPocPositive(ttlMilliseconds, "lease TTL");
        const epochFloor = serverEconomyPocNonNegative(
            minimumEpochExclusive,
            "minimum fencing epoch"
        );
        const nowUnixMs = clockValue(nowMilliseconds);
        const existing = active.get(player);
        if (existing && existing.expiresAtUnixMs > nowUnixMs && existing.token !== leaseToken) {
            return serverEconomyPocReadonly({ status: "busy", lease: existing });
        }
        if (existing && existing.expiresAtUnixMs > nowUnixMs && existing.token === leaseToken) {
            return serverEconomyPocReadonly({ status: "acquired", lease: existing });
        }
        const epoch = Math.max(epochs.get(player) || 0, epochFloor) + 1;
        epochs.set(player, epoch);
        const lease = {
            playFabId: player,
            owner: leaseOwner,
            token: leaseToken,
            epoch,
            acquiredAtUnixMs: nowUnixMs,
            expiresAtUnixMs: nowUnixMs + ttl
        };
        active.set(player, lease);
        return serverEconomyPocReadonly({ status: "acquired", lease });
    }

    async function renew({ playFabId, token, epoch, ttlMilliseconds }) {
        const lease = assertCurrentSync({ playFabId, token, epoch });
        const ttl = serverEconomyPocPositive(ttlMilliseconds, "lease TTL");
        const renewed = {
            ...serverEconomyPocClone(lease),
            expiresAtUnixMs: clockValue(nowMilliseconds) + ttl
        };
        active.set(playFabId, renewed);
        return serverEconomyPocReadonly({ status: "renewed", lease: renewed });
    }

    async function release({ playFabId, token, epoch }) {
        try {
            const lease = assertCurrentSync({ playFabId, token, epoch });
            active.delete(playFabId);
            return serverEconomyPocReadonly({ status: "released", lease });
        } catch (error) {
            if (error?.code === "POC_STALE_WRITER") return Object.freeze({ status: "stale" });
            throw error;
        }
    }

    async function inspect(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const lease = active.get(player);
        return lease ? serverEconomyPocReadonly(lease) : null;
    }

    return Object.freeze({ acquire, renew, release, inspect, assertCurrentSync });
}

export function createMemoryServerEconomyPocSnapshotStore({
    leases,
    nowMilliseconds = () => Date.now()
} = {}) {
    if (typeof leases?.assertCurrentSync !== "function" || typeof nowMilliseconds !== "function") {
        throw new TypeError("Snapshot store requires an atomic player fence authority and clock.");
    }
    const snapshots = new Map();
    const highValueProofs = new Map();
    const ammoProofs = new Map();

    function current(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        if (!snapshots.has(player)) {
            snapshots.set(player, createServerEconomyPocInitialSnapshot(player, clockValue(nowMilliseconds)));
        }
        return snapshots.get(player);
    }

    async function read(playFabId) {
        return serverEconomyPocReadonly(current(playFabId));
    }

    async function compareAndSet({
        playFabId,
        expectedRevision,
        leaseToken,
        fencingEpoch,
        nextSnapshot,
        operationProof = null,
        ammoProof = null
    }) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        serverEconomyPocNonNegative(expectedRevision, "expectedRevision");
        const epoch = serverEconomyPocPositive(fencingEpoch, "fencingEpoch");
        leases.assertCurrentSync({ playFabId: player, token: leaseToken, epoch });
        const existing = current(player);
        if (existing.revision !== expectedRevision) {
            return serverEconomyPocReadonly({ status: "version_conflict", snapshot: existing });
        }
        validateServerEconomyPocSnapshot(nextSnapshot, player);
        if (nextSnapshot.revision !== existing.revision + 1 || nextSnapshot.fencingEpoch !== epoch ||
            nextSnapshot.highValueAppliedThroughSequence < existing.highValueAppliedThroughSequence ||
            nextSnapshot.ammoAppliedThroughSequence < existing.ammoAppliedThroughSequence) {
            serverEconomyPocFail("POC_SNAPSHOT_CAS_INVALID", "Snapshot CAS mutation violates revision or fencing invariants.");
        }
        const highValueAdvance = nextSnapshot.highValueAppliedThroughSequence -
            existing.highValueAppliedThroughSequence;
        let verifiedProof = null;
        if (highValueAdvance !== 0) {
            if (highValueAdvance !== 1 || operationProof === null) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_REQUIRED", "High-value snapshot CAS requires one exact provider proof.");
            }
            verifiedProof = validateServerEconomyPocHighValueProviderProof(operationProof, player);
            if (verifiedProof.sequence !== nextSnapshot.highValueAppliedThroughSequence) {
                serverEconomyPocFail("POC_PROVIDER_PROOF_MISMATCH", "Provider proof sequence differs from the high-value cursor.");
            }
        } else if (operationProof !== null) {
            serverEconomyPocFail("POC_PROVIDER_PROOF_MISMATCH", "Ammo-only CAS cannot attach a high-value provider proof.");
        }
        const ammoAdvance = nextSnapshot.ammoAppliedThroughSequence -
            existing.ammoAppliedThroughSequence;
        let verifiedAmmoProof = null;
        if (ammoAdvance !== 0) {
            if (highValueAdvance !== 0 || ammoProof === null) {
                serverEconomyPocFail("POC_AMMO_PROOF_REQUIRED", "Ammo snapshot CAS requires one exact provider batch proof.");
            }
            verifiedAmmoProof = validateServerEconomyPocAmmoBatchProof(ammoProof, player);
            if (verifiedAmmoProof.firstSequence !== existing.ammoAppliedThroughSequence + 1 ||
                verifiedAmmoProof.throughSequence !== nextSnapshot.ammoAppliedThroughSequence ||
                verifiedAmmoProof.eventCount !== ammoAdvance) {
                serverEconomyPocFail(
                    "POC_AMMO_PROOF_MISMATCH",
                    "Ammo provider proof range differs from the snapshot cursor advance."
                );
            }
        } else if (ammoProof !== null) {
            serverEconomyPocFail("POC_AMMO_PROOF_MISMATCH", "Non-ammo CAS cannot attach an ammo provider proof.");
        }
        const saved = serverEconomyPocReadonly(nextSnapshot);
        snapshots.set(player, saved);
        if (verifiedProof) highValueProofs.set(player, verifiedProof);
        if (verifiedAmmoProof) ammoProofs.set(player, verifiedAmmoProof);
        return serverEconomyPocReadonly({ status: "updated", snapshot: saved });
    }

    async function readAmmoBatchProof(playFabId) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const proof = ammoProofs.get(player) || null;
        return proof ? serverEconomyPocReadonly(proof) : null;
    }

    async function verifyHighValueOperationProof({ playFabId, proof } = {}) {
        const player = serverEconomyPocId(playFabId, "playFabId", 160);
        const expected = validateServerEconomyPocHighValueProviderProof(proof, player);
        const stored = highValueProofs.get(player) || null;
        return serverEconomyPocReadonly({
            verified: sameServerEconomyPocHighValueProviderProof(stored, expected),
            proof: stored
        });
    }

    async function seed(snapshot) {
        validateServerEconomyPocSnapshot(snapshot);
        if (snapshots.has(snapshot.playFabId)) {
            serverEconomyPocFail("POC_SNAPSHOT_ALREADY_EXISTS", "Snapshot seed is create-only.");
        }
        snapshots.set(snapshot.playFabId, serverEconomyPocReadonly(snapshot));
        return read(snapshot.playFabId);
    }

    return Object.freeze({
        read,
        compareAndSet,
        verifyHighValueOperationProof,
        readAmmoBatchProof,
        seed,
        atomicFenceCas: true,
        atomicHighValueProof: true,
        atomicAmmoProof: true
    });
}

function walPlayerState(players, playFabId) {
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    if (!players.has(player)) {
        players.set(player, { nextSequence: 0, ackedThroughSequence: 0, entries: [], byEventId: new Map() });
    }
    return players.get(player);
}

export function createMemoryServerEconomyPocWalStore({ leases = null } = {}) {
    const players = new Map();

    async function append(event) {
        const state = walPlayerState(players, event?.playFabId);
        const eventId = serverEconomyPocId(event?.eventId, "eventId", 200);
        const existing = state.byEventId.get(eventId);
        if (existing) {
            if (existing.immutableHash !== event.immutableHash) {
                serverEconomyPocFail("POC_WAL_IDEMPOTENCY_CONFLICT", "Ammo eventId is bound to another event.");
            }
            return serverEconomyPocReadonly({ status: "existing", entry: existing });
        }
        const entry = {
            ...serverEconomyPocClone(event),
            sequence: ++state.nextSequence
        };
        state.entries.push(entry);
        state.byEventId.set(eventId, entry);
        return serverEconomyPocReadonly({ status: "appended", entry });
    }

    async function scanAfter({ playFabId, afterSequence, limit }) {
        const state = walPlayerState(players, playFabId);
        serverEconomyPocNonNegative(afterSequence, "afterSequence");
        const maximum = serverEconomyPocPositive(limit, "WAL scan limit");
        const entries = state.entries.filter((entry) => entry.sequence > afterSequence).slice(0, maximum);
        return serverEconomyPocReadonly({ entries, nextSequence: state.nextSequence, ackedThroughSequence: state.ackedThroughSequence });
    }

    async function ackThrough({ playFabId, throughSequence, leaseToken, fencingEpoch }) {
        const state = walPlayerState(players, playFabId);
        const through = serverEconomyPocNonNegative(throughSequence, "throughSequence");
        if (through > state.nextSequence) serverEconomyPocFail("POC_WAL_ACK_INVALID", "WAL ACK exceeds the durable sequence.");
        if (leases) leases.assertCurrentSync({ playFabId, token: leaseToken, epoch: fencingEpoch });
        state.ackedThroughSequence = Math.max(state.ackedThroughSequence, through);
        return serverEconomyPocReadonly({ status: "acked", ackedThroughSequence: state.ackedThroughSequence });
    }

    async function status(playFabId) {
        const state = walPlayerState(players, playFabId);
        return serverEconomyPocReadonly({
            nextSequence: state.nextSequence,
            ackedThroughSequence: state.ackedThroughSequence,
            pendingCount: state.nextSequence - state.ackedThroughSequence
        });
    }

    async function listPlayersWithPending({ limit = 100 } = {}) {
        const maximum = serverEconomyPocPositive(limit, "player scan limit");
        return Object.freeze([...players.entries()]
            .filter(([, state]) => state.nextSequence > state.ackedThroughSequence)
            .map(([playFabId]) => playFabId)
            .sort()
            .slice(0, maximum));
    }

    return Object.freeze({ append, scanAfter, ackThrough, status, listPlayersWithPending, durable: false });
}

function inboxPlayerState(players, playFabId) {
    const player = serverEconomyPocId(playFabId, "playFabId", 160);
    if (!players.has(player)) {
        players.set(player, { nextSequence: 0, entries: [], byOperationId: new Map() });
    }
    return players.get(player);
}

export function createMemoryServerEconomyPocOperationInbox({
    leases = null,
    nowMilliseconds = () => Date.now(),
    requireSequenceAllocationFence = false
} = {}) {
    if (typeof nowMilliseconds !== "function") throw new TypeError("Inbox clock is required.");
    const players = new Map();

    async function submit(operation, allocation = null) {
        const state = inboxPlayerState(players, operation?.playFabId);
        const operationId = serverEconomyPocId(operation?.operationId, "operationId", 200);
        const existing = state.byOperationId.get(operationId);
        if (existing) {
            if (existing.operation.immutableHash !== operation.immutableHash) {
                serverEconomyPocFail("POC_OPERATION_IDEMPOTENCY_CONFLICT", "operationId is bound to another high-value operation.");
            }
            return serverEconomyPocReadonly({ status: "existing", record: existing });
        }
        if (requireSequenceAllocationFence && allocation === null) {
            serverEconomyPocFail(
                "POC_SEQUENCE_ALLOCATION_CONTEXT_REQUIRED",
                "A fenced provider-anchored sequence allocation context is required."
            );
        }
        if (allocation !== null) {
            if (!leases || typeof leases.assertCurrentSync !== "function") {
                serverEconomyPocFail(
                    "POC_SEQUENCE_ALLOCATOR_FENCE_MISSING",
                    "Sequence allocation requires the player lease authority."
                );
            }
            const floor = serverEconomyPocNonNegative(
                allocation.minimumSequenceExclusive,
                "minimum sequence exclusive"
            );
            const token = serverEconomyPocId(allocation.playerLeaseToken, "sequence lease token", 255);
            const epoch = serverEconomyPocPositive(allocation.playerFencingEpoch, "sequence fencing epoch");
            leases.assertCurrentSync({ playFabId: operation.playFabId, token, epoch });
            state.nextSequence = Math.max(state.nextSequence, floor);
        }
        const record = {
            schemaVersion: 1,
            playFabId: operation.playFabId,
            operationId,
            sequence: ++state.nextSequence,
            state: "Pending",
            operation: serverEconomyPocClone(operation),
            claimEpoch: 0,
            claimOwner: null,
            claimToken: null,
            claimExpiresAtUnixMs: null,
            result: null,
            ackedAtUnixMs: null
        };
        state.entries.push(record);
        state.byOperationId.set(operationId, record);
        return serverEconomyPocReadonly({ status: "submitted", record });
    }

    async function get(playFabId, operationId) {
        const state = inboxPlayerState(players, playFabId);
        const record = state.byOperationId.get(serverEconomyPocId(operationId, "operationId", 200));
        return record ? serverEconomyPocReadonly(record) : null;
    }

    async function scanAfter({ playFabId, afterSequence, limit = 100 }) {
        const state = inboxPlayerState(players, playFabId);
        serverEconomyPocNonNegative(afterSequence, "afterSequence");
        const maximum = serverEconomyPocPositive(limit, "inbox scan limit");
        return serverEconomyPocReadonly({
            entries: state.entries.filter((entry) => entry.sequence > afterSequence).slice(0, maximum),
            nextSequence: state.nextSequence
        });
    }

    async function claim({ playFabId, operationId, owner, token, ttlMilliseconds }) {
        const record = await get(playFabId, operationId);
        if (!record) return Object.freeze({ status: "missing" });
        const state = inboxPlayerState(players, playFabId);
        const mutable = state.byOperationId.get(operationId);
        if (mutable.state === "Acked") return serverEconomyPocReadonly({ status: "acked", record: mutable });
        const nowUnixMs = clockValue(nowMilliseconds);
        const claimToken = serverEconomyPocId(token, "claim token", 255);
        const claimOwner = serverEconomyPocId(owner, "claim owner", 160);
        const ttl = serverEconomyPocPositive(ttlMilliseconds, "claim TTL");
        if (mutable.state === "Claimed" && mutable.claimExpiresAtUnixMs > nowUnixMs &&
            mutable.claimToken !== claimToken) {
            return serverEconomyPocReadonly({ status: "busy", record: mutable });
        }
        if (mutable.state !== "Claimed" || mutable.claimToken !== claimToken ||
            mutable.claimExpiresAtUnixMs <= nowUnixMs) {
            mutable.claimEpoch += 1;
        }
        mutable.state = "Claimed";
        mutable.claimOwner = claimOwner;
        mutable.claimToken = claimToken;
        mutable.claimExpiresAtUnixMs = nowUnixMs + ttl;
        return serverEconomyPocReadonly({ status: "claimed", record: mutable });
    }

    function assertClaim(mutable, token, claimEpoch) {
        const nowUnixMs = clockValue(nowMilliseconds);
        if (mutable.state !== "Claimed" || mutable.claimToken !== token ||
            mutable.claimEpoch !== claimEpoch || mutable.claimExpiresAtUnixMs <= nowUnixMs) {
            serverEconomyPocFail("POC_STALE_INBOX_CLAIM", "Operation inbox claim is stale.", { retryable: true });
        }
    }

    async function ack({
        playFabId, operationId, claimToken, claimEpoch, playerLeaseToken, playerFencingEpoch, result
    }) {
        const state = inboxPlayerState(players, playFabId);
        const mutable = state.byOperationId.get(serverEconomyPocId(operationId, "operationId", 200));
        if (!mutable) return Object.freeze({ status: "missing" });
        if (mutable.state === "Acked") return serverEconomyPocReadonly({ status: "acked", record: mutable });
        assertClaim(mutable, claimToken, claimEpoch);
        if (leases) {
            leases.assertCurrentSync({ playFabId, token: playerLeaseToken, epoch: playerFencingEpoch });
        }
        mutable.state = "Acked";
        mutable.result = serverEconomyPocClone(result);
        mutable.ackedAtUnixMs = clockValue(nowMilliseconds);
        mutable.claimExpiresAtUnixMs = null;
        return serverEconomyPocReadonly({ status: "acked", record: mutable });
    }

    async function releaseClaim({ playFabId, operationId, claimToken, claimEpoch }) {
        const state = inboxPlayerState(players, playFabId);
        const mutable = state.byOperationId.get(serverEconomyPocId(operationId, "operationId", 200));
        if (!mutable || mutable.state === "Acked") return Object.freeze({ status: mutable ? "acked" : "missing" });
        assertClaim(mutable, claimToken, claimEpoch);
        mutable.state = "Pending";
        mutable.claimOwner = null;
        mutable.claimToken = null;
        mutable.claimExpiresAtUnixMs = null;
        return serverEconomyPocReadonly({ status: "released", record: mutable });
    }

    async function listPlayersWithPending({ limit = 100 } = {}) {
        const maximum = serverEconomyPocPositive(limit, "player scan limit");
        return Object.freeze([...players.entries()]
            .filter(([, state]) => state.entries.some((entry) => entry.state !== "Acked"))
            .map(([playFabId]) => playFabId)
            .sort()
            .slice(0, maximum));
    }

    return Object.freeze({ submit, get, scanAfter, claim, ack, releaseClaim, listPlayersWithPending,
        durable: false, providerCursorFloorSupported: true,
        sequenceAllocationFenceRequired: requireSequenceAllocationFence === true });
}
