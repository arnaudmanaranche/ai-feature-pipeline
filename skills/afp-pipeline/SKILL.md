# AFP Pipeline — Feature Development Pipeline

A structured multi-agent pipeline for AI-assisted feature development.
PM → Architect → Dev → Review → QA.

**Model-agnostic, stack-agnostic.** Works with any AI coding tool (Claude Code, Codex, OpenCode, Cline).

## Capabilities

| Command | Description |
|---------|-------------|
| `new <description>` | Start a new feature. Scopes the feature, generates feature-brief.md |
| `run --role <role> --slug <slug>` | Run a single agent role (pm, architect, dev, review, qa) |
| `pipeline --slug <slug>` | Run the full pipeline for a feature, end-to-end |

## Workflow stages

Each stage produces an artifact in `.ai/artifacts/features/<slug>/`.

### 1. PM — Product Manager
**Prompt:** `prompts/pm.md`
**Output:** `feature-brief.md` — requirements, acceptance criteria, i18n, analytics, paywall, scope

### 2. Architect — Software Architect
**Prompt:** `prompts/architect.md`
**Output:** `technical-plan.md` + `repository-context.md` — architecture, impacted files, risks, implementation order

### 3. Dev — Developer
**Prompt:** `prompts/dev.md`
**Output:** Code changes + `dev-log.md` — implements the feature per the tech plan

### 4. Review — Code Reviewer
**Prompt:** `prompts/review.md`
**Output:** `review-report.md` — checks implementation against the brief

### 5. QA — Quality Assurance
**Prompt:** `prompts/qa.md`
**Output:** `qa-report.md` — validates E2E flows

## Automation

Each stage can be executed via the agent-runner CLI:

```bash
node scripts/agent-runner.ts --role=<role> --slug=<slug> --project-root=<path>
```

Or run the full pipeline:

```bash
bash scripts/run-pipeline.sh <slug> [--project-root=<path>]
```

## Registries

Reference these registries when scoping or reviewing features:

- `registries/scope-checklist.md` — 7 questions (IN/OUT, entry points, edge cases, etc.)
- `registries/ship-checklist.md` — pre-MR approval checklist
- `registries/analytics-events.md` — analytics signal registry (project-specific, in `.ai/registry/`)
- `registries/paywall-touchpoints.md` — paywall surface registry (project-specific, in `.ai/registry/`)

## Configuration

The module reads project configuration from `.ai/config.json`. Run the `afp-setup` skill to generate it.

## Version

Current: 1.0.0
