# Lightning Folds Commit In One Round Trip And The Matcher Wakes At The Full-Ring Deadline

## Ack To Idle (R19 Action Breaches)

Since the restricted fold lane went live (#7543, engine release 2026-10-20 ~20:10 UTC), ack_to_idle p50 on both private pilots moved from ~130-140 ms to ~255-270 ms and p95 breaches of the 500 ms ceiling roughly doubled. Evidence:

- The database side is fast: `fn_engine_lightning_fast_fold` averages 12.8 ms (pg_stat_statements, engine_lightning_fold role); BEGIN, SET LOCAL and COMMIT are each ~0 ms.
- The engine is ~80 ms TCP round trip from the session pooler (aws-0-us-west-2, port 5432), versus ~35 ms for a warm PostgREST HTTPS request.
- The lane awaited `BEGIN`, the wrapper and `COMMIT` one after the other: three round trips (~240 ms) before the fold was acknowledged. Every `[LightningFoldTiming]` slow-fold line showed 350-700 ms totals, with event-loop lateness explaining only part of each.

Fix: the fold pool runs pg's pipeline mode and sends BEGIN, the wrapper and COMMIT together. The server still executes them in order inside one transaction. A wrapper error aborts the transaction, so the queued COMMIT answers `ROLLBACK`. Only a `COMMIT` command tag acknowledges the fold (verified against a real PostgreSQL 17: ok -> COMMIT; error -> ROLLBACK; the socket stays usable). The original route semantics are unchanged: there is no HTTP fallback or replay once anything is on the wire, outcome-unknown stays unknown, synchronous commit stays on, and the actor fence and four-socket bound stay the same. Expected effect: ack_to_idle drops by about two round trips (~160 ms) at p50 and p95.

## Idle To Match (R19 Madness Margin)

The m1 matcher holds a freshly freed player up to 3 s for a full six-seat ring (`fn_lightning_formation_sizes`, the owner's 2026-10-15 choice). Nothing scheduled a pass at that deadline: the waiting player was dealt by whichever pass came next, up to a full `pass_interval_ms` (1 s) later. Madness (12 players) shows it: waited_ms p95 is 5.6 s for 2-handed hands and 3.6 s for 6-handed ones. Separately, 13-15% of passes were skipped as `cluster_row_busy` and waited a full interval.

Fix: the worker remembers each freed player's idle moment and arms the next routine pass for the earliest full-ring deadline (+50 ms clock margin), never later than the pass interval. A pass the database skipped because another pass held the Cluster is asked again after 150 ms. Who is matched, sizes, blinds and fairness are untouched, because the matcher still decides everything from its own `idle_since`. Expected effect: removes up to 1 s from the deadline-bound tail of idle_to_match.

Engine only; no migration, client or money change. Both ship with the next daily engine release.
