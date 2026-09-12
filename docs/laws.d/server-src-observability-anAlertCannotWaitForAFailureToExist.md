# server/src/observability/anAlertCannotWaitForAFailureToExist.law.test.ts

A Prometheus counter has no series until something increments it, and a rule
whose metric has no series evaluates to an EMPTY VECTOR rather than to zero.
Empty is not below a threshold, so the rule cannot fire, and it reads on every
dashboard exactly like health. `HorseCashActionsStopped` (critical, sms) was
blind in precisely the case it is named for: an engine that started and never
got one horse cash action onto the felt has no `poker_actions_fleet_total`
series, so the page never went out. Once horses have acted the series exists
and the alert works, which is why seven days of green proved nothing.
check-monitoring-drift.mjs cannot catch this shape, because something DOES emit
the name - it simply has not run yet. Only running the code answers it, so this
law imports the instruments exactly as the engine does at boot, renders the
always-on registry, and asserts that every series a rule reads is present
before any gameplay has happened. New counters must be zero-seeded across every
label combination a rule selects on.
