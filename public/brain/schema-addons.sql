-- ============================================================
-- Productivity Sidekick — Phase 1 Schema Additions
-- RUN NOW — Non-breaking additions to the existing database
-- ============================================================
--
-- This script is SAFE to run against the live sidekick-db.
-- It only ADDS new tables and new columns — it does NOT rename
-- or delete anything. The existing [[path]].js will keep working.
--
-- Run:
--   wrangler d1 execute sidekick-db --remote --file=brain/schema-addons.sql
--


-- ============================================================
-- ADD COLUMNS to existing `users` table
-- These get default values, so existing rows are unaffected.
-- ============================================================

ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';


-- ============================================================
-- TABLE: feedback
-- Persistent storage for beta feedback (replaces log-only).
-- ============================================================

CREATE TABLE IF NOT EXISTS feedback (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC);


-- ============================================================
-- TABLE: global_config
-- Key-value JSON store for app-wide configuration.
-- Admin Dashboard can update remotely; Site A reads on boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS global_config (
    key         TEXT PRIMARY KEY,
    value_json  TEXT NOT NULL,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
-- SEED DATA: Default global configuration
-- INSERT OR IGNORE ensures re-running this script is safe.
-- ============================================================

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'taxonomy_reactive',
    '["Product Defect","Customer Escalation","Slack Request","Incident Response","Bug Report"]'
);

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'taxonomy_strategic',
    '["Planned","Project","Self-Improvement","Process Improvement","OKR Initiative"]'
);

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'bump_reasons',
    '["Blocked by dependency","Waiting on stakeholder","Needs more info","Deprioritized","Scope changed"]'
);

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'fail_reasons',
    '["Interrupted by Co-worker","System Issue / Slow Tools","Personal Emergency","Lost Focus / Distracted","Underestimated Scope"]'
);

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'youtube_playlists',
    '[{"title":"Lofi Girl (Live)","videoId":"jfKfPfyJRdk","listId":null},{"title":"Chillhop (Live)","videoId":"5yx6BWlEVcY","listId":null},{"title":"Coffitivity (Café Sounds)","videoId":"h2zkV-l_TbY","listId":null}]'
);

INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'audio_options',
    '[{"value":"brown","label":"Brown Noise (Deep Focus)"},{"value":"pink","label":"Pink Noise (Rainfall)"},{"value":"white","label":"White Noise (Static)"}]'
);

-- Schema version flag — The Brain reads this to know which column
-- names to use. Pre-migration = 'v1' (old names). After the admin
-- triggers migration, this becomes 'v2' (new names).
INSERT OR IGNORE INTO global_config (key, value_json) VALUES
(
    'schema_version',
    '"v1"'
);
