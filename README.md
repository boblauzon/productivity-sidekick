# Productivity Sidekick v1.3.0 — Deployment Bundle

**What this is:** The complete set of files for the v1.3.0 Secure Web Worker Enclave release.

## Start Here

1. **Read `PATCHES.md` first.** It describes the targeted edits you must make to your live `public/auth.js` and `public/index.html` files. The new files in this bundle drop in as-is, but those two existing files need careful editing.

2. **Then read `DEPLOY.md`.** Staging deployment, 5 mandatory smoke tests, production promotion, and 48-hour monitoring checklist.

3. **Hand `docs/backend-spec-recovery-kit.md` to your backend engineer** so they can implement the new endpoint.

## Bundle Contents

```
v1.3.0/
├── README.md                              ← this file
├── PATCHES.md                             ← ⚠️ CRITICAL: edits to live auth.js and index.html
├── DEPLOY.md                              ← staging + production guide
├── PLAN.md                                ← v1.3.0/v1.4.0 phase plan
│
├── public/
│   ├── _headers                           ← PATCHED: worker-src 'self'
│   ├── workers/
│   │   └── crypto-worker.js               ← NEW: the enclave, 600k PBKDF2
│   └── lib/
│       ├── crypto-client.js               ← NEW: main-thread bridge
│       ├── storage-persistence.js         ← NEW: Epic 104
│       ├── session-lock-modal.js          ← NEW: iOS Safari resume
│       ├── toast-notifications.js         ← NEW: EventBus-wired toasts
│       ├── recovery-key-display.js        ← NEW: shared key display
│       ├── security-settings-panel.js     ← NEW: Settings → Security
│       └── subtask-reversion.js           ← NEW: 3s undo debounce
│
├── functions/
│   └── PATCH-api-path.js                  ← INSERT into live functions/api/[[path]].js
│
├── brain/
│   └── migration-recovery-kit-version.sql ← NEW: D1 ALTER TABLE migration
│
└── docs/
    └── backend-spec-recovery-kit.md       ← spec for backend engineer
```

## What's NOT in this bundle

- **`public/auth.js`** — patched in place per `PATCHES.md`. The live file has accumulated features (PostHog identify, beta code validation, version conflict handling) that a wholesale replacement would lose.
- **`public/crypto.js`** — the legacy v1.2.x crypto module must stay in your codebase unchanged. It's loaded alongside `crypto-client.js` in v1.3.0 as the legacy recovery fallback path. Remove in v1.4.0.
- **`public/index.html`** — patched in place per `PATCHES.md` (script load order + 3 wiring points).

## Audit Status (v1.3.0)

This bundle has been audited against the live codebase. Key findings:

**✅ Vault format adapter confirmed correct.** The `vaultToWire()` / `wireToVault()` stubs in `PATCHES.md` §3.3 assume `{ciphertext, iv}` — verified by direct read of `functions/api/[[path]].js` lines 322 and 335. The server both returns and accepts this shape. No adapter changes needed.

**✅ Crypto worker rewritten to byte-compatibility with legacy `crypto.js`.** Earlier drafts used a different key derivation scheme (512 bits vs 256, email-salted HKDF vs zero-salt, standard base64 vs URL-safe) that would have broken every existing user's vault on first login. The corrected `public/workers/crypto-worker.js` is now a faithful mirror of `public/crypto.js`: same PBKDF2 parameters, same HKDF info strings (`ps-auth-key` / `ps-enc-key` / `ps-recovery-wrap`), same URL-safe base64, same 16-byte recovery keys. Existing vaults and recovery kits decrypt directly through the worker without any fallback path.

**✅ Backend endpoint re-architected for the monolithic router.** The earlier draft was a standalone file under `functions/api/auth/recovery-kit.js`, which does not match the live backend's catch-all router at `functions/api/[[path]].js`. The corrected version is a patch block at `functions/PATCH-api-path.js` containing the handler function and route line to insert into the existing router.

**⚠️ Staging smoke test #3 remains mandatory.** Despite the audit corrections, verify legacy vault decryption on a real v1.2.x account before production. Cryptographic mirroring is only as good as the mirror — a single missed detail fails silently with "Decryption failed" on every existing user.

## Deployment Order

1. Apply `brain/migration-recovery-kit-version.sql` to D1 (staging first, then production)
2. Backend engineer applies the two insertions from `functions/PATCH-api-path.js` to the live `functions/api/[[path]].js`
3. Apply all 12 patches from `PATCHES.md` to your live `auth.js` and the wiring edits to `index.html`
4. Copy the new files from this bundle into your `public/lib/`, `public/workers/`, and `public/_headers`
5. Follow `DEPLOY.md` for staging — all 5 smoke tests are mandatory
6. Promote to production only after all 5 smoke tests pass

Ship well.
