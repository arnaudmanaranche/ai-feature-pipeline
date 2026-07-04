# TODO

Known limitations not yet addressed — tracked here rather than fixed reactively.

## Structural verification of diagram/skill-proposal gates

The Architect's Mermaid diagram gate only checks that a ` ```mermaid ` block exists — not that it's meaningful.
Review's "diagram vs diff" check and Retro's "pattern repeated 3+ times" skill-proposal are both pure LLM
judgment calls with no structural verification backing them up. They can be satisfied trivially or never fire.

Possible direction: parse the Mermaid diagram's participants/calls (it's a fairly regular DSL) and cross-check
that the named participants/functions actually appear in the git diff, as a structural pre-check before Review's
own judgment — not a replacement for it, but a guardrail against a diagram that's disconnected from the diff
entirely (e.g. wrong participant names, zero overlap with changed files).

## Observability — per-run/per-agent visibility

Right now the only visibility into a run is: stdout during the run, `.agent-<role>-response.md` raw logs, and
`.agent-status*.json` files. There's no aggregated view across features of: cost per feature/role, latency per
call, retry rates per stage, model comparison, or prompt/response history in a queryable form.

Evaluate wiring in **Opik (by Comet)** for LLM observability — traces per agent call, cost tracking, and
evaluation/scoring hooks — instead of building bespoke logging further. Would likely hook in at
`callOpenRouter()` in `agent-runner.ts` (wrap the fetch call) and log role/slug/model/tokens/latency/verdict
per call as a trace.

## afp-setup should read CI config, not just package.json

Found while live-testing setup against a real pnpm/Next.js monorepo: `detect-stack.mjs` only reads
`package.json` (scripts + deps), which needed two rounds of bug fixes (package-manager-agnostic commands,
missing `typescript` script-key convention) to get right for just one repo — and still can't know things like
"i18n is managed externally via Loco, not local locale files" or "this is GitLab, not GitHub, so `gh pr create`
in run-pipeline.sh will never work here."

Direction: keep `detect-stack.mjs` as the deterministic, free, reproducible first pass (package.json extraction
is genuinely ground-truth and shouldn't be replaced by an LLM guess). But have the `afp-setup` skill itself
also read `.gitlab-ci.yml`/`.github/workflows/*.yml`/README as a second, judgment-based pass to catch the
institutional-knowledge fields a script can't (real CI gate commands, i18n tooling, git host/PR-vs-MR
mechanics) — script for what's verifiable, skill for what needs context.

## GitLab support — run-pipeline.sh's PR step is GitHub-only

`run-pipeline.sh`'s final stage hardcodes `gh pr create`/`gh pr edit`/`gh pr list`. On a GitLab-hosted project
this fails harmlessly (the pipeline still completes, just without opening anything) but there's no actual MR
creation path. Would need a `glab mr create` branch (or GitLab REST API call) gated on detecting the git host
from the remote URL, mirroring what `detectGithubRepo()` already half-does.
