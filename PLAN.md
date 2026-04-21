# Productivity Sidekick — Architecture Migration Plan

**Current target:** v1.3.0 (this release)
**Next target:** v1.4.0 (Event Lake & Multi-Device Sync)
**Long-term target:** v1.5.0+ (Micro-Frontend Decomposition)

## Guiding Principles

1. **Zero-Knowledge is non-negotiable.** Server never sees plaintext or master key.
2. **Ship in vertical slices.** Each phase produces a deployable, testable build.
3. **Backward compatibility.** Existing v1.2.x vaults must continue to decrypt during migration.
4. **Worker enclave first, event lake second.** Security wins ship independently of storage rewrite.

## Phase 0 — Foundation (v1.2.0) — COMPLETE

- EventBus minimal pub/sub
- Subtask reversion debounce
- Feature flag infrastructure

## Phase 1 — Secure Web Worker Enclave (v1.3.0) — THIS RELEASE

**Atomic steps:**

1.1. `workers/crypto-worker.js` holds `masterKey` as extractable CryptoKey. PBKDF2 at 600k iterations.
1.2. `lib/crypto-client.js` main-thread promise bridge with per-call timeouts.
1.3. Move PBKDF2 derivation INTO the worker. Password consumed on postMessage.
1.4. Migrate `auth.js` login/register to use crypto-client.
1.5. Migrate saveVault/loadVault to route through the worker.
1.6. `wipe` command on logout terminates the worker entirely.
1.7. Legacy `crypto.js` retained alongside new path for recovery fallback only.
1.8. Backward-compatible recovery: try v1.3.0 format → fall back to v1.2.x via `loadRawMasterKey`.
1.9. New user registration requires 12+ character password.
1.10. Settings → Security panel with status display + regenerate button.
1.11. Nag toast for users with `recoveryKitVersion < 2`.
1.12. Session Locked modal for iOS Safari worker termination recovery.

**Epic 104: Storage Persistence & Sync Hardening**
- `requestPersistentStorage()` fires immediately on login
- `installOnlineSyncDrain()` + `installUnsavedChangesGuard()` ship as idle stubs (wired to real outbox in v1.4.0)

**Exit criteria:**
- Master key never exists on main thread heap (except brief legacy migration window)
- All vault operations succeed via worker
- All v1.1.x and v1.2.x vaults still decrypt
- 600k PBKDF2 iterations restored from earlier 10k Cloudflare-CPU workaround

## Phase 2 — Local Event Store (v1.4.0)

**Atomic steps:**

2.1. `lib/indexeddb-store.js` promise wrapper over IndexedDB with three object stores.
2.2. Event schema: `eventId`, `aggregateId`, `aggregateType`, `eventType`, `sequenceNumber`, `clientTimestamp`, `payload`, `synced`.
2.3. `lib/domain/task-aggregate.js` — first Domain Entity producing events.
2.4. `lib/projections/task-projection.js` — replays events into read model.
2.5. `BroadcastChannel('ps-events')` for cross-tab invalidation.
2.6. Feature flag `cqrs_enabled` gates UI path.

## Phase 3 — Blind Event Lake (v1.4.0)

**Atomic steps:**

3.1. D1 `event_lake` table — append-only, per-aggregate sequence numbers, unique `event_id` for dedup.
3.2. `functions/api/events/append.js` accepts encrypted event batches.
3.3. `functions/api/events/since.js` returns events past a cursor.
3.4. `lib/sync/event-sync.js` drains outbox to server.
3.5. Wire Epic 104 idle stubs to real outbox:
   - `installOnlineSyncDrain(eventSync.drainAll)`
   - `installUnsavedChangesGuard(() => outbox.size())`
3.6. Startup pull: decrypt events via worker, replay projections.
3.7. Migration: legacy vault → synthetic events → event lake.
3.8. **Remove `crypto.js` and `loadRawMasterKey`** once telemetry shows < 5% legacy usage.

## Phase 4 — Micro-Frontend Decomposition (v1.5.0+)

Out of scope for v1.3.0 and v1.4.0. Needs its own Plan-Review-Fix cycle.

Indicator this becomes urgent: when the number of `lib/*` modules with hand-maintained script load order exceeds ~12. As of v1.3.0 we're at 8. Phase 2/3 add 3-4 more. We'll reach the threshold during v1.4.0.

## Identified Race Conditions (design-level)

1. **Concurrent commands on same aggregate** → per-aggregate sequence numbers, optimistic concurrency
2. **Worker key not yet loaded** → pendingCommands queue inside worker
3. **Outbox written, D1 sync fails** → IndexedDB as source of truth, mark `synced=true` only after ACK
4. **Multi-tab writes** → `BroadcastChannel` + client-generated `event_id` for dedup
5. **Projection rebuild during live writes** → snapshot `lastEventId`, replay up to point, resume
6. **Subtask reversion timeout fires after logout** → `isAuthenticated()` check before commit

## Cross-Cutting Concerns

**Accessibility:** Every new interactive element has logical tab index, visible focus, ARIA labels. Subtask reversion cool-down announces undo window via `aria-live="polite"`.

**Telemetry:** PostHog events (counts only, no payloads):
- `phase_1_login_via_worker`
- `recovery_completed` with `via_legacy_fallback` flag
- `recovery_kit_acknowledged`
- `recovery_kit_upgraded`
- `storage_persistence_requested`

**Rollback:** Each phase gated by `window.APP_CONFIG.features.{phase_name}_enabled`. Disable to revert without redeploy.
