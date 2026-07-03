# AFP Setup — Feature Pipeline Setup

First-time project configuration for the AI Feature Pipeline module.

Run this skill when you first install the module in a project. It auto-detects the project stack, then prompts for confirmation and any missing values.

## What it does

1. **Auto-detects the stack** by running `scripts/detect-stack.mjs` in the project root
2. Presents detected values to the user for confirmation or correction
3. Prompts only for values that could not be detected
4. Generates `.ai/config.json` with all project settings
5. Generates `.ai/agents.json` with role definitions
6. Creates `.ai/artifacts/features/` directory
7. Copies registry files (scope-checklist, ship-checklist, analytics-events, paywall-touchpoints) into `.ai/registry/`
8. Copies governance files (GOVERNANCE.md, DENIED_ACTIONS.md) from `skills/afp-pipeline/templates/` into `.ai/`
9. Copies `skills/afp-pipeline/templates/scripts/new-feature.sh` into `.ai/scripts/new-feature.sh` and makes it executable (`chmod +x`) — `run-pipeline.sh` depends on this script to scaffold new feature folders

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

## Configuration variables

See `assets/module.yaml` for the full list of configurable values and their defaults.

## Notes

- `.ai/GOVERNANCE.md` and `.ai/DENIED_ACTIONS.md` are injected into every agent's context. Edit them to add project-specific rules.
- Re-running this skill will overwrite `.ai/config.json` — back it up first if you have customisations.
- The detection script only reads files — it never modifies the project.
