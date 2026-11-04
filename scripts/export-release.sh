#!/bin/bash
# Makes a clean copy of Ingle for publishing (e.g. to a new GitHub repo), leaving your own files alone.
# Usage: scripts/export-release.sh [destination]   (default: ../Ingle-release)
#
# Copied:   source code, Support, Extensions/vscode sources, docs, licence.
# Left out: build output, node_modules, local.env, private/ — and nothing from ~/.ingle or
#           ~/Library is ever in this folder, so your chats, memory, skills and settings stay yours.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="$(pwd)"
DEST="${1:-../Ingle-release}"
[[ -f local.env ]] && source local.env

mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.build/' --exclude 'build/' --exclude 'node_modules/' --exclude 'out/' --exclude '*.vsix' \
  --exclude 'local.env' --exclude 'private/' --exclude '.DS_Store' --exclude '.git/' \
  "$SRC/" "$DEST/"

# Placeholders that must be filled in before publishing.
if grep -rIln "COPYRIGHT_HOLDER\|github.com/OWNER" "$DEST" --exclude-dir=.git; then
  echo "⚠ Replace COPYRIGHT_HOLDER (LICENSE.md) and OWNER (your GitHub name) in the files above before publishing."
fi

# Safety net: refuse if anything personal slipped in. (LICENSE.md is skipped: the copyright holder's name belongs there.)
if [[ -n "${PRIVATE_WORDS:-}" ]]; then
  if grep -rInE "$PRIVATE_WORDS" "$DEST" --exclude-dir=.git --exclude=LICENSE.md; then
    echo "✗ Found the private words above in the release copy. Fix them, then run this again."
    exit 1
  fi
fi
echo "✓ Clean copy in $DEST — review it, then: cd \"$DEST\" && git init && git add . && git commit -m 'Ingle'"
