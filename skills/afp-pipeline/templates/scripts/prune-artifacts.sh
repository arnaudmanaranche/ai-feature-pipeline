#!/usr/bin/env bash
# Repo-hygiene maintenance for the AI Feature Pipeline.
# Installed into <project>/.ai/scripts/prune-artifacts.sh by the afp-setup skill.
#
# Two jobs, both human-run and safe (nothing is deleted without first being
# archived; --dry-run previews everything):
#
#   --untrack                 One-time migration for a repo that committed
#                             pipeline debug files before .ai/.gitignore
#                             existed. Stops tracking the now-ignored files
#                             (context.json + per-run .agent-* dumps) without
#                             touching your working copy. Commit the result.
#
#   --archive <slug>...       Archive shipped feature folders you no longer
#   --archive-older-than <n>  need live: each becomes .ai/archive/<slug>.tar.gz
#                             and the original folder is removed. Nothing in
#                             the pipeline reads a past feature's folder (Retro
#                             only reads the current one; cross-feature memory
#                             lives in project-memory.md), so this is lossless
#                             for the workflow — the tarball keeps the full
#                             paper trail.
#
# Usage:
#   .ai/scripts/prune-artifacts.sh --untrack [--dry-run]
#   .ai/scripts/prune-artifacts.sh --archive <slug> [<slug>...] [--dry-run]
#   .ai/scripts/prune-artifacts.sh --archive-older-than <days> [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FEATURES_DIR="$ROOT/.ai/artifacts/features"
ARCHIVE_DIR="$ROOT/.ai/archive"

DRY_RUN=false
MODE=""
OLDER_THAN=""
SLUGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --untrack) MODE="untrack" ;;
    --archive) MODE="archive" ;;
    --archive-older-than) MODE="archive"; OLDER_THAN="${2:?--archive-older-than needs a number of days}"; shift ;;
    --*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) SLUGS+=("$1") ;;
  esac
  shift
done

run() {
  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] $*"
  else
    eval "$@"
  fi
}

if [ "$MODE" = "untrack" ]; then
  echo "==> Untracking now-ignored pipeline files (working copy is untouched)..."
  # --ignore-unmatch: don't fail if a pattern matches nothing (fresh installs).
  run "git -C '$ROOT' rm -r --cached --quiet --ignore-unmatch .ai/context.json"
  run "git -C '$ROOT' rm -r --cached --quiet --ignore-unmatch '.ai/artifacts/features/*/.agent-*'"
  echo "==> Done. Review with 'git status' and commit (e.g. chore(afp): untrack pipeline debug files)."
  exit 0
fi

if [ "$MODE" = "archive" ]; then
  mkdir -p "$ARCHIVE_DIR"
  if [ -n "$OLDER_THAN" ]; then
    # Feature folders not modified in the last N days.
    while IFS= read -r dir; do
      [ -n "$dir" ] && SLUGS+=("$(basename "$dir")")
    done < <(find "$FEATURES_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$OLDER_THAN" 2>/dev/null)
  fi
  if [ ${#SLUGS[@]} -eq 0 ]; then
    echo "  Nothing to archive."
    exit 0
  fi
  for slug in "${SLUGS[@]}"; do
    src="$FEATURES_DIR/$slug"
    if [ ! -d "$src" ]; then
      echo "  Skipping '$slug' — no such feature folder."
      continue
    fi
    echo "==> Archiving '$slug' -> .ai/archive/$slug.tar.gz"
    run "tar -czf '$ARCHIVE_DIR/$slug.tar.gz' -C '$FEATURES_DIR' '$slug'"
    run "rm -rf '$src'"
  done
  echo "==> Done. Commit the archive (and the removed folders) when ready."
  exit 0
fi

echo "Usage: $0 --untrack | --archive <slug>... | --archive-older-than <days> [--dry-run]" >&2
exit 1
