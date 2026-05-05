import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ─── Build-time version identifier ────────────────────────────────────────────
// Resolves to a string like "1.3.0+ac2ca53" — semver from package.json plus
// the short git SHA at build time. This is injected at compile time as the
// global constant `__APP_VERSION__`.
//
// The value is sent to the API on every authenticated request via the
// `X-Client-Version` header so the backend can record which build a user
// registered with and which build they last logged in from.
//
// Failure modes:
//   - If git is unavailable (e.g. CI without history), gitSha falls back to
//     "unknown" rather than failing the build. The semver part still works.
//   - If package.json is missing or malformed, the build fails fast — that's
//     the correct behaviour because something is structurally wrong.

function resolveBuildVersion(): string {
  const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version?: string }
  const semver = pkg.version ?? '0.0.0'

  let gitSha = 'unknown'
  try {
    gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // git not available or not a repo — fall through with "unknown".
  }

  return `${semver}+${gitSha}`
}

const APP_VERSION = resolveBuildVersion()

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
