# Ship checklist (pre-MR approval)

## Always
- [ ] Feature brief status **Approved**
- [ ] All acceptance criteria checked in review report
- [ ] Dev log status **Ready for review** or **Done**
- [ ] No blocker in **OPEN** state
- [ ] Lint and typecheck pass
- [ ] Review report verdict ≠ **FAIL**
- [ ] QA report verdict = **PASS**
- [ ] Human will approve MR (agents do not merge)

## i18n & a11y
- [ ] New strings in all supported locales
- [ ] Interactive UI has accessibility labels / roles
- [ ] E2E tests updated if labels or navigation changed

## Analytics
- [ ] New/changed events registered
- [ ] Opt-out respected

## Paywall & premium
- [ ] Changes reflected in paywall registry if applicable
- [ ] Tested free + premium paths

## Privacy & data
- [ ] No secrets in repo
- [ ] Data handling matches brief

## Observability
- [ ] No new noisy unhandled errors (spot-check)
- [ ] Failures must not break UX
