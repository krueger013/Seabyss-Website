# Financial Shadow runtime (development/Sandbox only)

Financial Shadow is non-authoritative. It records and compares Legacy outcomes
against the server economy model. It never writes the target PlayFab economy
snapshot and it is forbidden whenever production, checkout, purchase, hardened
catalog, or authority-cutover gates are enabled.

## Identity and presence ownership

- `PlayFabId` and the Title Player Account entity are derived only from
  PlayFab `AuthenticateSessionTicket` on the backend.
- `ownerServerId` identifies the web-api backend cluster. All replicas behind a
  load balancer must use the same stable `FINANCIAL_SHADOW_SERVER_ID`, or the
  deployment must provide coherent sticky routing. It is not the Unity player
  or game-server identity.
- `sessionId` is the logical Unity game-server/player-session owner. It must be
  stable for that online session and different for a competing game-server
  instance. `sessionEpoch` is allocated durably by Redis and fences a stale
  session after lease expiry/takeover.
- The session ticket is never persisted or logged. The bounded authentication
  cache and per-session rate limiter use only its SHA-256 digest.

## Observation contract

An observation carries immutable Legacy before/after snapshots plus a semantic
effect. Its immutable identity excludes only the current `sessionId` and
`sessionEpoch`, allowing the same durable Unity outbox record to reconcile after
a renewed presence lease. Any economic payload, operation/event identity,
reason/context, occurrence time, or Legacy before/after change is an idempotency
conflict.

Comparisons are scoped to the operation domain so interleaved queues cannot
create cross-domain false positives:

- `diamonds_delta`: Diamonds;
- `elite_ball_delta`: Elite;
- `premium_observation`: Premium;
- `snapshot_observation` and canonical inbox projections: all POC domains.

Premium is modeled from `{tier,durationSeconds,effectiveAtUnixMs}` using UTC,
duration stacking, and highest-active-tier rules. Expired Premium is normalized
to None in the Shadow view only; no Legacy or PlayFab state is changed.

## Canonical POC mirror inbox

The runtime uses a dedicated Redis prefix and an inbox explicitly marked
`shadowProjectionOnly`. The worker refuses any authoritative inbox. Internal
payment/POC code may call the server-local `enqueueCanonicalProjection` hook;
the mirror claims, projects with the canonical POC domain model, and ACKs only
after the Shadow Redis CAS is durable. A crash after projection but before ACK
replays the projection idempotently and then ACKs. This path grants no reward.

## Current limitation

This is Shadow telemetry and modeling, not cutover. Unity remains the Legacy
authority. The tracker therefore reports 14 partially observed paths, zero
fully covered paths, zero migrated paths, and zero cutover-ready paths.
