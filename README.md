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
| [afp-setup](skills/afp-setup/SKILL.md) | Auto-detects your stack, generates `.ai/config.json` and `.ai/agents.json`, copies governance files and registries into `.ai/` | First-time install in a project |
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
    │   ├── agent-runner.test.ts     # Unit tests (schema, permissions, dry-run writes)
    │   ├── rebuild-context.mjs      # Repo memory builder (AST + incremental cache)
    │   ├── rebuild-context.test.mjs # Unit tests
    │   └── run-pipeline.sh          # Full pipeline runner
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
        └── scripts/
            └── new-feature.sh  # Copied to .ai/scripts/new-feature.sh
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

Full list in `skills/afp-setup/assets/module.yaml`.

### Models

Each role in `.ai/agents.json` picks its own model, called through any OpenAI-compatible chat-completions API — OpenRouter by default, but also OpenAI, Azure OpenAI, Groq, Together, Fireworks, or a local Ollama, by pointing `llm.baseUrl` in `.ai/config.json` elsewhere. Use a cheaper/faster model for bounded tasks like `memory-compact`, stronger for `architect`/`dev`/`review`. Requires the `OPENROUTER_API_KEY` env var (or the key name configured at `llm.apiKeyEnv` in `.ai/config.json`). Override any single role's model at runtime without touching `agents.json`, e.g.:

```bash
OPENROUTER_MODEL_DEV=anthropic/claude-opus-4.6 bash skills/afp-pipeline/scripts/run-pipeline.sh my-feature
```

The env var name is `OPENROUTER_MODEL_<ROLE>` with the role's hyphens replaced by underscores (`dev-review` → `OPENROUTER_MODEL_DEV_REVIEW`).

### Customizing the Dev agent per file type or language

The `dev` role in `.ai/agents.json` supports `typeSkills` (inject a coding-standards file only when Dev touches a matching file path or extension — `*.ts` vs `*.tsx` vs `*.js`, or a directory like `src/services`) and `extraSkills` (inject a file on every Dev run, regardless of what's touched). No other role supports this — only Dev writes source code. See **Dev-only: `typeSkills` and `extraSkills`** in `skills/afp-setup/SKILL.md` for the exact config shape and matching rules.

### Repo memory (`.ai/context.json`)

Before the Architect runs, `rebuild-context.mjs` scans `sourceDirs` and rebuilds `.ai/context.json` — a symbol index, per-file exports/imports, and a dependency map the Architect (and, indirectly, Dev) uses instead of re-discovering the codebase from scratch on every feature. When the target project has `typescript` installed, extraction goes through the real TypeScript compiler API (handles `export * from`, renamed re-exports, enums — things regex parsing misses); it falls back to regex extraction for plain-JS projects. Each file is fingerprinted by mtime, so unchanged files are never reparsed — only files that actually changed since the last run cost anything.

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
- **Hook-respecting commits** — the pipeline never uses `git commit --no-verify`. A real pre-commit hook rejection stops the run instead of being silently bypassed.
- **Concurrency lock** — a best-effort `mkdir`-based lock per slug under `.afp-worktrees/.locks/` prevents two invocations (an accidental double-trigger, a misconfigured cron/CI) from racing on the same worktree/branch. A lock held by a dead PID is detected and reclaimed automatically; a lock held by a live process blocks the second run with a clear message.
- **Token budget circuit breaker** — a retry loop stacking across several stages (typecheck, lint, Review) has no inherent ceiling on real LLM spend. `project.maxTokensPerFeature`, if set, tracks cumulative real usage per feature (`.agent-token-usage.json`) and refuses to make further calls once exceeded, rather than retrying indefinitely at your expense.

---

## Why AFP?

AI coding agents default to the shortest path from prompt to diff — which usually means no scoping, no design review, no QA, and no memory of what was tried before. AI Feature Pipeline forces the same discipline a human team applies before merging: a written brief, a reviewed technical plan with a diagram, a code review against that plan, a QA verdict, and a retro that feeds back into the next feature. Every gate exists because skipping it is exactly where an unsupervised agent goes wrong.

---

## Development

This repo itself has dev-only tooling (`package.json`, `test/`, not published, not installed by consumers) to unit-test the pipeline's scripts:

```bash
npm install
npm test
```

Tests cover `agent-runner.ts` (schema shape, per-role write permissions, dry-run write behavior) and `rebuild-context.mjs` (AST vs regex export/import extraction, incremental cache hit/miss/deletion). `.github/workflows/test.yml` runs `npm test` on every push and PR to `main`, so a change that breaks a test — or an untested behavior change that should have updated one — is caught before merge rather than relying on someone remembering to run it locally.

## Versioning

This module follows semver. Changelog is maintained in GitHub Releases.

## License

MIT
