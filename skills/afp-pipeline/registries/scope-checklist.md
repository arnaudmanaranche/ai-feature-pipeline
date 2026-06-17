# Scope checklist

Every feature must answer these questions. Include the answers in the feature brief under a dedicated "## Scope" section. If a question is truly not applicable, state "N/A — [reason]".

## 1. IN / OUT
List what is explicitly **IN scope** and what is explicitly **OUT of scope** for this feature.

## 2. Entry points
What are all the ways a user can reach this feature? List every path.

## 3. Side effects
What other files, systems, or behaviors are indirectly impacted?
- Permissions (OS-level, push, camera, etc.)
- Navigation / routing
- Existing state (does this reset or change anything?)
- External services (APIs, databases, etc.)
- Analytics / telemetry

## 4. Edge cases
- No network / offline
- Permissions denied / revoked
- Empty data (no items, no records, etc.)
- Limits (max items, quotas, pagination)
- First launch vs returning user

## 5. Dependencies
What packages, modules, or external services are needed?

## 6. Data
Where is user preference stored? What format? What key?

## 7. Screens / navigation
Does this feature need a new screen? Does it modify an existing one? Are there navigation changes?
