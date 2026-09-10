# Production Account Terms Preflight

The customization realtime, customization commerce, and Daily Missions production
certifications create separate reserved accounts after global setup. They entered
the profile preflight without processing Terms for those accounts. TOSGuard removes
its children while consent is required, so the inner profile marker cannot appear.
Global setup's consent belongs to a different account and does not solve this.

All three sign-in flows now call the existing `ensureAcceptedTerms` helper before
`ensurePlayableProfile`. Daily Missions recognizes the outer Terms marker as an
entry surface, preventing unnecessary shell recovery while that gate is visible.
The helper keeps explicit consent, unavailable-decision failures, and reload-based
persistence verification. Reserved-account identity checks, feature assertions,
timeout budgets, and cleanup remain intact. No runtime, database, or cron changes.

Validation: 27 existing tests passed across `productionE2EProfilePreflight` and
`dailyMissionsProductionCertification`; `npx tsc --noEmit` exited 0. Playwright
`--list` collected all three affected certifications without executing production
setup or tests. Independent review found no material corrections.

Run 34440738779 recorded three profile-preflight timeouts before feature assertions.
The source omission is proven; saved browser-state evidence was unavailable, so
this change does not claim all three recorded timeouts share a confirmed cause.
Production acceptance requires a subsequent normal run using the repaired source.

The same acceptance repair corrects the hamburger version assertion to the
approved `Poker Arena` brand and scopes it to the existing Poker Arena dialog.
Its version match, scrolling, visibility assertion, and timeout remain intact.
The runtime footer and assertion were unchanged between failed production
`56962e048d` and main `08a1858033`. No open PR touched either file during the
ownership check. The runtime brand and shared navigation geometry are unchanged.
