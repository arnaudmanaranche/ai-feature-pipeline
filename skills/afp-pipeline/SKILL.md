# AFP Pipeline — Feature Development Pipeline

A structured multi-agent pipeline for AI-assisted feature development.
PM → Dev Review → Architect → Dev → Review → QA → Retro.

**Model-agnostic, stack-agnostic.** Works with any AI coding tool (Claude Code, Codex, OpenCode, Cline).

## Capabilities

| Command | Description |
|---------|-------------|
| `new <description>` | Start a new feature. Scopes the feature, generates feature-brief.md |
| `run --role <role> --slug <slug>` | Run a single agent role (pm, dev-review, pm-respond, architect, dev, review, qa, retro) |
| `pipeline --slug <slug>` | Run the full pipeline for a feature, end-to-end |

## Workflow stages

Each stage produces an artifact in `.ai/artifacts/features/<slug>/`.

### 1. PM — Product Manager
**Prompt:** `prompts/pm.md`
**Output:** `feature-brief.md` — requirements, acceptance criteria, i18n, analytics, paywall, scope

### 2. Dev Review + PM Respond (clarification loop)
**Prompts:** `prompts/dev-review.md`, inline pm-respond
**Output:** `pm-dev-thread.md` — structured Q&A between dev review and PM
**Gate:** Loops up to 3 times until status is `clear`. Exits with error on `blocked`.

### 3. Architect — Software Architect
**Prompt:** `prompts/architect.md`
**Output:** `technical-plan.md` (including a mandatory Mermaid diagram of the actual flow) + `repository-context.md` — architecture, impacted files, risks, implementation order
**Gate:** Diagram gate — a plan with no ` ```mermaid ` block triggers one automatic retry, then aborts if still missing. Design gate — the pipeline then pauses (exit 0) — no code is written until a human has read the plan and re-runs with `--approve-design`. A resumed run reuses the exact plan the human reviewed (it does not regenerate the non-deterministic Architect output), and the approval is bound to the plan's content hash stored in `.ai/artifacts/features/<slug>/.architect-approved`: if the plan changes afterward, the stored hash no longer matches and re-approval is required.

### 4. Dev — Developer
**Prompt:** `prompts/dev.md`
**Output:** Code changes + `dev-log.md` — implements the feature per the tech plan
**Gate:** Typecheck runs after Dev. One retry allowed with error feedback. Fails pipeline on second failure.

### 5. Review — Code Reviewer
**Prompt:** `prompts/review.md`
**Output:** `review-report.md` — checks implementation against the brief, including whether the git diff's actual control/data flow matches the Architect's diagram
**Gate:** FAIL verdict feeds the review findings back to Dev for one retry pass (typecheck re-runs, then Review runs again). Still FAIL after the retry halts the pipeline before QA and PR creation.

### 6. QA — Quality Assurance
**Prompt:** `prompts/qa.md`
**Output:** `qa-report.md` — validates E2E flows using the project's configured framework
**Gate:** FAIL verdict pushes the branch but skips PR creation.

### 7. Retro — Retrospective
**Prompt:** `prompts/retro.md`
**Output:** `retrospective.md` + merges learnings into `.ai/project-memory.md`'s four fixed categories (Pitfalls, Conventions confirmed, Architecture decisions, Integration notes). If a pattern has recurred essentially unchanged across 3+ features, also submits a skill proposal at `.ai/artifacts/skill-proposals/<name>.md` — a suggestion for a human to review, never applied automatically.

### Memory Compact (periodic, not per-feature)
**Prompt:** `prompts/memory-compact.md`
**Trigger:** every `project.memoryCompactEvery` shipped features (default 10; both the counter and the memory file live on feature branches, so this only fires once merged PRs have carried the counter forward)
**Output:** deduplicated, pruned `.ai/project-memory.md`. Restricted at the permission layer to touch only that one file.

## Automation

Each stage can be executed via the agent-runner CLI:

```bash
node scripts/agent-runner.ts --role=<role> --slug=<slug> --project-root=<path>
```

Or run the full pipeline:

```bash
bash scripts/run-pipeline.sh <slug> [issue-body.md] [--dry-run] [--approve-design] [--project-root=<path>]
```

`--approve-design` skips the design gate (see stage 3) — pass it when the technical plan was already reviewed and approved out of band (e.g. a human approved the design-only commit/PR from a prior run). Without it, the pipeline stops after the Architect stage and tells you how to resume.

## Workspace isolation

Every run — including `--dry-run` — executes inside a dedicated git worktree at `<parent-of-project-root>/.afp-worktrees/<project>-<slug>`, never in your active working directory. This makes the run fully reversible: delete the worktree, delete the branch, or both, without touching your own uncommitted work. The worktree is removed automatically once the pipeline reaches a PR; it is left in place (path printed to stdout) whenever the pipeline halts on a blocker, a failed gate, or exhausted retries, so you can inspect or resume from it directly.

## Registries

Reference these registries when scoping or reviewing features:

- `registries/scope-checklist.md` — 7 questions (IN/OUT, entry points, edge cases, etc.)
- `registries/ship-checklist.md` — pre-MR approval checklist
- `registries/analytics-events.md` — analytics signal registry (project-specific, in `.ai/registry/`)
- `registries/paywall-touchpoints.md` — paywall surface registry (project-specific, in `.ai/registry/`)

## Configuration

The module reads project configuration from `.ai/config.json`. Run the `afp-setup` skill to generate it.

Key config fields: `sourceDirs`, `skipDirs`, `sourceExtensions`, `commands`, `stack`, `e2e`.

## Version

Current: 1.0.0
