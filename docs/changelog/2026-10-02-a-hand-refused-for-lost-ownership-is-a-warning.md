# A hand refused for lost ownership is a warning (2026-10-02)

## Symptom

`fn_ca_midway_burnin_gate` needs 24 h with no new critical drift incident. Every
lease-loss burst since 2026-10-01 15:25 filed one (latest 19:37:28 525ed81f and
20:53:56 b36dc53f), each a mirror of a `postHandTasks.hand_history_failed` alert
whose error is `atomic hand commit refused (lease_proof_expired)`.

## Cause

The engine refuses its own hand commit when it cannot prove it still owns the
table (the 20 s lease proof ran out during a ~15 s PostgREST stall). It writes
nothing, kills that generation, and the successor commits the exact hand or the
hand was never played. The drift trigger already treats that refusal as a rate
under `ServerTableEngine.authoritative_hand_semantic_refusal`; runStep re-reports
it under `postHandTasks.hand_history_failed`, where the `moves_chips` branch made
it critical. 812 of 812 such alerts since 2026-10-01 12:00 UTC moved no chip
(741 exact original committed by the successor, 71 rolled back whole).

## Fix

Migration `20261002212049_a_hand_refused_for_lost_ownership_is_a_warning` adds
one branch to `fn_ca_financial_alert_to_incident`, ahead of the `postHandTasks.%`
branch: that source with exactly those two refusal reasons files as `warning`.
The incident still opens, notifies, and stays an open unknown until the alert
closes on its receipt, so an unrecovered hand still blocks the gate. The rate
net `fn_ca_hand_commit_refusals` is unchanged. Applied to production
2026-10-02 21:2x UTC; history row matches the file (md5 1463b3cc...).

## Not fixed here

The stall itself. Lease heartbeats share the engine's PostgREST path with the
hand traffic, so a database stall long enough to expire the proof still kills
generations. Moving the heartbeat to its own connection is the reliability fix.
