#!/usr/bin/env bash
# scripts/cleanup-legacy-js.sh
# Removes legacy vanilla-JS files left over from the v1.3.0 bundle.
# Default: dry-run. Pass --apply to delete.
#
# Will refuse to delete legitimate config files (postcss.config.js,
# tailwind.config.js).

set -euo pipefail
cd "$(dirname "$0")/.."

LEGACY_FILES=(
  "crypto-client.js"
  "crypto-worker.js"
  "recovery-key-display.js"
  "session-lock-modal.js"
  "storage-persistence.js"
  "subtask-reversion.js"
  "toast-notifications.js"
  "security-settings-panel.js"
  "auth.js"
  "crypto.js"
  "public/crypto-client.js"
  "public/crypto-worker.js"
  "public/lib/crypto-client.js"
  "public/lib/recovery-key-display.js"
  "public/lib/security-settings-panel.js"
  "public/lib/session-lock-modal.js"
  "public/lib/storage-persistence.js"
  "public/lib/subtask-reversion.js"
  "public/lib/toast-notifications.js"
  "public/workers/crypto-worker.js"
  "public/auth.js"
  "public/crypto.js"
)

PROTECT=(
  "postcss.config.js"
  "tailwind.config.js"
)

mode="dry-run"
[[ "${1:-}" == "--apply" ]] && mode="apply"

found=0
for f in "${LEGACY_FILES[@]}"; do
  for p in "${PROTECT[@]}"; do
    if [[ "$f" == "$p" ]]; then
      echo "PROTECT: refusing to consider $f"
      continue 2
    fi
  done
  if [[ -f "$f" ]]; then
    found=$((found+1))
    if [[ "$mode" == "apply" ]]; then
      echo "DELETE  $f"
      rm "$f"
    else
      echo "WOULD DELETE  $f"
    fi
  fi
done

if [[ $found -eq 0 ]]; then
  echo "Nothing to delete. Repo is already clean of legacy JS."
  exit 0
fi

if [[ "$mode" == "dry-run" ]]; then
  echo
  echo "Dry-run only. To actually delete, run: $0 --apply"
fi
