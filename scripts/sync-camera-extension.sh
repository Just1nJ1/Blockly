#!/bin/bash
# Copy a tested Camera checkout into the directory StudioX loads first.
# Skips .git so a later packaged build does not codesign git objects.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
DEFAULT_SRC=$(CDPATH= cd -- "$SCRIPT_DIR/../../WLKATA-StudioX-camera" && pwd)
SRC=${1:-$DEFAULT_SRC}
DEST=${2:-"$HOME/.wlkata-studiox/extensions/camera"}

if [[ ! -f "$SRC/extension.json" ]]; then
  echo "No extension.json in $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a \
  --exclude '.git' \
  --exclude 'tests' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  "$SRC/" "$DEST/"

SHA="uncommitted"
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHA=$(git -C "$SRC" rev-parse HEAD)
fi
echo "Synced camera $SHA"
echo "  from $SRC"
echo "  to   $DEST"
echo "Restart StudioX so the camera process reloads."
