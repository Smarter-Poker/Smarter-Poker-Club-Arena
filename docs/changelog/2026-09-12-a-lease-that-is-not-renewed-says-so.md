# A Lease That Is Not Renewed Says So

Every cash table on the live engine was re-claiming its lease roughly every twenty seconds.

Measured 2026-09-12, on a freshly released engine with no incident in progress:

|                                             |                            |
| ------------------------------------------- | -------------------------- |
| cash table leases held                      | 63                         |
| `cash_lease_proof_expired` restarts         | 923 in five minutes        |
| distinct tables restarting                  | 63 — **all of them**       |
| `lease_generation` on a given table         | changed on every cycle     |
| heartbeat age across those 63 rows          | uniform 0 to 19 s, mean 9  |
| event-loop delay p99                        | **21.9 ms**                |
| `heartbeat_table_leases_v4` at the database | **5.2 ms** mean, 0.7 s max |
| governor scale / sampler late               | 1 / 0 ms                   |

A changed `lease_generation` is the proof. A heartbeat keeps the generation and moves `heartbeat_at`; only a **re-claim** mints a new one. Those rows were not being heartbeated at all — they were expiring and being taken again, table by table, three times a minute each, continuously.

## This corrects an earlier diagnosis

Two hours before this, on the same engine, the same symptom was attributed to main-loop saturation starving the five-second renewal. That was measured at the time — 1,652 lease losses a minute, a full floor resuming after a maintenance thaw — and it was **wrong**, or at least not the mechanism. The loop is idle here, the database answers in milliseconds, and every cash table still restarts every twenty seconds. Saturation cannot explain an idle loop.

## Why nothing could say why

Every branch that declines to renew a lease is silent, and each one is silent for a good reason:

- `heartbeat_table_leases_v4` takes `FOR NO KEY UPDATE ... SKIP LOCKED`, so a locked row is skipped rather than waited for. Its own comment says why: _"never queue behind a settlement while holding already-renewed leases for other tables."_ A skipped row comes back **`busy`**.
- `busy` is then `continue`d in `tableLease.ts` with no counter, deliberately — it must extend nothing, and the comment beside it explains that the ordinary expiry timer stays armed through repeated busy replies. Four consecutive busies inside the twenty-second window **is** an expiry.
- A table whose local proof had already lapsed when the renewal pass reached it goes into `lostEngines`, and the report is skipped entirely when the table is tournament-owned.

Each of those is correct. None of them leaves a number. So the engine can restart every cash table three times a minute, for hours, and the only trace is a reason string in a log line — which is how this ran under a full monitoring stack, three SMS alert rules for the horse fleet, and a night of auditing, without once being named.

`SKIP LOCKED` deserves particular note: it is the right call and it makes contention **invisible**. There is no wait event, no error and no queue — a heartbeat that loses the race looks exactly like one that was never needed.

## What this explains

Each restart mints a new lease generation, and a new generation fails the authority fence of every horse turn in flight at that table. That is the `lease_lost` reason on `poker_horse_turns_abandoned_total`, and the clock-fold behind `HorseTurnTimeoutStorm` and `HorseForcedSitOuts`, both of which paged. The lease cycle is the cause; the horse timeouts are the symptom.

## Correction

`poker_lease_heartbeat_outcomes_total{scope,state}` counts every claim by what the database actually said — `kept`, `busy`, `taken`, `stale`, `missing`, `malformed` — for table and tournament leases alike. Always-on registry, zero-seeded across all twelve combinations.

`LeaseHeartbeatsNotBeingKept` pages when more than one heartbeat in twenty comes back as anything but `kept` for ten minutes.

**No behaviour is changed.** Not one lease decision is different: `busy` still extends nothing, `SKIP LOCKED` still refuses to queue, the expiry timer still fires on the same schedule. The only difference is that the engine can now say which branch it took, which is the thing that was missing.

## What is deliberately not done here

The fix. `busy` being repeatedly true for the same row points at a lock holder on `engine_table_leases`, and `pg_locks` sampled at one instant showed none — which is expected for contention measured in milliseconds and invisible by construction. Guessing at a remedy for a mechanism that cannot yet be seen is how the saturation diagnosis above got written. The counter will name it within minutes of a deploy; the remedy can then be aimed rather than inferred.
