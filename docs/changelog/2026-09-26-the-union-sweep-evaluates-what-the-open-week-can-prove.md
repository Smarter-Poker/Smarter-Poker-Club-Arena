# The union sweep evaluates what the open week can prove (2026-09-26)

Three money producers, one stranded-event sweep. Migrations
`20260926042119_the_union_sweep_evaluates_what_the_open_week_can_prove` and
`20260926042810_the_period_calculator_reads_one_week_of_attributions`; law
`tests/the-union-sweep-evaluates-what-the-open-week-can-prove.law.test.ts`.

Measured at the start (2026-09-26 04:03 UTC): drift board 12 open,
`financial_alerts` 1,001 unresolved, of them 202 `fn_union_enforce_stop_loss`
and 183 `fn_union_rake_basis_refresh`.

## 1. The stop-loss had not enforced anything since 2026-09-17

`fn_union_enforce_stop_loss` loops over `fn_union_club_exposure`, which reads
`fn_union_reconciliation_report(union, week_start, now())`, which since
`20260917234315` is the certified weekly P&L. That report certifies closed
weeks only and refuses `p_end = now()` with `invalid_closed_pnl_evidence_period`
before it reads a row. So the enforcer raised on its first statement every
hour. `20260918091617` predicted it would repair itself on 2026-09-21; it could
not, because the refusal is structural.

The damage was not the exposure leg (both Midway clubs have
`stop_loss_limit` NULL, so it can never breach). It was the NON-PAYMENT leg,
which reads only `settlement_invoices` and never needed the P&L, but never ran
because the exposure leg threw first. MIDWAY-2026-000005 (Club JAQK,
33,222.29) and MIDWAY-2026-000006 (SHARK CLUB, 11,244.03) were due 2026-09-17
07:00 and passed the union's 7-day grace at 2026-09-24 07:00. The union's own
rule (`weekly_invoices_enabled = 1`) suspends a club in that position. That
genuine breach was silenced for two days.

Fix: the legs are independent. Non-payment is the old test, unchanged. Exposure
is asked in its own subtransaction; if its source refuses, the club's exposure
is `not_evaluable` - its own outcome, never "clear" and never "breached". A club
suspended by the enforcer is released only when every leg that applies to it was
evaluated and is clear. One warning per union per open week when a club with a
limit cannot be evaluated (deduplicated), instead of 24 identical failures a day.

Proved in one rolled-back transaction on production (pg_temp copy, DO block
ending in RAISE):

| case                                                            | result                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| installed body                                                  | raises `invalid_closed_pnl_evidence_period`                                                                             |
| A. live data                                                    | suspends Club JAQK (33,222.29) and SHARK CLUB (11,244.03) on non-payment, `exposure_state: no_limit`; 2 critical alerts |
| B. run again                                                    | idempotent: nothing suspended, nothing released                                                                         |
| C. grace widened to 30 days                                     | both restored (no limit, nothing past due)                                                                              |
| D/E. JAQK given a 1,000 limit and an exposure suspension, twice | `held`, reason `exposure_not_evaluable`; exactly one warning across both runs                                           |

**What happens at the first sweep after this applies:** both Midway clubs'
`union_club_terms.status` becomes `suspended`, with one critical alert each.
That is the union's configured rule, and it is the outcome that was being
silenced. Nothing else reads that status (only `fn_union_credit_risk_check` and
`fn_union_club_exposure`; nothing in either repo's application code), no chip
moves, and the receivables themselves are untouched: they remain Dan's decision.
The clubs resume automatically once nothing is past due.

## 2. The rake-basis refresh read past the accrual

`fn_accounting_union_earned_plan` refuses a window with any cash rake bank
receipt that has no accrual batch yet. Measured 04:08:56: 74,078 of the week's
89,297 receipts had no batch, and the first was banked at 09-22 17:38:25.193
with the settler's cursor at 17:38:25.144. The missing set is exactly the set
above the cursor. It tracks the settler: 84,594 at 03:35, 74,154 at 04:05,
70,735 at 04:27 as the cursor advanced (#5269 unstuck it).

It would not have converged to zero. Before the settler stuck, the same refusal
fired on 12 of 30 hourly runs on 09-21/22 with counts of 2 to 272: whatever was
banked between the settler's last page and :35. A snapshot through `now()` is
refused whenever the settler is not idle at that instant - a plateau.

Fix: the snapshot reads through `LEAST(p_end, now(), settler cursor)` and records
that instant in `through`. An unknown cursor, or one not yet in the week, is a
named outcome with no write. Probe: installed body refused
(`union_cash_sources_do_not_match_bank:70735`); new body succeeded through
09-22 18:29:21 with 10 basis rows; cursor behind the week ->
`accrual_not_yet_in_window`; no cursor row -> `accrual_cursor_unknown`. Nothing
reads `union_rake_basis_snapshot` except its writer (pg_proc, both repos).

The settler itself is catching up at roughly 3.5x real time (09-22 17:10 at
04:03, 18:29 at 04:25); about 82 hours of backlog remained at 04:25.

## 3. The period calculator read the club's lifetime

`fn_rakeback_recompute_periods` was reported at ~137 s of a 300 s budget. That
figure predates #5274 (71 s -> 17 s) and was inflated by lock queuing
(pg_stat_statements: mean 4.4 s, max 147.7 s over 2,645 calls). Measured now:
Deep Stack Society 09-21 11.2 s end to end (18.9-28.4 s under the 04:30 load),
JAQK 18.2 s, SHARK 21.2 s; certificate path at 1.4 days of sources 5.4 s + 0.9 s.

The one unbounded term: the evidence CTE `club_attributions` materialised every
attribution the club ever had (815,437 rows for DSS, +~95,000/day, never reset).
Its two readers join it to `week_records`, so the week slice is exact. Only that
CTE changed; the new body is generated from the installed prosrc by one
substitution (md5 4f1ce6d3... -> 80f40737..., both asserted).

Byte-identical proof:

- production, one REPEATABLE READ snapshot, rolled back: old and new bodies give
  identical receipts for DSS, JAQK and SHARK week 09-21 (JAQK 18.2 -> 13.8 s,
  SHARK 21.2 -> 13.6 s); for week 09-14 the new slice EXCEPT the old = 0 rows for
  all three clubs;
- the union weekly basis native cluster, run locally with this body installed:
  `period-coverage-regression` compared it with production's predecessors on all
  40 club-weeks (3 certified, 1 zero-entitlement): identical receipts and
  certificates, 86/86 steps passed.

## 4. Stranded single events

**66618f53 / 85c5885a (100 Chip Spin PLO4, 300.00) and 66e80c08 (20 Chip Spin
PLO5, 60.00).** Both COMPLETED at 03:29:35 / 03:29:41 through the engine's own
`fn_complete_tournament_terminal` (chip_ledger db_role postgres via PostgREST).
The serialized resolver returns the committed receipts: c.marino02 paid 300.00,
pocketShark paid 60.00, one `tournament_prize` row each, escrow closed at exact
zero (in 300 + 300 - 276 = out 300 + 24 burn; in 60 + 60 - 55.20 = out 60 +
4.80). Nothing to settle. Cause of the unknown outcome: `fn_complete_tournament_terminal`
takes the platform-wide finish lane (`ca:tournament-finish-lane:v1`, one finish
at a time by design) under a 45 s statement budget, while the engine client
gives up at 15 s. After the 02:00 restart the lane queue was long (postgres logs
02:28-02:31: repeated 55P03 lock timeouts in `fn_ca_lock_settlement_lane_for_finish`),
so every write attempt and the resolver lost their responses. The finish
committed later on its own path. Recommended engine change (not made here,
see report): the resolver call gets a deadline longer than the function's 45 s
budget, as the maintenance RPCs already do.

**34f66b95 / 7c6277e7 (Morning Free Buy).** It was closed at 03:04 with no
closure basis and the claim that the event was already restored. It is not:
table 244a2997 (7 players, 99,490 chips) has not dealt since 2026-09-19 14:04,
and the other two tables hold one player each. Chips conserve (338,000 on the
felt = 338,000 held by the 9 playing), the 283.80 prize is held in escrow. It
belongs to the dead-generation / idle-tournament work a sibling owns; reopened
with that note.

**92bfed04 (lease_proof_expired hand refusals).** Five refusals since 22:52:
hands 14595633 and 14595634 did commit (hand_history rows present); 14590223,
14596273 and 14628649 did not and were voided, and every later hand on those
tables committed. `fn_tournament_chip_conservation_check()` returns no finding
on the whole platform, so the voided hands moved nothing. The cause is lease
renewal lag in the engine's lease pass (GameServer, sibling-owned). Left open.

## 5. The owner's decision on 5330edb2 is written where it will be read

Incident 7ab0dcbe did not name the player: its metadata (overwritten on every
re-sight) held the first 20 absent-player rows and not event c7f21a83. Recorded
on `root_cause` and as an incident event: JulesSA (5330edb2, a horse),
registration d5f1a621, admitted by a satellite seat (45.00 prize + 5.00 fee) at
2026-09-22 14:08:23 into Sunday Funday Six-Card Closer, running since 09-21
04:00, never seated or chipped; seat-and-chip or refund is Dan's. The door that
caused it is fixed by `20260925205909`. Nothing was seated or refunded.
