# Feature brief

**Feature slug:** settings-toggle
**Tier:** S
**Status:** Approved

## Problem

Users have no way to opt out of marketing emails from within the app; they
must use the unsubscribe link in an email, which many never find.

## Goals

- Let users toggle marketing emails on/off from the Settings screen.
- Persist the choice server-side so it applies across devices.

## Acceptance criteria

1. Given a user on the Settings screen, when they toggle "Marketing emails" off, then the preference is persisted and no further marketing emails are sent.
2. Given a user who toggled the setting on device A, when they open Settings on device B, then the toggle reflects the persisted value.
3. Given a network failure while saving, when the save fails, then the toggle reverts and an error message is shown.

## UX / screens

- Settings screen: add a new row "Marketing emails" with a switch, under the existing "Notifications" section.

## i18n

- `settings.marketing.title`: en="Marketing emails", fr="E-mails marketing"
- `settings.marketing.error`: en="Couldn't save your preference", fr="Impossible d'enregistrer votre préférence"

## Analytics

- `settings_marketing_toggled` (NEW) — property `enabled: boolean`

## Technical notes

- Files likely touched: `app/(tabs)/settings.tsx`, `services/preferences.ts`, `i18n/locales/en.ts`, `i18n/locales/fr.ts`.

## Scope

- **IN:** the toggle UI, persistence, optimistic update with revert on failure.
- **OUT:** an email-preference center with granular categories (future feature).
- **Entry points:** Settings screen only.
- **Edge cases:** offline save failure (AC3), stale value on cold start.
- **Data storage:** `user_preferences.marketing_emails` boolean, server-side.
- **Navigation changes:** none.
