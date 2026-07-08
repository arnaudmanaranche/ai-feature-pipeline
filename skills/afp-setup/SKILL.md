# AFP Setup — Feature Pipeline Setup

First-time project configuration for the AI Feature Pipeline module.

Run this skill when you first install the module in a project. It auto-detects the project stack, then prompts for confirmation and any missing values.

## What it does

1. **Auto-detects the stack** by running `scripts/detect-stack.mjs` in the project root
2. Presents detected values to the user for confirmation or correction
3. Prompts only for values that could not be detected
4. Generates `.ai/config.json` with all project settings
5. Generates `.ai/agents.json` with role definitions (see **Required roles** below — `agent-runner.ts` hardcodes behavior per role name, so every one of these must have an entry or that role's pipeline stage will fail with "Unknown role")
6. Creates `.ai/artifacts/features/` directory
7. Copies registry files (scope-checklist, ship-checklist, analytics-events, paywall-touchpoints) into `.ai/registry/`
8. Copies governance files (GOVERNANCE.md, DENIED_ACTIONS.md) from `skills/afp-pipeline/templates/` into `.ai/`
9. Copies `skills/afp-pipeline/templates/scripts/new-feature.sh` into `.ai/scripts/new-feature.sh` and makes it executable (`chmod +x`) — `run-pipeline.sh` depends on this script to scaffold new feature folders
10. Copies `skills/afp-pipeline/templates/ai-gitignore` into `.ai/.gitignore` — keeps derived (`context.json`) and per-run debug files (`.agent-*` dumps) out of git history so the repo doesn't grow unbounded, while keeping durable knowledge (briefs, plans, reviews, retros, `project-memory.md`, the memory-compact counter, the `.architect-approved` hash) tracked. **Do not overwrite an existing `.ai/.gitignore` that has project-specific additions — merge instead.**
11. Copies `skills/afp-pipeline/templates/scripts/prune-artifacts.sh` into `.ai/scripts/prune-artifacts.sh` and makes it executable (`chmod +x`) — a human-run maintenance tool for repo hygiene (see **Repo hygiene** below)

## Auto-detection

Before asking any questions, run:

```bash
node skills/afp-setup/scripts/detect-stack.mjs --project-root=<project-root>
```

This scans the project and returns a JSON object with pre-filled values for all config fields. Use these as the defaults for every prompt — show the detected value to the user so they can confirm or override it.

### What gets detected automatically

| Field | How it's detected |
|-------|-------------------|
| `project_name` | `package.json` → `name`, falls back to directory name |
| `app_id` | `app.json` (Expo), `capacitor.config.json`, or derived from package name |
| `github_repo` | `.git/config` remote URL |
| `package_manager` | Presence of `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock` |
| `typecheck_cmd` | `package.json` → `scripts` (looks for `typecheck`, `type-check`, etc.) |
| `lint_cmd` | `package.json` → `scripts`, or detected formatter (biome, eslint) |
| `format_cmd` | `package.json` → `scripts`, or detected formatter (biome, prettier) |
| `default_branch` | `.git/HEAD` |
| `locales` | Scans common i18n dirs (`i18n/locales`, `locales`, `src/locales`, etc.) |
| `locale_dir` | Same scan |
| `analytics_provider` | `package.json` deps (posthog, segment, mixpanel, amplitude, etc.) |
| `paywall_provider` | `package.json` deps (revenuecat, stripe, expo-iap, etc.) |
| `backend_service` | `package.json` deps (supabase, firebase, prisma, drizzle, etc.) |
| `error_tracking` | `package.json` deps (sentry, bugsnag, datadog, etc.) |
| `e2e_framework` | Config files (`playwright.config.ts`, `cypress.config.ts`, `.detoxrc.js`, etc.) |
| `e2e_dir` | Framework-specific directory (`e2e/maestro`, `cypress/e2e`, etc.) |
| `router` | `package.json` deps (expo-router, react-navigation, next, tanstack-router, etc.) |
| `styling` | `package.json` deps (nativewind, tailwind, styled-components, emotion, etc.) |
| `source_dirs` | Directory presence (`src`, `app`, `pages`) and framework |
| `skip_dirs` | Framework-aware (adds `ios`, `android`, `.expo` for React Native; `.next` for Next.js) |
| `source_extensions` | TypeScript presence, Vue, Svelte |

### Prompt format

Show detected values clearly before asking for confirmation:

```
Detected stack:
  • Package manager : pnpm  ✓
  • Analytics       : posthog  ✓
  • Backend         : supabase  ✓
  • E2E framework   : maestro (e2e/maestro)  ✓
  • Locales         : en, fr  ✓

Press Enter to confirm each value, or type a new one.
```

For fields where nothing was detected (empty string), explain what the field is for and ask the user to fill it in.

## Required roles

`.ai/agents.json` must contain a `roles` object with exactly these keys — `agent-runner.ts` looks up role behavior (permissions, output schema, task instructions) by these exact names:

`pm`, `dev-review`, `pm-respond`, `architect`, `dev`, `review`, `qa`, `retro`, `memory-compact`

Each role entry needs: `skill` (path to its prompt file under `skills/afp-pipeline/prompts/`, e.g. `skills/afp-pipeline/prompts/pm.md` — `memory-compact` uses `skills/afp-pipeline/prompts/memory-compact.md`), `model`, `artifact` (primary output filename), `description`, and `maxTokens`. Use a smaller/cheaper model for `memory-compact` — it does bounded text reorganization, not novel reasoning.

### Dev-only: `typeSkills` and `extraSkills`

The `dev` role entry additionally supports two optional fields for injecting file-type- or language-specific coding standards into the Dev agent's context. Neither exists for any other role — only Dev writes source code.

```json
{
  "roles": {
    "dev": {
      "skill": "skills/afp-pipeline/prompts/dev.md",
      "model": "anthropic/claude-sonnet-4.5",
      "artifact": "dev-log.md",
      "description": "Developer",
      "maxTokens": 8000,
      "typeSkills": {
        "*.ts": ".ai/skills/typescript-standards.md",
        "*.tsx": ".ai/skills/react-standards.md",
        "*.js": ".ai/skills/javascript-legacy-standards.md",
        "src/services": ".ai/skills/service-conventions.md"
      },
      "extraSkills": [".ai/skills/security-baseline.md"]
    }
  }
}
```

- **`typeSkills`** (`Record<pattern, skillFilePath>`) — matched per-file against the file paths the Architect's `technical-plan.md` says Dev needs to touch (`agent-runner.ts`'s `getMatchingTypeSkills`, covered by `agent-runner.test.ts`). A pattern starting with `*` matches by **suffix** (`*.ts` matches any `.ts` file, `*.test.ts` matches only test files); any other pattern matches by **path prefix or path segment** (`src/services` matches `src/services/api.ts` and `lib/src/services/x.ts`). Only skills whose pattern matches at least one impacted file get injected — this keeps the prompt from ballooning with irrelevant standards on a feature that never touches, say, `src/services`.
- **`extraSkills`** (`string[]`) — injected into every single Dev run regardless of which files are touched. Use this for cross-cutting rules (security baseline, error-handling conventions) rather than `typeSkills`, which is deliberately conditional.
- The skill files themselves (`.ai/skills/*.md` in the example above — the path is arbitrary, just needs to exist and be readable from the project root) are plain markdown you write yourself. There's no required structure; they're read verbatim and appended to Dev's system prompt under a `## <filename> (cross-cutting)` or matched-skill heading.
- `typeSkills`/`extraSkills` paths are resolved from the project root, not from `skills/afp-pipeline/`, since they're project-specific standards, not part of the module.

## Configuration variables

See `assets/module.yaml` for the full list of configurable values and their defaults.

## Repo hygiene

The pipeline writes two kinds of files: **durable knowledge** worth keeping in git (feature briefs, technical plans, reviews, retrospectives, `project-memory.md`, the memory-compact counter, the `.architect-approved` design-approval hash) and **derived/ephemeral** files that should not accumulate in history (`context.json`, rebuilt from source every run; and per-run `.agent-*` debug dumps — raw LLM `submit_changes` payloads that can be hundreds of KB each). The `.ai/.gitignore` installed in step 10 keeps the second kind out of git.

**Existing installs (the module was already in use before `.ai/.gitignore` existed):** those debug files are already tracked, so the new ignore rules alone won't drop them. Run the one-time migration to untrack them (your working copy is untouched):

```bash
.ai/scripts/prune-artifacts.sh --untrack        # add --dry-run first to preview
git commit -m "chore(afp): untrack pipeline debug files"
```

**Ongoing:** to reclaim space from feature folders you no longer need live, archive them into `.ai/archive/<slug>.tar.gz` (nothing in the pipeline reads a past feature's folder, so this is lossless for the workflow):

```bash
.ai/scripts/prune-artifacts.sh --archive <slug>            # or
.ai/scripts/prune-artifacts.sh --archive-older-than 90     # folders untouched for 90+ days
```

## Notes

- `.ai/GOVERNANCE.md` and `.ai/DENIED_ACTIONS.md` are injected into every agent's context. Edit them to add project-specific rules.
- Re-running this skill will overwrite `.ai/config.json` — back it up first if you have customisations.
- The detection script only reads files — it never modifies the project.
