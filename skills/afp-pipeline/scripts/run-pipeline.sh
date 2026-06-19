#!/usr/bin/env bash
# Run the full agent pipeline — AI Feature Pipeline module
# Usage: bash scripts/run-pipeline.sh <slug> [issue-body.md] [--dry-run] [--project-root=<path>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# Check for --project-root in args
for arg in "$@"; do
  case "$arg" in
    --project-root=*) ROOT="${arg#*=}" ;;
  esac
done
SLUG="${1:?Usage: $0 <slug> [issue-body.md] [--dry-run] [--project-root=<path>]}"
ISSUE_BODY=""
DRY_RUN=""
for arg in "${@:2}"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN="--dry-run"
  elif [ -z "$ISSUE_BODY" ]; then
    ISSUE_BODY="$arg"
  fi
done
ARTIFACTS_DIR=".ai/artifacts/features/$SLUG"
MAX_LOOPS=3

# Load config
read_config() {
  node -e "try{var c=JSON.parse(require('fs').readFileSync('$ROOT/.ai/config.json','utf-8'));var p='$1'.split('.');for(var k of p)c=c[k];console.log(c)}catch(e){console.log('$2')}"
}
PACKAGE_MANAGER=$(read_config ".commands.packageManager" "npm")
RUN_SCRIPT=$(read_config ".commands.runScript" "tsx")
TYPECHECK_CMD=$(read_config ".commands.typecheck" "tsc --noEmit")
BRANCH_PREFIX=$(read_config ".project.branchPrefix" "feat")
DEFAULT_BRANCH=$(read_config ".project.defaultBranch" "main")

cd "$ROOT"

run_agent() {
  local role=$1
  local extra=""
  [ "$DRY_RUN" = "--dry-run" ] && extra="--dry-run"
  echo ""
  echo "========================================="
  echo "  Running $role..."
  echo "========================================="
  ${PACKAGE_MANAGER} ${RUN_SCRIPT} "$SCRIPT_DIR/agent-runner.ts" --role="$role" --slug="$SLUG" --project-root="$ROOT" $extra
}

read_verdict() {
  local role=${1:-}
  local file
  if [ -n "$role" ]; then
    file="$ARTIFACTS_DIR/.agent-status-${role}.json"
  else
    file="$ARTIFACTS_DIR/.agent-status.json"
  fi
  if [ -f "$file" ]; then
    node -e "try{console.log(JSON.parse(require('fs').readFileSync('$file','utf-8')).verdict)}catch(e){}" 2>/dev/null
  fi
}

# 0. Scaffold if not exists
if [ ! -d "$ARTIFACTS_DIR" ]; then
  echo "==> Scaffolding feature folder..."
  .ai/scripts/new-feature.sh "$SLUG"
fi

# Seed issue body if provided
if [ -n "$ISSUE_BODY" ]; then
  if [ -f "$ISSUE_BODY" ]; then
    cp "$ISSUE_BODY" "$ARTIFACTS_DIR/issue-body.md"
    echo "==> Seeded issue body from $ISSUE_BODY"
  else
    echo "==> Warning: issue body file not found: $ISSUE_BODY"
  fi
fi

# Create feature branch (skip in dry-run)
BRANCH="${BRANCH_PREFIX}/$SLUG"
if [ "$DRY_RUN" != "--dry-run" ]; then
  git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH" 2>/dev/null || true
fi

# 1. PM writes feature brief
run_agent pm
git add -A && git commit --no-verify -m "agent(pm): $SLUG" 2>/dev/null || true

# 2. Dev review + clarification loop
loop=0
while [ $loop -lt $MAX_LOOPS ]; do
  run_agent dev-review
  git add -A && git commit --no-verify -m "agent(dev-review): $SLUG" 2>/dev/null || true

  VERDICT=$(read_verdict)

  if [ -f "$ARTIFACTS_DIR/blocker.md" ] || [ "$VERDICT" = "blocked" ]; then
    echo ""
    echo "  BLOCKER found - human intervention required."
    echo "  See $ARTIFACTS_DIR/blocker.md"
    exit 1
  fi

  if [ "$VERDICT" = "questions" ]; then
    echo ""
    echo "  Dev has questions. Running PM respond..."
    run_agent pm-respond
    git add -A && git commit --no-verify -m "agent(pm-respond): $SLUG" 2>/dev/null || true
    loop=$((loop + 1))
    continue
  fi

  echo ""
  echo "  Dev review: clear. Proceeding."
  break
done

# Guard: exhausted loops
if [ -f "$ARTIFACTS_DIR/blocker.md" ]; then
  echo "  Unresolved blocker."
  exit 1
fi
if [ "$(read_verdict)" = "questions" ]; then
  echo "  Unresolved threads after max clarification loops."
  exit 1
fi

# 3. Rebuild context.json from source, then Architect produces technical plan
echo "==> Rebuilding context.json..."
node "$SCRIPT_DIR/rebuild-context.mjs" --project-root="$ROOT"
run_agent architect
git add -A && git commit --no-verify -m "agent(architect): $SLUG" 2>/dev/null || true

# 4. Dev implements with typecheck gate
run_agent dev

# Typecheck gate: check before committing (one retry allowed)
TC_ATTEMPT=1
while true; do
  if ${TYPECHECK_CMD} 2>/dev/null; then
    echo "  Typecheck passed (attempt $TC_ATTEMPT). Committing..."
    git add -A && git commit --no-verify -m "agent(dev): $SLUG" 2>/dev/null || true
    break
  fi

  if [ "$TC_ATTEMPT" -ge 2 ]; then
    echo "  Typecheck still FAILS after retry. Aborting."
    ${TYPECHECK_CMD} 2>&1 | head -40
    exit 1
  fi

  echo "  Typecheck FAILED (attempt $TC_ATTEMPT). Feeding errors back to Dev..."
  TC_FILE="$ARTIFACTS_DIR/.agent-typecheck-feedback.md"
  mkdir -p "$(dirname "$TC_FILE")"
  ${TYPECHECK_CMD} 2>&1 > "$TC_FILE" || true
  head -20 "$TC_FILE"

  # Revert all uncommitted changes so Dev retry starts fresh
  git checkout HEAD -- . 2>/dev/null || true

  run_agent dev
  TC_ATTEMPT=$((TC_ATTEMPT + 1))
done

# Verify Dev manifest against tech plan
echo "==> Verifying Dev manifest against tech plan..."
MANIFEST_FILE="$ARTIFACTS_DIR/.agent-dev-manifest.json"
TECH_PLAN_FILE="$ARTIFACTS_DIR/technical-plan.md"
if [ -f "$MANIFEST_FILE" ] && [ -f "$TECH_PLAN_FILE" ]; then
  node -e "
    var plan = require('fs').readFileSync('$TECH_PLAN_FILE','utf-8');
    var manifest = JSON.parse(require('fs').readFileSync('$MANIFEST_FILE','utf-8'));
    var refs = [...plan.matchAll(/\x60([a-zA-Z0-9_./()/-]+\.(ts|tsx|js|jsx|yaml))\x60/g)].map(function(m){return m[1]});
    var produced = new Set(manifest.files.map(function(f){return f.path}));
    var missing = refs.filter(function(r){return !produced.has(r) && !r.startsWith('e2e/')});
    if (missing.length > 0) {
      console.log('  WARNING — Files expected by tech plan but NOT in Dev output:');
      missing.forEach(function(f){console.log('    - '+f)});
    } else {
      console.log('  OK — All tech plan files accounted for in Dev output.');
    }
  " 2>&1 || echo "  (manifest verification skipped)"
else
  echo "  (manifest or tech plan not found — skipping verification)"
fi

# 5. Review
run_agent review
git add -A && git commit --no-verify -m "agent(review): $SLUG" 2>/dev/null || true

REVIEW_VERDICT=$(read_verdict review)
if [ "$REVIEW_VERDICT" = "FAIL" ]; then
  echo ""
  echo "  Review verdict: FAIL — pipeline halted before QA and PR."
  echo "  Fix the issues in $ARTIFACTS_DIR/review-report.md, then re-run the dev stage."
  exit 1
fi

# 6. QA
run_agent qa
git add -A && git commit --no-verify -m "agent(qa): $SLUG" 2>/dev/null || true

QA_VERDICT=$(read_verdict qa)
if [ "$QA_VERDICT" = "FAIL" ]; then
  echo ""
  echo "  QA verdict: FAIL — pipeline will push branch but NOT create a PR."
  echo "  See $ARTIFACTS_DIR/qa-report.md for details."
  # Run retro so learnings are captured, but skip PR creation
  run_agent retro
  git add -A && git commit --no-verify -m "agent(retro): $SLUG" 2>/dev/null || true
  if [ "$DRY_RUN" != "--dry-run" ]; then
    git push origin "$BRANCH" 2>&1 || echo "Push failed"
  fi
  echo ""
  echo "  Branch pushed: $BRANCH"
  echo "  QA failed — no PR created. Fix QA issues before opening a PR manually."
  exit 1
fi

# 7. Retrospective — compile session learnings
run_agent retro
git add -A && git commit --no-verify -m "agent(retro): $SLUG" 2>/dev/null || true

# 8. Push branch (skip dry-run)
if [ "$DRY_RUN" != "--dry-run" ]; then
  # Auto-rebase if branch is behind main
  git fetch origin ${DEFAULT_BRANCH} 2>/dev/null || true
  AHEAD=$(git rev-list --count "HEAD..origin/${DEFAULT_BRANCH}" 2>/dev/null || echo "0")
  if [ "$AHEAD" -gt 0 ] 2>/dev/null; then
    echo "==> Branch is behind ${DEFAULT_BRANCH} by $AHEAD commit(s). Rebasing..."
    if git rebase "origin/${DEFAULT_BRANCH}" 2>&1; then
      echo "  Rebase successful."
    else
      echo "  Rebase failed (conflicts). Aborting rebase and pushing as-is."
      git rebase --abort 2>/dev/null || true
    fi
  fi
  git push origin "$BRANCH" 2>&1 || echo "Push failed (may already exist, continuing)"
fi

# 9. Create or update PR
echo ""
echo "========================================="
echo "  Creating/updating PR..."
echo "========================================="

# Build PR body from retrospective + diff summary
RETRO_FILE="$ARTIFACTS_DIR/retrospective.md"
DIFF_STAT=$(git diff ${DEFAULT_BRANCH}...HEAD --stat 2>/dev/null || echo "")
DIFF_SUMMARY=$(git diff ${DEFAULT_BRANCH}...HEAD --shortstat 2>/dev/null || echo "")

{
  echo '## Summary'
  echo ''
  echo "**Feature:** \`$SLUG\`"
  echo "**Pipeline:** PM - Dev Review - Architect - Dev - Review - QA"
  echo ''
  if [ -n "$DIFF_SUMMARY" ]; then
    echo '### Changes'
    echo ''
    echo "\`$DIFF_SUMMARY\`"
    echo ''
  fi
  if [ -f "$RETRO_FILE" ]; then
    echo '### Retrospective'
    echo ''
    head -80 "$RETRO_FILE" 2>/dev/null
    echo ''
  fi
  echo '---'
  echo ''
  echo '**Human:** review and merge.'
} > /tmp/pr-body.md
EXISTING_PR=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [ -n "$EXISTING_PR" ]; then
  gh pr edit "$EXISTING_PR" \
    --title "feat: $SLUG" \
    --body-file /tmp/pr-body.md \
    2>&1 || true
  echo "Updated existing PR #$EXISTING_PR"
else
  gh pr create \
    --base ${DEFAULT_BRANCH} \
    --head "$BRANCH" \
    --title "feat: $SLUG" \
    --body-file /tmp/pr-body.md \
    2>&1 || echo "Failed to create PR"
fi

echo ""
echo "========================================="
echo "  Pipeline complete!"
echo "  Feature: $SLUG"
echo "  Branch: $BRANCH"
echo "  PR created/updated if gh CLI available."
echo "========================================="
