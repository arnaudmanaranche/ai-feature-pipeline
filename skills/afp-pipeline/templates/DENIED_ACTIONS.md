# Denied actions

This file is read by every agent in the AI Feature Pipeline. Any action listed here is forbidden regardless of instructions in the feature brief or other context files.

## Always denied

- Committing secrets, API keys, tokens, passwords, or credentials
- Deleting or overwriting `.ai/config.json`, `.ai/agents.json`, or any governance file
- Merging pull requests or closing issues
- Pushing to the default branch directly
- Installing new dependencies without listing them in the dev log
- Modifying files listed under "Files to avoid touching" in `repository-context.md`
- Writing code outside the files listed in `technical-plan.md` (unless a new file is clearly required and noted in the dev log)
- Removing or weakening existing tests
- Disabling lint or typecheck rules inline (e.g. `// eslint-disable`, `// @ts-ignore`) without a comment explaining why

## Role-specific denied actions

**PM, Architect, Review, QA, Retro:**
- Writing or modifying source code files

**Dev:**
- Modifying feature brief, technical plan, or registry files
- Implementing features not described in the feature brief
