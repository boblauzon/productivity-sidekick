-- Productivity Sidekick — PR-0: App Version & Login Tracking
-- ============================================================
-- Adds non-sensitive operational metadata to the users table:
--   - app_version_at_registration: the build identifier at signup time.
--     Captured once, never updated. NULL for users who registered before
--     this column existed (we don't know their original version, and
--     guessing would be worse than honest NULL).
--
--   - last_login_app_version: the build identifier at most recent login.
--     Updated on every successful login. Lets us identify users still
--     running stale clients after a deploy.
--
--   - last_login_at: timestamp (epoch milliseconds) of most recent
--     successful login. Useful for "is this user still active?" queries
--     without storing IP/UA.
--
--   - login_count: total successful logins. Cheap activity signal.
--     Initialized to 0; incremented on every successful login.
--
-- Privacy notes:
--   - We deliberately do NOT log IP address or User-Agent. That data
--     would change the privacy posture of this zero-knowledge service.
--     If those signals are ever needed, they belong in a dedicated
--     auth_events table with a retention TTL — not on the user row.
--
-- Idempotency:
--   - These ALTER TABLE statements will error with "duplicate column"
--     if run twice. That's harmless — it means the migration already ran.
--     SQLite/D1 does not support "ADD COLUMN IF NOT EXISTS" syntax.
--
-- Apply order:
--   Staging:    wrangler d1 execute sidekick-db --file=brain\migration-app-version-tracking.sql --preview
--   Production: wrangler d1 execute sidekick-db --file=brain\migration-app-version-tracking.sql

ALTER TABLE users ADD COLUMN app_version_at_registration TEXT;
ALTER TABLE users ADD COLUMN last_login_app_version TEXT;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;
ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;
