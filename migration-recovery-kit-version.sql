-- Productivity Sidekick — v1.3.0 D1 Schema Migration
-- ============================================================
-- Adds server-side tracking of recovery kit format version.
-- Safe to run multiple times (idempotent-ish — SQLite will error on
-- duplicate column, which you can ignore).
--
-- Apply to staging first:
--   wrangler d1 execute sidekick-db --file=brain/migration-recovery-kit-version.sql --preview
--
-- Then production:
--   wrangler d1 execute sidekick-db --file=brain/migration-recovery-kit-version.sql

ALTER TABLE users ADD COLUMN recovery_kit_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN recovery_kit_updated_at INTEGER;
