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
**Output:** `technical-plan.md` + `repository-context.md` — architecture, impacted files, risks, implementation order

### 4. Dev — Developer
**Prompt:** `prompts/dev.md`
**Output:** Code changes + `dev-log.md` — implements the feature per the tech plan
**Gate:** Typecheck runs after Dev. One retry allowed with error feedback. Fails pipeline on second failure.

### 5. Review — Code Reviewer
**Prompt:** `prompts/review.md`
**Output:** `review-report.md` — checks implementation against the brief
**Gate:** FAIL verdict halts the pipeline before QA and PR creation.

### 6. QA — Quality Assurance
**Prompt:** `prompts/qa.md`
**Output:** `qa-report.md` — validates E2E flows using the project's configured framework
**Gate:** FAIL verdict pushes the branch but skips PR creation.

### 7. Retro — Retrospective
**Prompt:** `prompts/retro.md`
**Output:** `retrospective.md` + appends to `.ai/project-memory.md` — session learnings for future runs

## Automation

Each stage can be executed via the agent-runner CLI:

```bash
node scripts/agent-runner.ts --role=<role> --slug=<slug> --project-root=<path>
```

Or run the full pipeline:

```bash
bash scripts/run-pipeline.sh <slug> [issue-body.md] [--dry-run] [--project-root=<path>]
```

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
