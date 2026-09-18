# Production setup failure evidence

The containing-release browser certificate 35317486463 failed its customization
realtime global setup at 07:10:19 UTC with an explicit unknown Terms decision.
That setup recorded neither the failed browser request nor the dynamic import
error, and the browser closed after the failure. Adjacent gateway reads and the
next successful setup cannot establish the original cause.

The original setup now attaches bounded, read-only failure observation before
its first navigation. Its existing failure exit emits structured navigation,
script/import and Terms-query events, stage/timing, HTTP status and allowlisted
error classes. Query strings, fragments, account identifiers, headers, bodies,
arbitrary console messages and credential-bearing URLs are never retained.
The same Terms unknown refusal, assertions, time budgets and original thrown
error remain authoritative. There is no retry or product behavior change.

Regression coverage in the existing production account preflight suite checks
request grouping, import/network/navigation distinctions, private-input
exclusion, bounded retention and listener cleanup. The captured production
failure demonstrates the observation gap; this change does not claim to repair
its still-unknown browser/network cause.
