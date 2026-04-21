-- ============================================================
-- Productivity Sidekick — "The Brain" D1 Schema
-- Epic 31: Two-Site, One-Brain Architecture
-- ============================================================
--
-- This schema powers the shared Cloudflare Worker that serves:
--   Site A: The Strategic OS (client-side encrypted app)
--   Site B: The Admin Dashboard (React/Vite, built later)
--
-- MIGRATION NOTE:
--   Your existing D1 database (sidekick-db) has `users` and `vaults`
--   tables with different column names:
--     OLD: users.auth_key_hash  →  NEW: users.authKeyHash
--     OLD: vaults.encrypted_data  →  NEW: vaults.ciphertext
--   
--   Option A (Clean deploy): Create a NEW D1 database for The Brain.
--     wrangler d1 create sidekick-brain
--     wrangler d1 execute sidekick-brain --remote --file=brain/schema.sql
--
--   Option B (Migrate in-place): Run ALTER TABLE statements to rename
--     columns, then run this schema for the new tables only.
--     ALTER TABLE users RENAME COLUMN auth_key_hash TO authKeyHash;
--     ALTER TABLE vaults RENAME COLUMN encrypted_data TO ciphertext;
--     Then run the feedback + global_config CREATE TABLE blocks below.
--
-- Run: wrangler d1 execute <DB_NAME> --remote --file=brain/schema.sql
-- ============================================================


-- ============================================================
-- TABLE 1: users
-- ============================================================
-- Stores hashed auth credentials + encrypted recovery blob.
-- The authKeyHash is SHA-256(authKeyHex) — double-hashed
-- (PBKDF2 client-side → HKDF split → SHA-256 server-side).
-- The recoveryBlob is AES-GCM encrypted encKey, decryptable
-- only with the user's 128-bit recovery key.
-- plan_tier and role support future subscription + admin features.

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    authKeyHash TEXT NOT NULL,
    recoveryBlob TEXT NOT NULL,
    plan_tier   TEXT NOT NULL DEFAULT 'free',
    role        TEXT NOT NULL DEFAULT 'user',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fast lookup for login by email
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);


-- ============================================================
-- TABLE 2: vaults
-- ============================================================
-- Stores a single E2EE JSON blob per user.
-- The server can NEVER decrypt this — only the client holds encKey.
-- Optimistic locking via `version` prevents write conflicts.

CREATE TABLE IF NOT EXISTS vaults (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ciphertext  TEXT NOT NULL,
    iv          TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- TABLE 3: feedback
-- ============================================================
-- Beta feedback submitted by users from the in-app widget.
-- Queryable by the Admin Dashboard for triage and response.

CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Index for listing feedback by date (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);


-- ============================================================
-- TABLE 4: global_config
-- ============================================================
-- Key-value store for app-wide configuration.
-- Admin Dashboard can update these remotely; Site A reads on boot.
-- Values are stored as JSON strings for maximum flexibility.

CREATE TABLE IF NOT EXISTS global_config (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- SEED DATA: Default Global Configuration
-- ============================================================
-- These provide the initial dropdown options, media playlists,
-- and select-field values that the Strategic OS loads on boot.
-- The Admin Dashboard can update any of these at any time —
-- changes propagate to all users on their next app load.

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'taxonomy_reactive',
    '["Product Defect","Customer Escalation","Slack Request","Incident Response","Bug Report"]'
),
(
    'taxonomy_strategic',
    '["Planned","Project","Self-Improvement","Process Improvement","OKR Initiative"]'
),
(
    'bump_reasons',
    '["Blocked by dependency","Waiting on stakeholder","Needs more info","Deprioritized","Scope changed"]'
),
(
    'fail_reasons',
    '["Interrupted by Co-worker","System Issue / Slow Tools","Personal Emergency","Lost Focus / Distracted","Underestimated Scope"]'
),
(
    'youtube_playlists',
    '[{"title":"Lofi Girl (Live)","videoId":"jfKfPfyJRdk","listId":null},{"title":"Chillhop (Live)","videoId":"5yx6BWlEVcY","listId":null},{"title":"Coffitivity (Café Sounds)","videoId":"h2zkV-l_TbY","listId":null}]'
),
(
    'audio_options',
    '[{"value":"brown","label":"Brown Noise (Deep Focus)"},{"value":"pink","label":"Pink Noise (Rainfall)"},{"value":"white","label":"White Noise (Static)"}]'
);
