# TODO

Known limitations not yet addressed — tracked here rather than fixed reactively.

## Design agent — integrate Figma/Pencil/Storybook into the pipeline

The pipeline currently goes PM → Dev Review → Architect → Dev → Review → QA → Retro with no role that checks
the implementation against an actual design source of truth — Review's "diagram vs diff" check is structural
consistency, not visual/UX fidelity. For any feature with a design file (Figma) or component-driven UI
(Storybook), Dev could easily drift from the intended layout/spacing/tokens with nothing catching it before QA
or a human.

Direction to explore: a design-check step (either folded into an existing role like Review, or a new one)
that pulls design context — e.g. via the Figma MCP server's `get_design_context`/`get_screenshot`, or a
Storybook story/snapshot comparison — and cross-checks it against Dev's actual output (rendered component,
screenshot, or token usage) before sign-off. Would need scoping: which stage it slots into, what "pass" means
when no design file exists for a feature (same fallback pattern as the E2E/QA gate — BLOCKED_ENV vs brief-only
judgment), and whether it's a hard gate or an advisory note in the artifact.

## iOS — integrate App Store Connect CLI (asc) skills

For iOS projects, the pipeline currently stops at PR creation with no path to TestFlight/App Store distribution —
shipping a build still means dropping out of AFP into the App Store Connect web UI or a separate Fastlane setup.
[asc](https://asccli.sh/#skills) is a single-binary, dependency-free CLI wrapping the App Store Connect API, and
ships 23 pre-built AI-agent skills covering release submission, TestFlight distribution, build uploads, code
signing/provisioning, and metadata/screenshot sync across locales.

Direction to explore: a post-QA, iOS-specific stage (or an extension of Retro/a new "Ship" role, gated on
detecting an iOS/Expo project in `.ai/config.json`) that invokes the relevant `asc` skill(s) to upload the build
and kick off TestFlight distribution once QA passes. Needs scoping: which `asc` skills are in scope for a first
pass (build upload + TestFlight only, vs also metadata/screenshots), how Apple credentials/API keys are supplied
without landing in `.ai/config.json` in plaintext, and whether this is a hard pipeline stage or an opt-in script
a human triggers manually after AFP hands off the PR.

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

## GitLab support — run-pipeline.sh's PR step is GitHub-only

`run-pipeline.sh`'s final stage hardcodes `gh pr create`/`gh pr edit`/`gh pr list`. On a GitLab-hosted project
this fails harmlessly (the pipeline still completes, just without opening anything) but there's no actual MR
creation path. Would need a `glab mr create` branch (or GitLab REST API call) gated on detecting the git host
from the remote URL, mirroring what `detectGithubRepo()` already half-does.

## Provider abstraction — Anthropic/Bedrock-native backends

`agent-runner.ts` now talks to any OpenAI-compatible chat-completions + tool-calling provider via
`llm.baseUrl`/`llm.apiKeyEnv` (OpenAI, Azure OpenAI, Groq, Together, Fireworks, Ollama). Anthropic's native
Messages API and Bedrock use a different request/response shape entirely and would need a real adapter, not
just a config change — scope that separately if/when needed.

### Distinct sub-case: people with only a Claude subscription, no API key

The interactive skill mode (`/start afp-pipeline` run directly inside Claude Code) already covers this —
Claude Code itself plays each role, no OpenRouter/API key involved at all. But it gets none of the
orchestration machinery that lives in `run-pipeline.sh`/`agent-runner.ts`: worktree isolation, quality gates,
retries, structured-output schema validation, per-role write permissions, the concurrency lock, the token
budget. All of that is headless-script-only today, and the headless script only knows how to hit a raw HTTP
API — which requires a key.

**Research done (2026-07-16) — this is buildable, not just an idea:**

- `claude setup-token` creates a long-lived auth token, explicitly documented as "requires Claude
  subscription" — the credential path for a subscription-only user, no `ANTHROPIC_API_KEY` involved.
- `claude -p "<prompt>" --output-format json --model sonnet` runs one non-interactive turn and exits,
  printing a single JSON object (`result`, `session_id`, `total_cost_usd`, `usage`, `stop_reason`,
  `is_error`, ...). Confirmed live.
- `--json-schema '<schema>'` forces structured output validated against that schema and returns it in a
  `structured_output` field — confirmed live by passing it a toy schema. This maps directly onto the JSON
  Schema `buildToolSchema(role)` already builds in `agent-runner.ts:1085` for the OpenRouter
  `tool_choice: {type:'function', name:'submit_changes'}` path — same contract, different transport.
- Also relevant: `--system-prompt`/`--append-system-prompt`, `--no-session-persistence`, `--max-budget-usd`
  (print-mode only, per-call $ cap — fits the pipeline's existing token-budget concern), `--tools ""` (this
  call site only wants a JSON answer back, not the CLI's own Edit/Bash/Write access — `agent-runner.ts`
  applies file changes itself afterward, same as the OpenRouter path today).
- Worktree isolation, the concurrency lock, and `--dry-run` all live in `run-pipeline.sh` at the shell/git
  level and are backend-agnostic — no changes needed there. Retry logic and `missingRequiredFields`
  validation in `agent-runner.ts` are also backend-agnostic; they just need whichever backend to hand back
  `argsRaw` JSON.

**Proposed shape:** add `CONFIG.llm.backend: 'openrouter' | 'openai-compatible' | 'claude-cli'` (no such
switch exists today — `stack.backend` at `agent-runner.ts:69` is the *app's* backend, unrelated). For
`claude-cli`, `callLlm` spawns `claude -p <userPrompt> --system-prompt <systemPrompt> --model <model>
--output-format json --json-schema <schema> --tools "" --no-session-persistence [--max-budget-usd ...]`
instead of `fetch()`, and reads `structured_output` instead of
`data.choices[0].message.tool_calls[0]`. Retryable conditions become non-zero exit code / `is_error: true`
instead of HTTP status codes. Currently being implemented — see in-progress work in this session.

## Dev's one-shot "full file content per touched file, in one JSON response" doesn't scale

Found live on a real ~13-file feature (monthly size reminder, little-nook): Dev hit `finish_reason: "length"`
(truncated mid-JSON) at maxTokens=24000, then *again* at maxTokens=64000 — the second attempt spent the full
64000 completion tokens and still didn't finish emitting every full file's content inside one submit_changes
call. This isn't a tuning problem: cranking maxTokens further just runs into (a) the model/provider's actual
max-output ceiling and (b) real cost — the 64000-token attempt alone cost $1.21, and immediately after it the
OpenRouter account didn't have enough credit left for another attempt at that size (402: "requested 64000
tokens, but can only afford 50228").

Current design asks Dev to emit the *complete* content of every touched file (a deliberate anti-hallucination
choice from early on — diffs invite subtly-wrong context). That's fundamentally at odds with features that
touch many files: the more files a feature needs, the more likely a single call truncates, and there's no
graceful degradation — a truncated call just fails schema validation and burns another full-price retry that
will hit the same ceiling.

Directions worth exploring (not mutually exclusive):
- ~~Split Dev's work across multiple calls, one per file (or small batch of files) from the technical plan's
  impacted-files list, instead of one call for everything — bounds each call's output size regardless of
  total feature size, at the cost of more calls/orchestration complexity in run-pipeline.sh.~~ **Implemented
  (2026-07-16).** `agent-runner.ts` now splits Dev into sequential batches of
  `project.devFileBatchSize` files (default `DEFAULT_DEV_FILE_BATCH_SIZE = 6`) whenever the Architect's
  technical plan references more impacted files than that — below the threshold, behavior is byte-for-byte
  identical to before (exactly one call). Each batch's result is applied to disk immediately, so later
  batches see earlier ones' files the same way a retry sees the previous attempt's output — and
  `run-pipeline.sh` needs zero changes, since quality gates/commits/retries still run once per external
  `--role=dev` invocation regardless of how many internal batches it took. Token-budget accounting and the
  abort-if-over-budget check now happen per-batch (not just once per role invocation), since a batched
  feature can spend far more than a single call would. See `extractImpactedFiles`, `runDevBatched`, and the
  `DevBatch` prompt-shaping in `buildUserPrompt` for the implementation; `extractImpactedFiles` has unit
  tests, the batching loop itself doesn't (same pattern as `callLlm` — the network/CLI-calling shell isn't
  unit tested, only its pure helpers are). Not yet smoke-tested against a real >6-file feature end-to-end.
- Detect `finish_reason: "length"` specifically (we already log it) and treat it differently from a generic
  schema-invalid retry: e.g. ask Dev to continue/complete the truncated file list, or explicitly instruct it
  to prioritize which files matter most if it can't fit everything. Batching (above) reduces how often this
  fires per call but doesn't eliminate it — a single file that's itself huge can still truncate.
- Surface a pre-flight estimate (impacted-file count/size from the technical plan) as a warning before even
  calling Dev, so a human can decide to split the feature into smaller ones rather than discovering the
  ceiling via a failed, paid call. Largely superseded by automatic batching, but could still be useful as a
  visible "this will take N batches" log line before the first call.
