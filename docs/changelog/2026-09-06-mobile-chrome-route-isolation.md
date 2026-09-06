# Mobile Chrome Route Isolation

## What Changed

- Split the 375px mobile chrome occlusion audit into one independent Playwright test per route.
- Preserved the existing top-header and bottom-navigation geometry checks for every audited route.
- Added the Leaderboard route to the mobile chrome coverage set.

## Why

The production release gate previously placed every route in one five-minute test. The browser closed at the suite timeout before the final route verdict, so 245 other production checks could pass while the release still ended red. Independent tests retain the same geometry assertions, allow the existing two workers to share the routes, and identify the exact failing page without losing the rest of the audit.

## Validation

- TypeScript typecheck.
- ESLint for the changed Playwright spec.
- Production-targeted Playwright structure run with all route cases completing independently.
