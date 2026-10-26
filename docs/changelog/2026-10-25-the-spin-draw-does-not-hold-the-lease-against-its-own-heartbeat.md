# The Spin draw does not hold the lease against its own heartbeat (lease follow-ups, phase 1)

**Date:** 2026-10-25
**Follows:** `docs/changelog/2026-10-25-a-launch-does-not-hold-the-lease-against-its-own-heartbeat.md`
**Migration:** `20261025224305_the_spin_draw_does_not_hold_the_lease_against_its_own_heartb.sql`
**Law:** `tests/no-live-door-holds-the-lease-against-its-own-heartbeat.db.law.test.ts`
**Native proof:** `scripts/ci/test-spin-draw-lease-key-share-postgres.py`

## The audit

After the two MTT launch doors were fixed, every function on production that
takes `FOR UPDATE` or `FOR SHARE` on `public.engine_tournament_leases` was
listed from `pg_proc` (24 of them) and classified by who calls it and what the
lock is for.

| group                             | functions                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | verdict                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| moves or ends the lease           | `claim_tournament_lease_v2`, `release_tournament_leases(_v2)`, `reap_dead_engine_leases`                                                                                                                                                                                                                                                                                                                                                                                  | must lock; untouched                                                                                       |
| the heartbeat itself              | `heartbeat_tournament_leases_v4` (`FOR NO KEY UPDATE ... SKIP LOCKED`)                                                                                                                                                                                                                                                                                                                                                                                                    | the renewal, never a holder; untouched                                                                     |
| launch doors a live manager calls | `fn_begin_tournament_launch_atomic` x3, `fn_complete_tournament_launch_atomic` x3 (fixed 20261025200555), **`fn_spin_draw_and_settle_atomic`**                                                                                                                                                                                                                                                                                                                            | **this change**                                                                                            |
| recovery doors, admitted by name  | `fn_f06_abort_abandoned_generation` (its `FOR UPDATE` is documented in its own body as a deliberate barrier that drains every protocol-2 request before the abort; it runs at resume, before any dealer is built), `fn_f06_prepare_mixed_manager_custody` (locks only a lease whose heartbeat is already stale, `F06_MIXED_OLD_LEASE_CHANGED` otherwise, so no live heartbeat is behind it)                                                                               | left as designed, named in the law with the reason                                                         |
| historical one-off doors          | the breakfast and sep8 witnesses, the two welcome-certification board preparers, `continue_retired_undealt_paid_entry`, `fn_f06_abort_{unsettled,successor_unsettled}_hand`, `fn_f06_abort_{unsettled,mixed_unsettled}_generation`, `f06_retained_mtt_abort_snapshot`, `f06_retired_origin_begin` (pinned to one retired engine instance), `f06_void_retired_mixed_custody_event`, `fn_f06_close_abandoned_manager_transfer`, `fn_stage_a_bridge_legacy_capacity_receipt` | no caller in the engine, in any live database function, or in cron; older than the law's cutoff; untouched |

The engine (`server/src`, non-test) calls exactly seven of the 24. One of them
was still a live door with the heavy lock: the Spin's launch.

## The Spin launch

`fn_spin_draw_and_settle_atomic` is the Spin's launch door, the same shape as
the MTT one - 30 s statement budget, the shared maintenance advisory lock, the
launch receipt, the `launch_lease_lost` answer - and it opened with
`SELECT * INTO v_lease FROM public.engine_tournament_leases WHERE tournament_id
= p_tournament_id FOR UPDATE;`, held through the whole draw and settlement.
`engine_recovery_events`, last 7 days: **9 Spin tables** killed with
`tournament_lease_lost`, one per Spin, each at its own launch; today's was
`7d1abc56` at 18:25:35 UTC (receipt 18:25:08 -> 18:25:24, heartbeat `busy` +6
in the window ending 18:25:45).

## The fix

`FOR KEY SHARE`, exactly as the other doors. It still blocks a takeover and a
release, no longer blocks the heartbeat, the function never writes the lease
row, and the draw stays serialized where it always was
(`fn_lock_tournament_launch_proof_parents`, the launch receipt, the
`tournaments` row). Edited by exact anchor (one hit, one overload, md5
`1e5b6175ed91b8fc` measured against production), no-op on re-apply, with
post-conditions that no launch door takes `FOR UPDATE` on the row any more,
the takeover still does, and the heartbeat still uses `SKIP LOCKED`.

Proven natively with two sessions
(`scripts/ci/test-spin-draw-lease-key-share-postgres.py`, in the existing
lease workflow): busy before, kept after, takeover still blocked, door still
verifies the generation and still answers.

## The law, widened

`tests/no-live-door-holds-the-lease-against-its-own-heartbeat.db.law.test.ts`
scans every migration newer than this one: any `CREATE FUNCTION` body (or
in-place anchor edit) that takes `FOR UPDATE`, `FOR NO KEY UPDATE` or
`FOR SHARE` on `engine_tournament_leases` fails CI unless the function moves
or ends the lease, or is one of the two recovery doors admitted by name with
its written reason. Verified against a probe migration carrying a fresh
offender before this shipped: refused by name.

## Not changed, and why

- The two admitted recovery doors keep their locks: one is a documented
  barrier, the other only ever locks a dead lease. Changing either on no
  evidence would be a guess.
- `fn_f06_abort_abandoned_generation` is worth a look if a resume ever shows
  the 13:27 signature (`busy` on one event, then `lease_proof_expired`); none
  did in the 7 days read.

## Seen during the audit, not this phase

A fourth `tournament_lease_lost` today (`5469ba74`, 21:41:18 UTC, one table)
had **no** `busy` before it and no `lease_proof_expired` line: the heartbeat
answer arrived and `renewTournamentLeaseProof` refused it in the engine. The
report folds "the answer came after its own 20 s window", "a dealer refused
to renew" and "no answer arrived" into one sentence (`verdict: unproven`),
which is the 10.86 shape - a signal that answers when it does not know which.
That is an engine-side distinction, not a lock, and belongs to a later phase.
