# The health report had no reader

2026-09-08. Migration `20260908162611_the_health_report_gets_a_reader.sql`.

Found by running the agent playbook's own VERIFICATION PASS (RULE 1 PART C.2,
"is every new function actually CALLED?") against my own work. Neither item is a
bug in what the code does; both are the defect this programme spent the day on,
appearing in the work that fixed it.

## Nothing read fn_ca_diamond_health

Measured: **0 cron callers, no application caller.** Fourteen areas over 28
reporting functions, built precisely because a defect survived a week of daily
review among them — and then nobody was scheduled to open it. That is exactly
what "the flip had no hand" was four hours earlier: an instrument that is
correct, complete, and unreachable. CLAUDE.md 10.86 rule 3 states the test in one
line: **a guard must have a reader, and you must name them.**

`fn_ca_diamond_health_watch()` runs hourly and files a CRITICAL incident naming
every area that is `critical` or `unknown`. The reader is the incident table,
which the flip forecast, the trial-balance watch and a person all already read —
no new surface to remember.

It files only on critical/unknown, never on `attention`. Two areas are amber
today for reasons that are Dan's decision (the budget plans) and a fixed cause
(evaluation coverage); an alarm firing hourly on those would be muted in a week.

## fn_ca_normalise_claim_loop was dead

It pinned the two copies of the horse claim loop character-for-character while
merging them was too risky. Migration 20260908152950 then removed the loop from
the event path entirely, so what it pinned no longer exists. Measured: 0
functions reference it, 0 cron jobs, 0 views, 0 event functions still carry a
claim loop.

The playbook is blunt — "Dead code is unacceptable" — and it is right: a function
whose name says it guards something, guarding nothing, is worse than no function,
because the next reader assumes the guard is live. Dropped, after proving it dead
inside the same transaction rather than trusting a measurement from a minute
earlier.

## Verified

```
health has a reader (0 bad area(s) right now); the dead normaliser is dropped
```

The watch's count is asserted to equal the report's own count of critical/unknown
areas, so it cannot drift from what it reads.
