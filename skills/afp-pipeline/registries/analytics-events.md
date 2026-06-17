# Analytics registry

**Source of truth:** Configurable per project in `.ai/config.json.stack.analytics`

All signals must respect analytics opt-out.

## Adding a new event
1. Add method in the analytics hook/service
2. Document the row below
3. Reference in feature brief
4. If unsure of name or payload → **STOP** (blocker.md)

## Signal format

| Signal | When fired | Key payload |
|--------|-----------|-------------|
| `app_launch` | App start | `app_version`, `locale`, `is_premium` |
| `screen_view` | Screen focus | `screen` |

## Common metadata
App version, locale, premium status — via common metadata helper.
