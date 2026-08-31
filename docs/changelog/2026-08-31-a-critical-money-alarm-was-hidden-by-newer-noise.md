# 2026-08-31 — A critical money alarm was being hidden by newer noise

Found while verifying Phase 4 of the Spins audit. The new
`fn_spin_fairness_check` raises into `financial_alerts`, so before trusting it
I traced where a critical alert actually ends up. It ends up on the admin
Financial Alerts page — and that page could not show it.

## What was wrong

`FinancialAlertService.getUnresolved` was one query: unresolved, newest first,
`.limit(n)`. The page asked for 100.

Production had **472 unresolved rows**. So 372 never rendered — and two of the
nine unresolved **criticals** were among them:

| Raised     | Source                       | Message                                                           |
| ---------- | ---------------------------- | ----------------------------------------------------------------- |
| 2026-08-21 | `fn_union_treasury_selftest` | Union treasury conservation breach: `bbj_pool_conservation_drift` |
| 2026-08-24 | `fn_union_treasury_selftest` | Union treasury conservation breach: `lapsed_week_unclosed`        |

Two money-conservation breaches, unresolved for seven and ten days, sitting
underneath four hundred newer warnings where nobody could see them.

The page's severity tabs then made it worse by looking correct. They counted
**client-side over the truncated hundred**, so "Critical (7)" was not the
number of unresolved criticals — it was the number that happened to survive the
cut. "All (100)" was not the number of open alerts either; there were 472.

A money alarm that can be pushed off the screen by unrelated chatter is not an
alarm. And it is the channel the new fairness guard writes into, so every guard
downstream of it inherited the same blind spot.

## The fix

Criticals are fetched by their own query and never compete for the page budget.
They are few by construction — nine against 472 — and if there are ever more
than the limit, the caller gets all of them anyway: going over budget is the
correct failure for this one severity. They still get a ceiling of their own
(`CRITICAL_CEILING = 500`), because an unbounded select is how a browser tab
dies on the day something goes badly wrong.

`getUnresolvedCounts()` returns exact head counts per severity, so the tabs
report what is in the database rather than what happened to load. When the page
is not showing everything it now says so, and says that every critical is
shown.

## Verified in both directions

`tests/unit/criticalAlertsAreNeverTruncated.test.ts` builds production's actual
shape — nine criticals, two of them the oldest rows in the table, buried under
463 newer warnings — against a supabase mock that **honours the filters**, since
the defect was in which rows the query asked for and a mock that ignored
filters could not have caught it.

Restoring the old single-query implementation turns five of the seven red, and
the failure names the real row: `critical crit-treasury-0821 was truncated
away`. Restoring the fix makes all seven pass.

## Not fixed here

The two treasury breaches themselves are real and still unresolved. They are
union treasury conservation, not Spins, and they belong to whoever owns that
ledger — this change is only about the fact that nobody could see them.
