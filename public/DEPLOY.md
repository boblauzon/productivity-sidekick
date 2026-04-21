# Productivity Sidekick — Cloudflare Deployment Guide

## Architecture

```
public/                    ← Static files (served by Cloudflare Pages CDN)
  index.html               ← Full app (3,730 lines)
  crypto.js                ← Zero-knowledge E2EE (Web Crypto API)
  auth.js                  ← Auth client (fetch() → Workers API)
  _headers                 ← Security headers (CSP, HSTS, etc.)
  _redirects               ← SPA routing catch-all

functions/                 ← Cloudflare Pages Functions (auto-deployed as Workers)
  api/
    [[path]].js            ← Catch-all API router (auth, vault, feedback, meta proxy)

schema.sql                 ← D1 database schema (2 tables)
wrangler.toml              ← Deployment configuration
```

## Deployment Steps

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 2. Create D1 Database

```bash
wrangler d1 create sidekick-db
```

This outputs a `database_id`. Copy it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "sidekick-db"
database_id = "paste-your-id-here"
```

### 3. Run Database Migration

```bash
wrangler d1 execute sidekick-db --file=schema.sql
```

Verify it worked:

```bash
wrangler d1 execute sidekick-db --command="SELECT name FROM sqlite_master WHERE type='table';"
```

You should see `users` and `vaults`.

### 4. Set Secrets

```bash
# Session signing key — generate a strong random value
wrangler secret put SESSION_SECRET
# When prompted, paste: (generate with: openssl rand -hex 32)

# Beta registration gate code
wrangler secret put BETA_CODE
# When prompted, paste: SIDEKICK-BETA  (or your custom code)

# (Optional) Discord/Slack webhook for feedback notifications
wrangler secret put FEEDBACK_WEBHOOK
# When prompted, paste your webhook URL
```

### 5. Deploy

```bash
wrangler pages deploy public
```

Wrangler will:
- Upload `public/` as static assets to the Pages CDN
- Deploy `functions/api/[[path]].js` as a Pages Function
- Bind the D1 database and secrets automatically

### 6. Verify Deployment

Visit your Pages URL (e.g., `https://productivity-sidekick.pages.dev`) and:

1. You should see the login screen
2. Click "Create one" to register
3. Enter your beta code (`SIDEKICK-BETA` unless you changed it)
4. Save your recovery key
5. Create a test bucket and item
6. Log out and log back in — your data should persist

### 7. Custom Domain (Optional)

```bash
# In Cloudflare Dashboard:
# Pages → your project → Custom Domains → Add
# Point your domain's CNAME to your-project.pages.dev
```

## Local Development

```bash
# Start local dev server with D1 binding
wrangler pages dev public --d1 DB=sidekick-db

# The app runs at http://localhost:8788
# Pages Functions are available at /api/*
# D1 uses a local SQLite file
```

For first-time local setup, run the schema against the local DB:

```bash
wrangler d1 execute sidekick-db --local --file=schema.sql
```

## Security Notes

- **Zero-Knowledge E2EE**: The server stores only encrypted blobs. The encryption
  key is derived from the user's password and never leaves the browser.
- **HMAC Session Tokens**: Self-verifying, no DB lookup per request. 7-day expiry.
- **Auth Key Double-Hashing**: PBKDF2 (600k iterations, client) → SHA-256 (server).
  Even a full DB dump doesn't expose usable credentials.
- **Beta Gate**: Registration requires a code validated server-side before any
  crypto work or DB writes. Set via `BETA_CODE` secret.
- **Rate Limiting**: Per-IP, 20 requests/minute per isolate. Resets on isolate
  recycle (acceptable at beta scale).
- **SSRF Protection**: The `/api/fetch-meta` proxy blocks private/internal IPs.
- **CSP**: Enforced via both `_headers` and HTML meta tag (defense in depth).

## Free Tier Budget

| Resource        | Free Tier Limit    | Sidekick Usage (100 users)     |
|-----------------|--------------------|--------------------------------|
| Pages requests  | Unlimited          | N/A                            |
| Workers requests| 100,000/day        | ~5,000/day (50 saves × 100)    |
| D1 reads        | 5M/day             | ~10,000/day                    |
| D1 writes       | 100,000/day        | ~5,000/day                     |
| D1 storage      | 5 GB               | ~50 MB (500KB avg vault × 100) |

The single-blob vault architecture keeps D1 operations minimal — one read on login,
one write per save (debounced to 1.5s). Well within free tier for beta.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid beta access code" | Wrong code | Check `wrangler secret list`, re-set BETA_CODE |
| "Internal server error" on register | Missing D1 tables | Re-run `schema.sql` migration |
| Login works but vault is empty | DB was recreated | Data is lost if DB was deleted; users re-register |
| "Version conflict" on save | Two tabs open | Reload the stale tab |
| Meta proxy returns 502 | Target site blocks Workers UA | Expected; title stays as URL |
