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
12. Runs the target project's own `format_write_cmd` scoped to `skills/` and `.ai/`, and appends `skills/`/`.ai/` to every lint/format/typecheck exclude mechanism the target project has (see **Excluding module content from the target's tooling** below) — otherwise the module's own copied-in files can fail the target's pre-commit hooks or typecheck gate on the very first commit, for reasons that have nothing to do with the target project itself

## Auto-detection

Before asking any questions, run:

```bash
node skills/afp-setup/scripts/detect-stack.mjs --project-root=<project-root>
```

This scans the project and returns a JSON object with pre-filled values for all config fields. Use these as the defaults for every prompt — show the detected value to the user so they can confirm or override it.

### Second pass: read CI config for what the script can't verify

`detect-stack.mjs` only reads `package.json` — it's the deterministic, reproducible first pass, and stays that way. But `package.json` scripts are frequently aliases or partial; the commands a CI pipeline *actually* gates on are ground truth the script has no way to see, and some institutional knowledge (i18n managed by an external platform, which git host a repo lives on) isn't in `package.json` at all. This is judgment work, so it belongs to you (the skill), not the script.

After running `detect-stack.mjs` and before presenting any prompts, also read — if present — `.github/workflows/*.yml`, `.gitlab-ci.yml`, and `README.md`. Look for:

- **Real CI gate commands** — the actual `run:`/`script:` lines that invoke typecheck, lint, test, and format in CI. These are often more specific than the script's guess (e.g. `pnpm run lint:ci -- --max-warnings=0` vs. the script's generic `pnpm run lint`).
- **i18n tooling** — mentions of translation-management platforms (Loco, Lokalise, Phrase, Crowdin, etc.) in workflows or README, which mean locale files are generated/pulled rather than hand-edited locally — `detect-stack.mjs`'s `locales`/`locale_dir` guess from local files is misleading in that case.
- **Git host** — presence of `.gitlab-ci.yml` (or a `.git/config` remote pointing elsewhere) vs. `.github/workflows/`, to know whether this is a GitHub or GitLab project.

**When a CI-derived command conflicts with the script-detected one** (`typecheck_cmd`, `lint_cmd`, `test_cmd`, `format_cmd`, `format_write_cmd`): do not silently prefer either one. Show both explicitly and require the user to pick, rather than letting a bare Enter accept a default:

```
Lint command:
  • from package.json scripts : pnpm run lint
  • from .github/workflows/ci.yml : pnpm run lint:ci -- --max-warnings=0
Which one? [1/2/or type your own]
```

**When you find institutional knowledge that doesn't map to an existing config field** (e.g. "i18n is managed externally via Loco, not local locale files"): don't discard it and don't just mention it in the chat transcript — append it to `.ai/project-context.md` under a `## Setup notes` heading, creating the file if it doesn't exist yet (if it already exists, append rather than overwrite, same as the `.ai/.gitignore` merge rule above). This file is read by `agent-runner.ts` and injected into every role's system prompt, so a note recorded here is visible to pm, architect, dev, review, and every other agent for the life of the project — not just during setup.

**When the repository is hosted on GitLab, not GitHub:** warn the user during setup that `run-pipeline.sh`'s final stage (`gh pr create`/`gh pr edit`) is GitHub-only and will fail harmlessly (pipeline completes, no PR/MR gets opened) until GitLab support is added. Don't change any config value for this — there's no `git_host` field yet, and wiring up an actual `glab mr create` path is tracked separately.

### What gets detected automatically

| Field | How it's detected |
|-------|-------------------|
| `project_name` | `package.json` → `name`, falls back to directory name |
| `project_type` | `mobile` if `expo`/`react-native` is a dependency, `web` if `next`/`vite`/`react-scripts`/`nuxt`/`@sveltejs/kit`/`astro`/`@angular/core` is, else `unknown` — not a config field itself, used to gate `app_id`/`paywall_provider` framing below |
| `app_id` | `app.json` (Expo), `app.config.ts`/`.js`, or `capacitor.config.json` — these are checked regardless of `project_type` since they're unambiguous mobile signals on their own. If none of them match **and** `project_type` is `web`, returns empty (no fabricated `com.example.*` bundle id — meaningless for a webapp) |
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

### Mobile-only fields — skip or relabel for web projects

`app_id` and the paywall provider question are meaningless, or at least mobile-framed, for a webapp. Use `project_type` to adjust:

- **`project_type: "web"`** — skip the `app_id` prompt entirely (don't ask; write `""` to config). When prompting for `paywall_provider`, don't frame the question in mobile terms — Stripe or LemonSqueezy are the expected answers, not RevenueCat/expo-iap.
- **`project_type: "mobile"`** — prompt for `app_id` as usual; any paywall provider (including Stripe, if it's a hybrid app with a web billing portal) is fair game.
- **`project_type: "unknown"`** — still prompt for `app_id`, but don't assume a default beyond what `detect-stack.mjs` returned; ask plainly rather than presenting a mobile-flavored example.

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

## Excluding module content from the target's tooling

The module copies its own prompt/registry/config files and TypeScript scripts (`agent-runner.ts`, `run-pipeline.sh`, `detect-stack.mjs`, etc.) into `skills/` and `.ai/` inside the target project. Left alone, this breaks two ways — found live-testing on a real Expo/React Native project whose pre-commit hook ran whole-repo checks unconditionally (not scoped to staged files):

- Copied files are formatted to *this* module's style, not the target's — the first commit after setup can fail a whole-repo `prettier --check .`/`oxlint`/etc. pre-commit hook immediately, even though nothing about the target project itself is broken.
- The target's own lint/typecheck rules can flag legitimate patterns in the module's plain-Node scripts that are never bundled into the app (e.g. an Expo project's `no-dynamic-env-var` rule, meant for Metro-bundled app code, tripping on `agent-runner.ts`'s `process.env[CONFIG.llm.apiKeyEnv]` — a correct, necessary dynamic access for a script that's never bundled).

### Format the copied files once

After every copy step above (steps 5-11) has run, execute the target's own `format_write_cmd` (from `.ai/config.json`) scoped to `skills/` and `.ai/`, so the module's content matches the target's formatting conventions immediately instead of failing on the first commit.

### Append to every exclude mechanism the target project has

Detect which of these config files exist in the target project root, and append `skills/` and `.ai/` (or their idiomatic per-tool equivalents) to each one that does. Merge into existing arrays/lists — don't overwrite, and don't create a new ignore file for a tool that isn't actually in use just to add these entries:

| Tool | File | What to add |
|------|------|-------------|
| Prettier | `.prettierignore` | `skills/` and `.ai/` as new lines |
| ESLint (legacy) | `.eslintignore` | `skills/` and `.ai/` as new lines |
| ESLint (flat config) | `eslint.config.{js,mjs,cjs,ts}` | A leading `{ ignores: ['skills/**', '.ai/**'] }` object in the exported array — flat config treats an ignores-only object anywhere in the array as a global ignore |
| oxlint | `.oxlintrc.json` | `skills/**` and `.ai/**` appended to `ignorePatterns` |
| Biome | `biome.json`/`biome.jsonc` | `skills/**` and `.ai/**` appended to the version-appropriate ignore field (`files.ignore` on older Biome, `files.includes` with `!skills/**`/`!.ai/**` negation on newer Biome — check which shape the target's `biome.json` already uses) |
| TypeScript | `tsconfig.json` | `skills/**` and `.ai/**` appended to `exclude` — the default typecheck gate (`tsc --noEmit`) scans the whole project, and the module's Node-only scripts fail under an app's stricter/Metro-flavored config (missing `@types/node`, no `allowImportingTsExtensions`, etc.) |

If a config file's format can't be safely parsed and merged as-is (e.g. `tsconfig.json` with JSONC comments defeating a naive `JSON.parse`), edit it as text instead of overwriting the file, and warn the user to double-check the result if the edit looks fragile.

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
- `.ai/project-context.md` is also injected into every agent's context (see **Second pass** above) — anything appended there under `## Setup notes` persists across the whole project lifetime, not just setup.
- Re-running this skill will overwrite `.ai/config.json` — back it up first if you have customisations.
- The detection script only reads files — it never modifies the project. The CI-config second pass (done by the skill, not the script) also only reads files, except for the append-only write to `.ai/project-context.md` described above.
