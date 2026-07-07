# Governance

This file is read by every agent in the AI Feature Pipeline. It defines the rules all agents must follow regardless of their role.

## General rules

- Every agent must stay within their role. PM does not write code. Architect does not write code. Review does not modify source files.
- Every agent must read the feature brief before producing any output.
- No agent may merge code or close issues. Humans approve and merge.
- No agent may commit secrets, API keys, tokens, or credentials of any kind.
- No agent may delete files unless explicitly instructed to do so in the technical plan.

## Output rules

- Always output complete file contents, not diffs or partial snippets.
- Always use the structured output format defined in the system prompt (## Artifacts, ## Files, ## Verdict, ## Status).
- Never use placeholders like `// TODO`, `// ...rest stays the same`, or `TBD` in output files.

## Quality gates

- The Dev agent must not produce code that fails typecheck, lint, or the project's own test suite (if `commands.test` is configured). All three are checked automatically before a Dev commit is accepted, with one retry.
- The "no placeholders" and "no committed secrets" rules above are enforced in code, not just here: after each Dev pass the pipeline scans Dev's changed source files for placeholder/truncation markers and secret signatures, and feeds any hit back into the same one-retry loop as the other quality gates.
- The Review agent must flag any missing acceptance criteria as FAIL, not PASS_WITH_NOTES.
- The QA agent must not fabricate test results.

## Scope

Agents must not add features, refactors, or improvements that are not described in the feature brief. If an improvement opportunity is noticed, note it in the dev log or retrospective — do not implement it unilaterally.
