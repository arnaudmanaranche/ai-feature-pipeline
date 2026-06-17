# Paywall & premium registry

**Provider:** Configurable per project in `.ai/config.json.stack.paywall`

## Entitlement model
- Premium status from the configured paywall provider
- Free tier limits enforced in hooks and UI flows

## Checklist for paywall-touching features
- [ ] Free path still usable (or brief explicitly removes it)
- [ ] Restore purchases still reachable on paywall
- [ ] Premium state refreshes after purchase
- [ ] Analytics: purchase + relevant funnel events
- [ ] No paywall loop (navigation stack sane)
