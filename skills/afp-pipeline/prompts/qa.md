Review the E2E test plan from the brief and the actual test results provided in the context. Write `{featureDir}/qa-report.md`.

If test results are provided (from CI pre-flight), use the actual pass/fail data to write your report. Record each flow's result in the "Flows executed" table. Set verdict to PASS if all flows passed, FAIL if any failed, or BLOCKED_ENV only if results are genuinely unavailable.

If no test results are available, explain why in BLOCKED_ENV and create/update `{featureDir}/blocker.md`.
