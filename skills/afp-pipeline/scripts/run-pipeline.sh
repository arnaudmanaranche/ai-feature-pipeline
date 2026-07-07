#!/usr/bin/env bash
# Run the full agent pipeline — AI Feature Pipeline module
# Usage: bash scripts/run-pipeline.sh <slug> [issue-body.md] [--dry-run] [--approve-design] [--project-root=<path>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
# Check for --project-root in args
for arg in "$@"; do
  case "$arg" in
    --project-root=*) ROOT="${arg#*=}" ;;
  esac
done
SLUG="${1:?Usage: $0 <slug> [issue-body.md] [--dry-run] [--approve-design] [--project-root=<path>]}"
ISSUE_BODY=""
DRY_RUN=""
APPROVE_DESIGN="false"
for arg in "${@:2}"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN="--dry-run"
  elif [ "$arg" = "--approve-design" ]; then
    APPROVE_DESIGN="true"
  elif [ -z "$ISSUE_BODY" ] && [[ "$arg" != --* ]]; then
    ISSUE_BODY="$arg"
  fi
done
ARTIFACTS_DIR=".ai/artifacts/features/$SLUG"
MAX_LOOPS=3
MAX_REVIEW_RETRIES=1

# Load config
read_config() {
  # Strip a leading '.' before splitting — '.commands.typecheck'.split('.')
  # otherwise yields a leading empty segment and every lookup silently
  # falls through to the default value below, even when the key exists.
  node -e "try{var c=JSON.parse(require('fs').readFileSync('$ROOT/.ai/config.json','utf-8'));var p='$1'.replace(/^\./,'').split('.');for(var k of p)c=c[k];if(c===undefined)throw new Error('undefined');console.log(c)}catch(e){console.log('$2')}"
}
PACKAGE_MANAGER=$(read_config ".commands.packageManager" "npm")
INSTALL_CMD=$(read_config ".commands.install" "$PACKAGE_MANAGER install")
RUN_SCRIPT=$(read_config ".commands.runScript" "npx tsx")
TYPECHECK_CMD=$(read_config ".commands.typecheck" "tsc --noEmit")
LINT_CMD=$(read_config ".commands.lint" "eslint .")
TEST_CMD=$(read_config ".commands.test" "")
BRANCH_PREFIX=$(read_config ".project.branchPrefix" "feat")
MEMORY_COMPACT_EVERY=$(read_config ".project.memoryCompactEvery" "10")
DEFAULT_BRANCH=$(read_config ".project.defaultBranch" "main")
BRANCH="${BRANCH_PREFIX}/$SLUG"

# --- Workspace isolation ---
#
# Every run — including --dry-run — executes inside a dedicated git worktree,
# never in the directory you're actively working in. This makes a bad or
# half-finished pipeline run fully reversible (delete the worktree, the
# branch, or both) without ever touching your main checkout, and it means
# --dry-run is a faithful rehearsal of the real branch/worktree/gate
# mechanics, not just the LLM call. Only the OpenRouter call is mocked and
# only the push/PR step is skipped in dry-run.
WORKTREE_ROOT="$(dirname "$ROOT")/.afp-worktrees"
WORKTREE_DIR="$WORKTREE_ROOT/$(basename "$ROOT")-$SLUG"

setup_worktree() {
  mkdir -p "$WORKTREE_ROOT"
  if [ -d "$WORKTREE_DIR" ]; then
    echo "==> Reusing existing worktree: $WORKTREE_DIR"
    return
  fi
  echo "==> Creating isolated worktree for $BRANCH at $WORKTREE_DIR"
  # -c core.hooksPath=/dev/null: some post-checkout hooks (e.g. husky's
  # "reinstall deps if the lockfile changed") assume $1/$2 are always real
  # commit SHAs. `git worktree add -b` on a brand new branch passes the
  # null SHA as the "previous HEAD", which such hooks don't handle and
  # exit non-zero on — killing the whole run under `set -e`. This is scoped
  # to worktree creation only; commit_stage() below still runs pre-commit
  # hooks normally, since those are a real quality gate, unlike a
  # dev-convenience checkout hook.
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -c core.hooksPath=/dev/null -C "$ROOT" worktree add "$WORKTREE_DIR" "$BRANCH"
  else
    git -c core.hooksPath=/dev/null -C "$ROOT" worktree add -b "$BRANCH" "$WORKTREE_DIR" "$DEFAULT_BRANCH"
  fi
}

# --- Concurrency lock ---
#
# Two invocations for the same slug racing on the same worktree/branch would
# corrupt each other's artifacts. Best-effort (mkdir is atomic on a single
# filesystem, which covers the intended case: an accidental double-trigger
# from a person or a misconfigured cron/CI, not distributed coordination).
LOCK_DIR="$WORKTREE_ROOT/.locks"
LOCK_PATH="$LOCK_DIR/$SLUG"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if ! mkdir "$LOCK_PATH" 2>/dev/null; then
    local held_pid=""
    [ -f "$LOCK_PATH/pid" ] && held_pid=$(cat "$LOCK_PATH/pid" 2>/dev/null)
    if [ -n "$held_pid" ] && ! kill -0 "$held_pid" 2>/dev/null; then
      echo "==> Stale lock from dead process $held_pid — reclaiming."
      rm -rf "$LOCK_PATH"
      mkdir "$LOCK_PATH"
    else
      echo "  Another pipeline run is already in progress for slug '$SLUG' (pid ${held_pid:-unknown})."
      echo "  If you're sure it isn't actually running, remove the lock manually: rm -rf $LOCK_PATH"
      exit 1
    fi
  fi
  echo "$$" > "$LOCK_PATH/pid"
}

release_lock() {
  rm -rf "$LOCK_PATH"
}

acquire_lock
trap release_lock EXIT

setup_worktree
PIPELINE_ROOT="$WORKTREE_DIR"

cd "$PIPELINE_ROOT"

# A git worktree shares the .git directory with $ROOT but starts with no
# node_modules and no generated hook glue (e.g. husky's .husky/_/husky.sh,
# which most package managers regenerate via a "prepare" lifecycle script
# on install). Without this, typecheck/lint/test — and even `git commit`
# itself if pre-commit hooks depend on installed tooling — all fail in the
# worktree for reasons that have nothing to do with the feature being
# built. Skipped if node_modules already exists (a resumed run reusing an
# existing worktree, e.g. after the design-gate pause).
if [ ! -d node_modules ]; then
  echo "==> Installing dependencies in the isolated worktree ($INSTALL_CMD)..."
  if ! ${INSTALL_CMD}; then
    echo "  Dependency install failed in the worktree. Aborting."
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi
fi

run_agent() {
  local role=$1
  local extra=""
  [ "$DRY_RUN" = "--dry-run" ] && extra="--dry-run"
  echo ""
  echo "========================================="
  echo "  Running $role..."
  echo "========================================="
  ${RUN_SCRIPT} "$SCRIPT_DIR/agent-runner.ts" --role="$role" --slug="$SLUG" --project-root="$PIPELINE_ROOT" $extra
}

# Commit staged agent output, honoring the project's pre-commit hooks.
# Unlike --no-verify, a real hook rejection stops the pipeline instead of
# silently continuing with unstaged/uncommitted agent output.
commit_stage() {
  local message="$1"
  git add -A
  if git diff --cached --quiet; then
    return 0
  fi
  if ! git commit -m "$message"; then
    echo ""
    echo "  Commit rejected by pre-commit hook: $message"
    echo "  Fix the hook failure (or the agent output that triggered it) before re-running."
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi
}

# Quality gates run after every Dev pass: typecheck (always), lint (always —
# `commands.lint` was configured but never actually invoked anywhere before
# this), and the project's own test suite (only if `commands.test` is
# configured — not every project has one runnable command, so this is
# opt-in rather than defaulting to a guess). All failures are combined into
# a single feedback file for the Dev retry rather than three separate ones.
run_quality_gates() {
  local feedback_file="$ARTIFACTS_DIR/.agent-typecheck-feedback.md"
  local tc_out lint_out test_out
  tc_out=$(mktemp)
  lint_out=$(mktemp)
  test_out=$(mktemp)
  local tc_ok=true lint_ok=true test_ok=true

  if ! ${TYPECHECK_CMD} > "$tc_out" 2>&1; then
    tc_ok=false
  fi
  if ! ${LINT_CMD} > "$lint_out" 2>&1; then
    lint_ok=false
  fi
  if [ -n "$TEST_CMD" ]; then
    if ! ${TEST_CMD} > "$test_out" 2>&1; then
      test_ok=false
    fi
  fi

  if [ "$tc_ok" = false ] || [ "$lint_ok" = false ] || [ "$test_ok" = false ]; then
    mkdir -p "$(dirname "$feedback_file")"
    {
      if [ "$tc_ok" = false ]; then
        echo "## Typecheck errors"
        cat "$tc_out"
        echo ""
      fi
      if [ "$lint_ok" = false ]; then
        echo "## Lint errors"
        cat "$lint_out"
        echo ""
      fi
      if [ "$test_ok" = false ]; then
        echo "## Test failures"
        cat "$test_out"
        echo ""
      fi
    } > "$feedback_file"
    head -60 "$feedback_file"
    rm -f "$tc_out" "$lint_out" "$test_out"
    return 1
  fi

  rm -f "$tc_out" "$lint_out" "$test_out"
  rm -f "$feedback_file" 2>/dev/null || true
  return 0
}

# Content hash of a file, portable across macOS (shasum) and Linux
# (sha256sum). Used to bind a design approval to the exact plan a human
# reviewed — if the plan changes, the recorded hash no longer matches and
# re-approval is required.
plan_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
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

# Session memory before context reset — .ai/project-memory.md lives across
# features (committed on each feature branch, so it survives via merges),
# but left to grow forever it stops being memory and starts being noise.
# Bump the counter here (before the retro commit, so it rides along in the
# same commit with no extra noise) and compact every MEMORY_COMPACT_EVERY
# shipped features.
bump_memory_compact_counter() {
  local counter_file=".ai/.memory-compact-counter"
  local count=0
  [ -f "$counter_file" ] && count=$(cat "$counter_file")
  count=$((count + 1))
  mkdir -p .ai
  echo "$count" > "$counter_file"
  echo "$count"
}

run_memory_compact_if_due() {
  local count="$1"
  if [ $((count % MEMORY_COMPACT_EVERY)) -eq 0 ]; then
    echo ""
    echo "==> $count features shipped — compacting .ai/project-memory.md..."
    run_agent memory-compact
    commit_stage "chore(memory-compact): after $count features"
  fi
}

# Skill creation before repeating the same workflow forever: Retro may have
# noticed a pattern recurring across 3+ features and proposed a dedicated
# skill instead of routing it through the full pipeline every time. Never
# auto-applied — just surfaced here so a human actually sees it.
notify_skill_proposals() {
  local proposals_dir=".ai/artifacts/skill-proposals"
  [ -d "$proposals_dir" ] || return 0
  local printed_header=""
  for f in "$proposals_dir"/*.md; do
    [ -e "$f" ] || continue
    if [ -z "$printed_header" ]; then
      echo ""
      echo "==> Skill proposal(s) awaiting human review:"
      printed_header="yes"
    fi
    echo "    $f"
  done
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

# 1. PM writes feature brief
run_agent pm
commit_stage "chore(pm): $SLUG"

# 2. Dev review + clarification loop
loop=0
while [ $loop -lt $MAX_LOOPS ]; do
  run_agent dev-review
  commit_stage "chore(dev-review): $SLUG"

  VERDICT=$(read_verdict)

  if [ -f "$ARTIFACTS_DIR/blocker.md" ] || [ "$VERDICT" = "blocked" ]; then
    echo ""
    echo "  BLOCKER found - human intervention required."
    echo "  See $ARTIFACTS_DIR/blocker.md"
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi

  if [ "$VERDICT" = "questions" ]; then
    echo ""
    echo "  Dev has questions. Running PM respond..."
    run_agent pm-respond
    commit_stage "chore(pm-respond): $SLUG"
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
  echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
  exit 1
fi
if [ "$(read_verdict)" = "questions" ]; then
  echo "  Unresolved threads after max clarification loops."
  echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
  exit 1
fi

# 3. Rebuild context.json from source, then Architect produces technical plan.
#
# On a RESUMED run — the worktree already carries a technical-plan.md from a
# prior invocation that paused at the design gate — do NOT regenerate the
# plan. The Architect runs at temperature > 0, so re-running it produces a
# *different* plan than the one the human actually reviewed; --approve-design
# would then greenlight code generation from a plan nobody saw. Reuse the
# exact reviewed plan instead.
if [ -f "$ARTIFACTS_DIR/technical-plan.md" ]; then
  echo "==> Reusing existing technical plan (resumed run) — not regenerating it."
else
  echo "==> Rebuilding context.json..."
  node "$SCRIPT_DIR/rebuild-context.mjs" --project-root="$PIPELINE_ROOT"
  run_agent architect

  # Diagrams before handwavy systems: a technical plan without a Mermaid
  # diagram is prose, not a plan Review can actually check the diff against.
  # Enforced structurally here, not just via prompt wording — one retry.
  DIAGRAM_ATTEMPT=1
  while ! grep -q '```mermaid' "$ARTIFACTS_DIR/technical-plan.md" 2>/dev/null; do
    if [ "$DIAGRAM_ATTEMPT" -ge 2 ]; then
      echo "  Architect did not produce a required Mermaid diagram after retry. Aborting."
      echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
      exit 1
    fi
    echo "  technical-plan.md is missing a \`\`\`mermaid diagram (attempt $DIAGRAM_ATTEMPT). Retrying Architect..."
    DIAGRAM_ATTEMPT=$((DIAGRAM_ATTEMPT + 1))
    run_agent architect
  done

  commit_stage "chore(architect): $SLUG"
fi

# --- Design gate ---
#
# No code gets written until a human has read and approved the technical
# plan. This is the "design before implementation" checkpoint: the pipeline
# pauses here (exit 0, not a failure) unless the plan was already approved
# in a prior run, or --approve-design was passed explicitly (e.g. a CI job
# re-triggered after a human approved the design-only PR/commit).
#
# The approval is bound to the plan's *content hash*, not just a marker
# file's existence: an approval recorded for one plan does not silently
# carry over to a different plan. If technical-plan.md changes after
# approval (edited by hand, or regenerated), the stored hash no longer
# matches and the pipeline demands re-approval rather than proceeding.
APPROVAL_FLAG="$ARTIFACTS_DIR/.architect-approved"
PLAN_HASH=$(plan_hash "$ARTIFACTS_DIR/technical-plan.md")
DESIGN_APPROVED="false"
if [ -f "$APPROVAL_FLAG" ]; then
  APPROVED_HASH=$(head -1 "$APPROVAL_FLAG" 2>/dev/null)
  if [ "$APPROVED_HASH" = "$PLAN_HASH" ]; then
    DESIGN_APPROVED="true"
  else
    echo "==> Technical plan differs from the approved version — re-approval required."
  fi
fi

if [ "$DESIGN_APPROVED" != "true" ]; then
  if [ "$APPROVE_DESIGN" = "true" ]; then
    echo "==> Design approved via --approve-design (plan $PLAN_HASH)."
    echo "$PLAN_HASH" > "$APPROVAL_FLAG"
    commit_stage "chore(architect): design approved for $SLUG"
  else
    echo ""
    echo "========================================="
    echo "  Design gate — awaiting approval"
    echo "========================================="
    echo "  Review the technical plan before any code is written:"
    echo "    $PIPELINE_ROOT/$ARTIFACTS_DIR/technical-plan.md"
    echo "    $PIPELINE_ROOT/$ARTIFACTS_DIR/repository-context.md"
    echo ""
    echo "  To continue once approved, re-run:"
    echo "    bash $0 $SLUG --approve-design --project-root=$ROOT"
    echo ""
    echo "  The feature branch and worktree are preserved at: $PIPELINE_ROOT"
    exit 0
  fi
fi

# 4. Dev implements with quality gates (typecheck, lint, project tests)
run_agent dev

# Quality gate: check before committing (one retry allowed)
TC_ATTEMPT=1
while true; do
  if run_quality_gates; then
    echo "  Typecheck/lint/tests passed (attempt $TC_ATTEMPT). Committing..."
    commit_stage "chore(dev): $SLUG"
    break
  fi

  if [ "$TC_ATTEMPT" -ge 2 ]; then
    echo "  Quality gates still FAIL after retry. Aborting."
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi

  echo "  Quality gates FAILED (attempt $TC_ATTEMPT). Feeding errors back to Dev..."

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

# 5. Review — with one retry: on FAIL, Dev gets the review findings and one
# more pass before the pipeline gives up. Unlike the typecheck retry, we do
# NOT discard the Dev's uncommitted work here: Review runs against committed
# code, so a retry means Dev incrementally fixes what's already there.
REVIEW_ATTEMPT=1
while true; do
  run_agent review
  commit_stage "chore(review): $SLUG"

  REVIEW_VERDICT=$(read_verdict review)
  if [ "$REVIEW_VERDICT" != "FAIL" ]; then
    break
  fi

  if [ "$REVIEW_ATTEMPT" -gt "$MAX_REVIEW_RETRIES" ]; then
    echo ""
    echo "  Review verdict: FAIL after retry — pipeline halted before QA and PR."
    echo "  See $ARTIFACTS_DIR/review-report.md."
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi

  echo ""
  echo "  Review FAILED (attempt $REVIEW_ATTEMPT). Feeding findings back to Dev..."
  cp "$ARTIFACTS_DIR/review-report.md" "$ARTIFACTS_DIR/.agent-review-feedback.md" 2>/dev/null || true
  run_agent dev

  if ! run_quality_gates; then
    echo "  Quality gates FAILED after review-retry Dev pass. Aborting."
    echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
    exit 1
  fi
  commit_stage "chore(dev): $SLUG (review fix)"
  REVIEW_ATTEMPT=$((REVIEW_ATTEMPT + 1))
done

# 6. QA
run_agent qa
commit_stage "chore(qa): $SLUG"

QA_VERDICT=$(read_verdict qa)
if [ "$QA_VERDICT" = "FAIL" ]; then
  echo ""
  echo "  QA verdict: FAIL — pipeline will push branch but NOT create a PR."
  echo "  See $ARTIFACTS_DIR/qa-report.md for details."
  # Run retro so learnings are captured, but skip PR creation
  run_agent retro
  FEATURE_COUNT=$(bump_memory_compact_counter)
  commit_stage "chore(retro): $SLUG"
  run_memory_compact_if_due "$FEATURE_COUNT"
notify_skill_proposals
  if [ "$DRY_RUN" != "--dry-run" ]; then
    git push origin "$BRANCH" 2>&1 || echo "Push failed"
  fi
  echo ""
  echo "  Branch pushed: $BRANCH"
  echo "  QA failed — no PR created. Fix QA issues before opening a PR manually."
  echo "  Worktree preserved for inspection: $PIPELINE_ROOT"
  exit 1
fi

# 7. Retrospective — compile session learnings
run_agent retro
FEATURE_COUNT=$(bump_memory_compact_counter)
commit_stage "chore(retro): $SLUG"
run_memory_compact_if_due "$FEATURE_COUNT"
notify_skill_proposals

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

PR_BODY_FILE=$(mktemp)
trap 'rm -f "$PR_BODY_FILE"' EXIT

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
} > "$PR_BODY_FILE"
EXISTING_PR=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [ -n "$EXISTING_PR" ]; then
  gh pr edit "$EXISTING_PR" \
    --title "feat: $SLUG" \
    --body-file "$PR_BODY_FILE" \
    2>&1 || true
  echo "Updated existing PR #$EXISTING_PR"
else
  gh pr create \
    --base ${DEFAULT_BRANCH} \
    --head "$BRANCH" \
    --title "feat: $SLUG" \
    --body-file "$PR_BODY_FILE" \
    2>&1 || echo "Failed to create PR"
fi

# 10. Pipeline reached the end — the isolated worktree has served its
# purpose. Remove it; the branch itself lives on in git (local + pushed,
# unless this was a --dry-run rehearsal, in which case it's local-only).
cd "$ROOT"
git worktree remove "$WORKTREE_DIR" --force 2>/dev/null || true

echo ""
echo "========================================="
echo "  Pipeline complete!"
echo "  Feature: $SLUG"
echo "  Branch: $BRANCH"
echo "  PR created/updated if gh CLI available."
echo "========================================="
