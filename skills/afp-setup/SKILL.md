# AFP Setup — Feature Pipeline Setup

First-time project configuration for the AI Feature Pipeline module.

Run this skill when you first install the module in a project. It collects project-specific settings and generates `.ai/config.json` and `.ai/agents.json`.

## What it does

1. Prompts for project name, package manager, commands, stack details
2. Generates `.ai/config.json` with all project settings
3. Generates `.ai/agents.json` with role definitions
4. Creates `.ai/artifacts/features/` directory
5. Copies registry files (scope-checklist, ship-checklist, analytics-events, paywall-touchpoints) into `.ai/registry/`
6. Copies governance files (GOVERNANCE.md, DENIED_ACTIONS.md) from `skills/afp-pipeline/templates/` into `.ai/`

## Configuration variables

See `assets/module.yaml` for the full list of configurable values.

## Notes

- `.ai/GOVERNANCE.md` and `.ai/DENIED_ACTIONS.md` are injected into every agent's context. Edit them to add project-specific rules.
- Re-running this skill will overwrite `.ai/config.json` — back it up first if you have customisations.
