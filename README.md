# AI Feature Pipeline

**A structured, multi-agent pipeline for AI-assisted feature development. Model-agnostic, stack-agnostic.**

Each role produces artifacts, gates, and handoffs — so shipping a feature with an AI agent looks like shipping one with a team, not a single unreviewed diff.

```
  SCOPE           CLARIFY         DESIGN          BUILD           REVIEW          VERIFY          LEARN
 ┌──────┐      ┌──────────┐    ┌──────────┐    ┌──────┐       ┌────────┐     ┌──────┐        ┌───────┐
 │  PM  │ ───▶ │Dev Review│ ─▶ │Architect │ ─▶ │  Dev │ ────▶ │ Review │ ──▶ │  QA  │ ─────▶ │ Retro │
 │Brief │      │   Q&A    │    │   Plan   │    │ Code │       │ Verdict│     │Verify│        │Memory │
 └──────┘      └──────────┘    └──────────┘    └──────┘       └────────┘     └──────┘        └───────┘
```

---

## Quick start

**Prerequisites:** Node.js 18+, an AI coding tool (Claude Code, Codex, OpenCode, Cline), and a BMad Method installation (`npx bmad-method`).

```bash
npx bmad-method install --custom-source https://github.com/arnaudmanaranche/ai-feature-pipeline
```

<details>
<summary><b>Claude Code</b></summary>

```bash
/start afp-setup
```

Or interactively: "Run the AFP Setup skill."

</details>

<details>
<summary><b>Codex / OpenCode / Cline / other agents</b></summary>

Skills are plain Markdown with accompanying scripts — any agent that can read a `SKILL.md` and run shell commands can drive the pipeline. Point your agent at `skills/afp-setup/SKILL.md` first, then `skills/afp-pipeline/SKILL.md`.

</details>

Once set up, start a feature:

```bash
/start afp-pipeline new "Add dark mode toggle"
```

Or interactively: "Run the AFP Pipeline to scope a new feature."

---

## Modules

| Module | What it does | Use when |
|--------|--------------|----------|
| [afp-setup](skills/afp-setup/SKILL.md) | Auto-detects your stack, generates `.ai/config.json` and `.ai/agents.json`, copies governance files, registries, and a `.ai/.gitignore` into `.ai/` | First-time install in a project |
| [afp-pipeline](skills/afp-pipeline/SKILL.md) | Runs the 7-role feature workflow end to end inside an isolated git worktree, from brief to PR | Every feature, from `new "<description>"` |

---

## Pipeline stages

| Stage | Role | Produces | Gate |
|-------|------|----------|------|
| 1 | PM | `feature-brief.md` — requirements, AC, scope | |
| 2 | Dev Review | `pm-dev-thread.md` — clarification Q&A (loops up to 3×) | exits on `blocked` |
| 3 | Architect | `technical-plan.md` (with a mandatory Mermaid diagram) + `repository-context.md` | **Diagram gate** — missing ` ```mermaid ` block triggers 1 automatic retry, then aborts. **Design gate** — pipeline then pauses (exit 0) until a human reviews the plan and re-runs with `--approve-design`. A resumed run reuses the reviewed plan verbatim (no regeneration) and binds the approval to the plan's content hash — a changed plan forces re-approval |
| 4 | Dev | Code changes + `dev-log.md` | typecheck gate, 1 retry |
| 5 | Review | `review-report.md` — verdict PASS / PASS_WITH_NOTES / FAIL, checks the diff against the Architect's diagram | FAIL feeds findings back to Dev, 1 retry; halts before QA and PR if still FAIL |
| 6 | QA | `qa-report.md` — verdict PASS / FAIL / BLOCKED_ENV | FAIL skips PR creation |
| 7 | Retro | `retrospective.md` + `.ai/project-memory.md`, plus a skill proposal at `.ai/artifacts/skill-proposals/<name>.md` if a pattern has recurred 3+ times | |
| — | Memory Compact | rewrites `.ai/project-memory.md` | Runs every `project.memoryCompactEvery` shipped features (default 10), not per-feature |

`.ai/project-memory.md` is read by **every** role, not just PM/Architect/Retro, and is organized into four fixed categories (Pitfalls, Conventions confirmed, Architecture decisions, Integration notes) instead of growing one section per feature forever. The Memory Compact role periodically deduplicates and prunes it — note that both this counter and the memory file itself live on feature branches, so they only accumulate correctly across features whose PRs get merged in between runs.

Every run (including `--dry-run`) executes inside a dedicated git worktree under `../.afp-worktrees/`, isolated from your working checkout. The worktree is removed automatically once the pipeline reaches a PR (or a dry-run rehearsal completes); it's preserved for inspection whenever the pipeline halts on a blocker, a failed gate, or exhausted retries.

A fresh worktree has no `node_modules` and none of the generated hook glue some tools regenerate on install (e.g. husky's `.husky/_/husky.sh`). The pipeline runs `commands.install` (default: `<packageManager> install`) once per worktree, before any agent, and skips it on a resumed run that already has `node_modules`. Agent commits use `chore(<role>): <slug>` rather than `agent(<role>): <slug>` specifically so they pass a standard conventional-commits `commitlint` type-enum out of the box.

---

## How a role works

Every role in `.ai/agents.json` shares the same anatomy:

```
┌───────────────────────────────────────────────────┐
│  <role>.md prompt                                  │
│                                                    │
│  Governance     → .ai/GOVERNANCE.md, DENIED_ACTIONS.md (injected)
│  Input          → prior role's artifacts + project-memory.md
│  Output         → forced tool call `submit_changes`, │
│                    validated against a per-role      │
│                    JSON Schema ({files, artifacts,   │
│                    verdict})                         │
│  Permissions    → write access enforced in           │
│                    agent-runner.ts, independent of    │
│                    what the prompt says               │
│  Gate           → typecheck / diagram / verdict check │
│                    decides retry, halt, or handoff    │
└───────────────────────────────────────────────────┘
```

**Key design choices:**

- **Structured output, not parsed prose.** A model that phrases its response slightly differently still produces a schema-valid object — there's no silent "0 files parsed" failure from formatting drift.
- **Per-role write permissions enforced in code, not in the prompt.** PM/Architect/Review/QA/Retro cannot write source files at all; only Dev can, and only to configured extensions.
- **Gates decide control flow, not the model.** Retry, halt, and handoff are deterministic checks in `run-pipeline.sh`, not something the agent decides for itself.

## Project structure

```
skills/
├── afp-setup/                  # First-time project configuration
│   ├── SKILL.md
│   ├── assets/
│   │   └── module.yaml         # Config variables
│   └── scripts/
│       └── detect-stack.mjs    # Auto-detects project stack
│
└── afp-pipeline/               # Main pipeline workflow
    ├── SKILL.md                # Workflow definition
    ├── prompts/                # Role-specific system prompts
    │   ├── pm.md
    │   ├── dev-review.md
    │   ├── architect.md
    │   ├── dev.md
    │   ├── review.md
    │   ├── qa.md
    │   ├── retro.md
    │   └── memory-compact.md
    ├── scripts/                # Automation
    │   ├── agent-runner.ts          # LLM-agnostic agent executor
    │   ├── rebuild-context.mjs      # Repo memory builder (AST + incremental cache)
    │   ├── eval-pipeline.mjs        # Output-quality eval harness (structural + optional LLM judge)
    │   └── run-pipeline.sh          # Full pipeline runner
    ├── eval/                   # Evaluation harness data
    │   ├── cases/                   # Golden rubric cases (*.json)
    │   └── fixtures/                # Checked-in artifact sets the cases score against
    ├── registries/             # Registries
    │   ├── scope-checklist.md
    │   ├── ship-checklist.md
    │   ├── analytics-events.md
    │   └── paywall-touchpoints.md
    └── templates/              # Injected into .ai/ by afp-setup
        ├── GOVERNANCE.md
        ├── DENIED_ACTIONS.md
        ├── technical-plan.md
        ├── repository-context.md
        ├── ai-gitignore        # Copied to .ai/.gitignore (repo hygiene)
        └── scripts/
            ├── new-feature.sh       # Copied to .ai/scripts/new-feature.sh
            └── prune-artifacts.sh   # Copied to .ai/scripts/ (untrack/archive maintenance)
```

---

## Configuration

Generated by `afp-setup` into `.ai/config.json`:

| Variable | Description | Default |
|----------|-------------|---------|
| `project.name` | Project display name | `My Project` |
| `commands.packageManager` | Package manager | `npm` |
| `commands.typecheck` | Typecheck command — Dev quality gate, 1 retry | `tsc --noEmit` |
| `commands.lint` | Lint command — Dev quality gate, 1 retry | `eslint .` |
| `commands.test` | Project test suite — Dev quality gate, 1 retry. Opt-in: blank skips it entirely | `""` |
| `stack.router` | Router library | `react-router` |
| `stack.analytics.provider` | Analytics provider | `""` |
| `stack.paywall.provider` | Paywall provider | `""` |
| `e2e.framework` | E2E framework | `""` |
| `project.maxTokensPerFeature` | Circuit breaker on cumulative real LLM token spend per feature. `0`/unset = unlimited | `0` |
| `review.verifiers` | Number of independent Review passes (adversarial panel). `1` = single reviewer; `>1` runs that many passes with distinct lenses and takes a majority vote | `1` |

Full list in `skills/afp-setup/assets/module.yaml`.

### Models

Each role in `.ai/agents.json` picks its own model, called through any OpenAI-compatible chat-completions API — OpenRouter by default, but also OpenAI, Azure OpenAI, Groq, Together, Fireworks, or a local Ollama, by pointing `llm.baseUrl` in `.ai/config.json` elsewhere. Use a cheaper/faster model for bounded tasks like `memory-compact`, stronger for `architect`/`dev`/`review`. Requires the `OPENROUTER_API_KEY` env var (or the key name configured at `llm.apiKeyEnv` in `.ai/config.json`). Override any single role's model at runtime without touching `agents.json`, e.g.:

```bash
OPENROUTER_MODEL_DEV=anthropic/claude-opus-4.6 bash skills/afp-pipeline/scripts/run-pipeline.sh my-feature
```

The env var name is `OPENROUTER_MODEL_<ROLE>` with the role's hyphens replaced by underscores (`dev-review` → `OPENROUTER_MODEL_DEV_REVIEW`). The same convention applies to `AFP_SKILL_<ROLE>`, which points a role at an alternate prompt file for A/B experiments (see **Self-improvement loop** below) — e.g. `AFP_SKILL_PM=.ai/experiments/pm-v2.md`.

### Customizing the Dev agent per file type or language

The `dev` role in `.ai/agents.json` supports `typeSkills` (inject a coding-standards file only when Dev touches a matching file path or extension — `*.ts` vs `*.tsx` vs `*.js`, or a directory like `src/services`) and `extraSkills` (inject a file on every Dev run, regardless of what's touched). No other role supports this — only Dev writes source code. See **Dev-only: `typeSkills` and `extraSkills`** in `skills/afp-setup/SKILL.md` for the exact config shape and matching rules.

### Adversarial Review panel (`review.verifiers`)

A single Review call is the pipeline's weakest gate: nothing contradicts a plausible-but-wrong PASS. Set `review.verifiers` to `N > 1` in `.ai/config.json` and stage 5 runs `N` **independent** Review passes, each given a distinct lens (correctness & acceptance-criteria coverage → diff-vs-Architect's-diagram → edge cases / error handling / security, cycling if `N > 3`), each prompted to be adversarial and actively look for a blocking defect. The panel decides by **majority**: the verdict is `FAIL` when at least `ceil(N/2)` verifiers fail — so one flaky `FAIL` can't block a good change, and one shallow `PASS` can't wave a real defect through. The aggregated `review-report.md` records every verifier's verdict, lens, and the final panel decision. `N = 1` is exactly the original single-reviewer behavior. Each pass is a real LLM call, so this trades cost for confidence — reserve it for higher-stakes projects.

### Repo memory (`.ai/context.json`)

Before the Architect runs, `rebuild-context.mjs` scans `sourceDirs` and rebuilds `.ai/context.json` — a symbol index, per-file exports/imports, and a dependency map the Architect (and, indirectly, Dev) uses instead of re-discovering the codebase from scratch on every feature. When the target project has `typescript` installed, extraction goes through the real TypeScript compiler API (handles `export * from`, renamed re-exports, enums — things regex parsing misses); it falls back to regex extraction for plain-JS projects. Each file is fingerprinted by mtime, so unchanged files are never reparsed — only files that actually changed since the last run cost anything. Because it's fully derived from source, `.ai/context.json` is git-ignored (see **Repo hygiene** below) — it's regenerated on demand, never versioned.

### Repo hygiene & file growth

The pipeline writes two kinds of file, and only one belongs in git long-term:

- **Durable knowledge** (kept): feature briefs, technical plans, reviews, QA reports, retrospectives, `project-memory.md`, the memory-compact counter, and the `.architect-approved` design-approval hash. This is the paper trail and the cross-session memory.
- **Derived / per-run debug** (ignored): `context.json` (rebuilt every run) and the per-feature `.agent-*` files — raw `submit_changes` payloads (full file contents, often hundreds of KB), status flags, manifests, token accounting, and retry feedback. These are needed only during the run that writes them.

`afp-setup` installs a `.ai/.gitignore` covering the second kind, so a project that ships hundreds of features doesn't accumulate LLM dumps and a regenerable index in its history. `project-memory.md` itself stays bounded by design (four fixed categories + periodic `memory-compact` deduplication), not by growing one section per feature.

Two maintenance commands (`.ai/scripts/prune-artifacts.sh`, human-run, `--dry-run` to preview):

- `--untrack` — one-time migration for a repo that committed those debug files before the `.gitignore` existed; stops tracking them without touching your working copy.
- `--archive <slug>` / `--archive-older-than <days>` — packs shipped feature folders you no longer need live into `.ai/archive/<slug>.tar.gz`. Nothing in the pipeline reads a past feature's folder (Retro reads only the current one; cross-feature knowledge flows through `project-memory.md`), so archiving is lossless for the workflow.

### E2E verification (QA) is framework-agnostic by contract, not by running anything itself

Which E2E tool a project uses — Maestro, Playwright, Cypress, Detox, WebdriverIO, or none — is a per-project choice (`e2e.framework` / `e2e.dir` in `.ai/config.json`, set by `afp-setup`). This module deliberately does **not** run any of them: orchestrating a simulator or browser in CI is inherently framework- and infra-specific, and hardcoding one would break the "stack-agnostic" premise for everyone not using that one framework.

Instead, QA reads a single generic handoff file: `.ai/artifacts/features/<slug>/e2e-results.json`. **Your project's own CI is responsible for producing it** — run your configured E2E suite in whatever job already exists for that framework, then write the results in this shape before QA runs:

```json
{
  "framework": "playwright",
  "flows": [
    { "file": "e2e/login.spec.ts", "result": "pass" },
    { "file": "e2e/checkout.spec.ts", "result": "fail", "notes": "timeout waiting for #confirm-button" }
  ]
}
```

If this file is absent, QA is instructed to use `BLOCKED_ENV` rather than fabricate a result — unless the feature genuinely has no E2E requirements, in which case it may still PASS on brief review alone. If `e2e.framework` isn't configured at all, QA is told exactly that and falls back to the same brief-only judgment.

### Safety model

- **Governance & denied actions** — `.ai/GOVERNANCE.md` and `.ai/DENIED_ACTIONS.md` (copied from `templates/` by `afp-setup`, editable per project) are injected into every single agent's prompt. They state role boundaries (e.g. only Dev writes source code), output rules (no placeholders, complete file contents only), and hard denials (no secrets, no direct pushes to the default branch, no disabling lint/typecheck inline without justification).
- **Structured output** — every agent's response is a single forced tool call (`submit_changes`) validated against a per-role JSON Schema, not free-form text parsed out of markdown. A model that phrases its output slightly differently still produces a schema-valid `{files, artifacts, verdict}` object — there's no silent "0 files parsed" failure mode from a formatting drift.
- **Per-role write permissions** — enforced in `agent-runner.ts` independently of what the prompt says: PM/Architect/Review/QA/Retro cannot write source files at all (regex-checked against every path in the model's own output, before anything is written to disk); only `dev` can, and only to configured extensions; only `retro` and `memory-compact` can touch `.ai/project-memory.md`. A permission violation aborts the write entirely rather than partially applying it.
- **Path containment** — every file/artifact path in a model's structured output is untrusted input. `join(root, path)` alone does not stop a `../`-containing path from resolving outside the project — a real containment check (resolved-path prefix comparison) runs before any read or write, independent of the per-role extension/pattern regexes (which only check the string, not the resolved location).
- **Content gates (no placeholders, no secrets)** — `GOVERNANCE.md` forbids placeholders and committed secrets, but those were previously prompt-only rules a drifting model could ignore. After each Dev pass, deterministic scans run over Dev's own changed source files: placeholder/truncation markers (`// ...`, `// TODO`, `rest stays the same`, `TBD`, …) and secret signatures (private keys, `AKIA…`, `sk-…`, `ghp_…`, `xox…`, assigned credential literals). A hit feeds the same one-retry Dev loop as typecheck/lint, then aborts if still present — dependency-free, scoped to Dev output so it never flags pre-existing repo code.
- **Provenance trailers** — each stage's commit carries `AFP-Model` and `AFP-Prompt-SHA` trailers recording which model and which prompt version (a content hash of the role's skill prompt) produced that output. `git log` becomes an audit trail: for any artifact or diff you can trace the exact model and prompt behind it, and a prompt edit shows up as a changed hash on subsequent runs. Trailers live in the commit body, so the conventional-commit header still passes `commitlint`.
- **Hook-respecting commits** — the pipeline never uses `git commit --no-verify`. A real pre-commit hook rejection stops the run instead of being silently bypassed.
- **Concurrency lock** — a best-effort `mkdir`-based lock per slug under `.afp-worktrees/.locks/` prevents two invocations (an accidental double-trigger, a misconfigured cron/CI) from racing on the same worktree/branch. A lock held by a dead PID is detected and reclaimed automatically; a lock held by a live process blocks the second run with a clear message.
- **Token budget circuit breaker** — a retry loop stacking across several stages (typecheck, lint, Review) has no inherent ceiling on real LLM spend. `project.maxTokensPerFeature`, if set, tracks cumulative real usage per feature (`.agent-token-usage.json`) and refuses to make further calls once exceeded, rather than retrying indefinitely at your expense.

---

## Why AFP?

AI coding agents default to the shortest path from prompt to diff — which usually means no scoping, no design review, no QA, and no memory of what was tried before. AI Feature Pipeline forces the same discipline a human team applies before merging: a written brief, a reviewed technical plan with a diagram, a code review against that plan, a QA verdict, and a retro that feeds back into the next feature. Every gate exists because skipping it is exactly where an unsupervised agent goes wrong.

---

## Evaluation

Unit tests prove the *scripts* are correct; they say nothing about whether the pipeline produces *good features*. The eval harness (`skills/afp-pipeline/scripts/eval-pipeline.mjs`) closes that gap by scoring produced artifacts against a rubric, so a prompt edit that quietly degrades output quality surfaces as a regression instead of reaching production.

```bash
npm run eval                              # score all golden cases (structural, offline, free)
npm run eval -- --llm-judge               # additionally run the LLM-as-judge pass
node .../eval-pipeline.mjs --case=settings-toggle --dir=.ai/artifacts/features/<slug>  # score a real run
```

Two layers, both dependency-free:

- **Structural scoring** (default) — deterministic checks over each artifact: required sections present, mandatory Mermaid diagram present, no placeholders/`TBD`, a verdict recorded, etc. Each case (`eval/cases/*.json`) sets a `threshold`; the run exits non-zero if any case scores below it.
- **LLM-as-judge** (`--llm-judge`, opt-in) — sends the artifacts to the model configured in `.ai/config.json` for a 1–5 rubric score. Skipped gracefully when no config/API key is present, so it never blocks the free structural pass.

Golden cases point at checked-in fixture artifacts, so `npm run eval` is a self-contained regression run that also executes in CI.

### Self-improvement loop (prompt A/B, provenance-keyed)

The eval harness plus provenance trailers close a measurable loop for improving the pipeline's own prompts — without an autonomous agent silently rewriting itself. The deployment step stays human-gated; what's automated is the *measurement*.

1. **Vary a prompt** without touching `agents.json`: point a role at an alternate prompt file via `AFP_SKILL_<ROLE>` (hyphens → underscores). The prompt hash recorded in provenance is computed from whatever file actually ran, so the experiment is auditable.
   ```bash
   AFP_SKILL_PM=.ai/experiments/pm-v2.md bash skills/afp-pipeline/scripts/run-pipeline.sh my-feature
   ```
2. **A/B the output** of the baseline run against the candidate run, scored by the same rubric. A candidate "regresses" if its overall score drops **or** any previously-passing check now fails (so a change that fixes one thing while quietly breaking another is still caught). Exit code is non-zero on regression, and each side reports its prompt provenance (`role@<sha>`):
   ```bash
   node .../eval-pipeline.mjs --case=settings-toggle \
     --dir=.ai/artifacts/features/baseline-run \
     --compare=.ai/artifacts/features/candidate-run
   # candidate 88%  [architect@bbb222]  ▼ -13pt
   #   - regressed:  technical-plan.md:contains:```mermaid
   ```
3. **Track score over time** per prompt version with an append-only history log:
   ```bash
   node .../eval-pipeline.mjs --case=settings-toggle --dir=<run> --record=eval-history.jsonl --label="pm-v2"
   ```

Keep the winning prompt (promote the variant file into `agents.json`) or discard it — the decision is yours, but it's now backed by a number and traceable to an exact prompt hash. The natural next rung — automatically *generating* candidate prompts and selecting by eval (DSPy-style) — fits the same loop, and would still land behind the same human gate before any prompt ships.

## Development

This repo itself has dev-only tooling (`package.json`, `test/`, not published, not installed by consumers) to unit-test the pipeline's scripts:

```bash
npm install
npm test
```

Tests cover `agent-runner.ts` (schema shape, per-role write permissions, dry-run write behavior), `rebuild-context.mjs` (AST vs regex export/import extraction, incremental cache hit/miss/deletion), and `eval-pipeline.mjs` (rubric scoring passes a good artifact set and fails a degraded one, A/B comparison flags a regression even when the net score is unchanged, plus every shipped golden case actually meets its threshold). `.github/workflows/test.yml` runs `npm test` and `npm run eval` on every push and PR to `main`, so a change that breaks a test, degrades a golden case, or introduces an untested behavior change is caught before merge rather than relying on someone remembering to run it locally.

## Versioning

This module follows semver. Changelog is maintained in GitHub Releases.

## License

MIT
