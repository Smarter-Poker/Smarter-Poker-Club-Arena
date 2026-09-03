# 2026-09-02 - chip standard, Phase 1.1: bounties and refunds settle through the obligation function

Branch `fix/chip-std-p1-bounty-refund-payers`. Migration
`supabase/migrations/20260902222000_bounties_and_refunds_settle_through_obligations.sql`,
applied to production ONCE at 22:04:41 UTC (recorded by the MCP apply as
version `20260902220441`, name `20260902222000_bounties_and_refunds_settle_through_obligations`);
its post-apply DO block ran green (every named body settles through
`fn_settle_tournament_obligation`, none calls `credit_player_wallet(`,
`fn_credit_and_log(`, `log_wallet_transaction(`, `fn_add_chips(` or updates
`club_members`). No table, no trigger, no hot-table lock, no money moved by
migration.

Implements `docs/CHIP-ACCOUNTING-ROADMAP.md` Phase 1.1 and
`docs/CHIP-ACCOUNTING-STANDARD.md` 3.2 MTT steps 6 and 8 / rule R3 on the
DATABASE side: the eight functions that still credited a player from a
tournament directly now call the one settle function.

## What was observed before (SELECT-only, 2026-09-02 ~22:00 UTC)

Live use by `wallet_transactions` description shape, credits, 24h / 7d:

| Function                        | 24h            | 7d    | Last use  | Called by                                                                                       |
| ------------------------------- | -------------- | ----- | --------- | ----------------------------------------------------------------------------------------------- |
| `fn_collect_bounty`             | 581 / 3,168.21 | 4,899 | 21:49 UTC | engine, every knockout (`TournamentManagerEliminations.ts:1979`)                                |
| `atomic_cancel_tournament`      | 349 / 7,880.00 | 479   | 21:45 UTC | `fn_spin_expire_unfilled`, `fn_spin_reap_stale_boards` (all 349 were SPIN expiries, 174 events) |
| `fn_finalize_bounty_pool`       | 18 / 1,868.79  | 217   | 20:32 UTC | engine at finish (`:3223`, `:3705`)                                                             |
| `fn_mystery_bounty_pay`         | 9 / 130.60     | 132   | 21:39 UTC | engine on reveal (`:2696`), and `_settle`                                                       |
| `fn_mystery_bounty_settle`      | 5 / 88.40      | 52    | 21:40 UTC | engine at finish (`:2625`)                                                                      |
| `atomic_tournament_unregister`  | 0              | 3     | 08-30     | no caller in this repo (service_role only)                                                      |
| `fn_unregister_from_tournament` | 0              | 1     | 09-01     | web `TournamentService.ts:1130`                                                                 |
| `fn_leave_seat_and_refund`      | 0              | 1     | 08-29     | web `TablePage.tsx:7850`, `:21062`                                                              |

R3 log (`ca_money_path_violations`) in the six hours before apply: 108
bounty rows and 130 refund rows, all `money_path NULL`, all from these
functions; plus 126 `prize` rows from the pre-cutover engine that stopped at
20:57.

`tournament_payouts` evidence rows for bounties: every row with `source in
('bounty','own_bounty','mystery_bounty_residual')` (8,352 + 597 + 51) carries
`recorded_by = 'backfill_2026_08_31'` and the newest `paid_at` is 08-31. No
live path has written one since; the bounty evidence the audits read is the
`wallet_transactions` category `bounty` row.

### The phantom row, reproduced (rolled back, old body, PKO f56e23ae)

Knockout ec417979 (10.00 head, eliminated eae3996f by d88dfe5b) had already
been paid under key `tourney:f56e23ae:bounty:eae3996f:d88dfe5b`. Inside a
transaction: delete its `tournament_bounties` row, restore the head, give the
pool room, call `fn_collect_bounty`:

```
wt_rows_before            33
synthetic_first           {"ok": true, "mode": "pko", "paid_cash": 5.00, "added_to_head": 5.00, ...}
wt_rows_after_synthetic   34        <- a 5.00 'bounty' credit row was written
idem_key_spent_already    1         <- the key was already spent: credit_player_wallet paid nothing
violations_new            1
```

Same shape on `fn_finalize_bounty_pool` (Afternoon Bounty db607c3a, champion
7f348e8f, pool raised by 7 inside the transaction): `finalize_first` reported
`residual 7.00`, the ledger went 23 -> 24 rows, the `ownbounty` key was
already spent so the champion received nothing, and the second run read
`ledger_paid 76.00` on a 76.00 pool: the 7.00 was booked as paid and never
paid (standard 2.6, "a second run with a larger residual pays nothing").

## What changed

Every credit in the eight functions is now
`fn_settle_tournament_obligation(tournament, kind, NULL, user, TOTAL, source, description)`:

| Function                        | Kind              | TOTAL passed                                                                   | On refusal                                                                                  |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `fn_collect_bounty`             | `bounty`          | obligation `amount_paid` (0 if none) + this claimant's cash share              | RAISE (whole knockout rolls back)                                                           |
| `fn_finalize_bounty_pool`       | `bounty_residual` | obligation `amount_paid` + residual (both branches)                            | RAISE                                                                                       |
| `fn_mystery_bounty_pay`         | `mystery_bounty`  | obligation `amount_paid` + chest amount, per recipient                         | recipient left unpaid, award incomplete, critical alert (as before)                         |
| `fn_mystery_bounty_settle`      | `mystery_bounty`  | obligation `amount_paid` + unclaimed residual                                  | RAISE before the chests are voided                                                          |
| `atomic_cancel_tournament`      | `refund`          | GROSS entry debits (buy-in + fee, rebuys, add-ons); settle seeds prior refunds | skipped; deferred `tournaments_cancel_must_refund` refuses the cancel at commit (as before) |
| `atomic_tournament_unregister`  | `refund`          | `p_refund_amount` + refund credits already on the ledger                       | RAISE before the registration is deleted                                                    |
| `fn_unregister_from_tournament` | `refund`          | `fn_tournament_entry_split.charge` (buy-in + fee, S13) + prior refund credits  | RAISE before the registration is deleted                                                    |
| `fn_leave_seat_and_refund`      | `refund`          | same as above                                                                  | RAISE before seat/registration change                                                       |

Why "obligation paid + this award" rather than a ledger-derived total: the
settle function seeds a NEW obligation only for `place` and `refund`. Passing a
ledger sum for a bounty kind would have double-paid every player who had
already collected under the old key in an event still running at apply time
(the first obligation row would start at `amount_paid 0`). With the
obligation's own `amount_paid` as the base, a fresh award pays exactly the
award, a replay of the same total pays 0, and the legacy credits of an
in-flight event stay outside the obligation instead of being re-paid.

Kept verbatim: split-pot claimant validation and the cent-exact remainder
rule, PKO half-to-head, the hybrid tripwire, the mystery-phase gate,
`bounty_pool_paid` accounting, every refusal reason, every description
string, every return key, every grant.

Behaviour changes beyond the payer:

1. The bounty paths now honour the payout kill switch (`ca_payout_freeze`):
   `payout_frozen` is the only refusal the settle function can return for
   these kinds, and the paths RAISE on it so nothing is half-recorded. Before,
   a freeze did not touch bounties at all.
2. The unregister and seat-release refunds settle BEFORE the registration
   row is deleted, so the key `tourney:<t>:obl:...` resolves
   `tournament_players.club_id` (the club charged) instead of the home-club
   fallback. Probe: the refund landed in the buy-in club on every path below.
3. A refund obligation is cumulative per user, so a player who unregisters,
   re-registers and unregisters again is paid again (probe below: owed 10 ->
   20), and a replay of the same total pays 0.
4. `fn_collect_bounty` raises if the settle function paid a different amount
   than the share (cannot happen by construction; it is the conservation
   assert the old body lacked).
5. No `tournament_payouts` row is written for bounty kinds (decision: none
   was being written live since 08-31; the settle path's `wallet_transactions`
   `bounty` row is what `fn_finalize_bounty_pool`, `fn_mystery_bounty_settle`
   and `fn_ca_tournament_escrow.bounty_out` read, so their arithmetic is
   unchanged and the backfilled rows stay as history).

## Probes after apply (every one inside BEGIN ... ROLLBACK)

(a) + (b) + (e) `fn_collect_bounty`, PKO f56e23ae (Union PKO Afternoon PLO4,
completed 17:19 UTC), knockout ec417979, collector d88dfe5b:

```
wt_rows_before                33
replay_result                 {"ok": false, "reason": "already_collected"}
wt_rows_after_replay          33
synthetic_first               {"ok": true, "head": 10, "mode": "pko", "split": false, "capped": false, "funded": true,
                               "shares": [{"cash": 5.00, "to_head": 5.00, "user_id": "d88dfe5b..."}],
                               "paid_cash": 5.00, "added_to_head": 5.00, "pool_remaining": 5.00}
wt_rows_after_synthetic       34
collector_balance             a0000000 (buy-in club) 27121.41 -> 27126.41; other clubs unchanged
obligation                    bounty owed=5.00 paid=5.00 source=fn_collect_bounty
new_wt_row                    5.00 bounty "PKO bounty (cash half) from eliminated player"
violations_new                0
synthetic_second              {"ok": false, "reason": "already_collected"}
settle_replay_same_total      {"ok": true, "paid": 0, "already_paid": 5.00, ...}   -> wt rows still 34
result_keys (before = after)  added_to_head,capped,funded,head,mode,ok,paid_cash,pool_remaining,shares,split
```

Split pot (weights 2:1, same knockout): `paid_cash 4.99`, `added_to_head 5.01`,
two ledger rows 1.66 / 3.33 "(split pot, 2 winners)", two obligations
1.66 / 3.33, 0 violations. A second knockout for the same collector then
paid exactly 5.00 more and the obligation read owed=8.33 paid=8.33.

(c) `fn_finalize_bounty_pool`, Afternoon Bounty db607c3a, champion 7f348e8f:

```
finalize_replay        {"ok": true, "funded": true, "residual": 0.00, "ledger_paid": 69.00}
(pool +7)
finalize_first         {"ok": true, "funded": true, "paid_to": "7f348e8f...", "residual": 7.00, "ledger_paid": 69.00}
wt rows                23 -> 24;  champion a41434bb 51707.89 -> 51714.89
obligation             bounty_residual owed=7.00 paid=7.00
finalize_second        {"ok": true, "residual": 0.00, "ledger_paid": 76.00}   wt rows still 24
(pool +3, the larger-residual case)
finalize_larger        {"ok": true, "residual": 3.00, "ledger_paid": 76.00}
obligation_after       bounty_residual owed=10.00 paid=10.00;  bounty_pool_paid 79.00 of 79.00;  violations 0
```

Mystery, Union Mystery Bounty 20d317f2, champion 13f916ec:

```
pay_replay             {"ok": true, "already": true, ...}
(award 73c5b931 re-opened as revealed, pool +12)
pay_first              paid_cents 1200, refused_recipients 0;  pay_second  {"already": true}
wt rows                36 -> 37;  champion a0000000 36132.13 -> 36144.13
obligation             mystery_bounty owed=12.00 paid=12.00
(chest 5e13822c re-opened as available, pool +13)
settle_first           residual_paid_cents 1300;  settle_second  unclaimed_cents 0, residual_paid_cents 0
wt rows                37 -> 38;  champion 36144.13 -> 36157.13
obligation_after       mystery_bounty owed=25.00 paid=25.00;  violations 0
```

(d) refunds. `atomic_cancel_tournament` on REGISTERING spin ae9bc48f (20.00,
two entrants, run with `request.jwt.claims` role service_role as the cron does):

```
cancel_result          {"success": true, "refunded_count": 2, "total_refunded": 40.00, "fees_reversed": 0}
balances               ecd88691 @ a0000000 24946.96 -> 24966.96;  348341bd @ a41434bb 32785.08 -> 32805.08
                       (each in the club on their tournament_players row; the other clubs unchanged)
obligations            two rows refund owed=20.00 paid=20.00 source=atomic_cancel_tournament
refund_rows            2 x 20.00 "Tournament cancellation refund: 20 Chip Spin PLO4";  violations 0
settle_replay          {"ok": true, "paid": 0, "already_paid": 20.00}  -> still 2 rows
still_owed_per_trigger 0   (the deferred cancel-must-refund arithmetic)
```

`fn_unregister_from_tournament` as player a70a0d4c on Union Late Night Turbo
6b882476 (9.00 + 1.00 fee):

```
unregister_first       {"ok": true, "refunded": 10.00, "registration_id": "5e01d6a2..."}
balance                a0000000 849804.78 -> 849814.78;  pool 306 -> 297, rake 34 -> 33
obligation             refund owed=10.00 paid=10.00 source=fn_unregister_from_tournament
unregister_replay      {"ok": false, "reason": "not_registered_or_seated"}
settle_replay          paid 0, already_paid 10.00
(re-register, unregister again)
unregister_after_rereg {"ok": true, "refunded": 10.00};  obligation owed=20.00 paid=20.00;  balance 849824.78
fee_reversals          -1.00 | -1.00;  violations 0
```

`fn_leave_seat_and_refund` as seated player 0f14f372 on NLH Heads-Up 20 Turbo
ca3dce66 (19.00 + 1.00): `refunded 20.00`, balance a41434bb 343526.09 ->
343546.09, obligation refund 20/20, one ledger row "Seat released: NLH
Heads-Up 20 Turbo (full refund)", one `chip_transactions tournament_refund`
row in the same club, replay `not_seated`, settle replay paid 0, violations 0.

`atomic_tournament_unregister(6b882476, 9bd731a9, 10.00)` as service_role:
`true`, balance a0000000 41904.88 -> 41914.88, obligation refund 10/10,
replay `false`, violations 0.

The managed-game lifecycle guard refuses `atomic_cancel_tournament` for a
non-engine caller once a player has registered (`fn_guard_managed_game_lifecycle`),
which is why the cancel probe carries the service_role claim; that guard is
untouched.

## Live since apply (22:04:41 UTC)

At 22:09:45 UTC: 11 real engine knockouts had settled `bounty` obligations
through `fn_collect_bounty` (75.00), 24 bounty credit rows in 20 minutes, and
the newest `ca_money_path_violations` row was 22:04:27 (pre-apply). The R3
log now receives NOTHING from the eight functions by construction (the settle
function stamps `app.money_path` around the credit).

## Remaining R3 violators

Zero engine or cron paths remain. The writers lane 3 listed as "will log
forever unless re-pointed" were exactly these eight plus
`atomic_credit_wallet_and_log` (bounty/refund categories by direct insert).
`atomic_credit_wallet_and_log` is called live only by
`server/src/engine/ServerTableEngineSeating.ts:340` for a CASH-table add-on
refund (category not a tournament one, so the WHEN clause keeps it out of the
log); nothing calls it with a `bounty`/`refund`/`prize` category today. Watch
`ca_money_path_violations` for 24h: an engine row now means a caller this
audit did not see.

## Tests

- `tests/law/BountiesAndRefundsSettleThroughObligations.law.test.ts` (31
  pins, each negative-controlled against the last repo body of the same
  function) + `docs/LAWS.md` row; `tests/law-registry.law.test.ts` 53 passed.
- Server: `moneyPathAudit.guard`, `bountyPoolConservation.guard`,
  `mysteryBountyChestDoubleSpend.guard`, `mysteryBountyPool`,
  `mysteryBountyPoolCap`, `mysteryBountyActivation`, `mysteryBountyDraw`,
  `mysteryBountyTopPercent`, `OneSettlePathForTournamentMoney.law` - see PR
  body for the run.
- No TypeScript touched. Root `tsc --noEmit` run for the new test file.

## Phase 3 delete-list candidates (from this lane's measurements)

None of the eight had ZERO use in 7 days, so none was left untouched; all are
re-pointed. The three that are nearly dead, for the 3.3 gate:

- `atomic_tournament_unregister` - 3 uses in 7d (last 08-30), no caller in
  this repo, takes the refund amount from the caller. Already on the 3.3 list.
- `fn_leave_seat_and_refund` - 1 use in 7d (08-29); web callers exist
  (`TablePage.tsx`). Already on the 3.3 list.
- `fn_unregister_from_tournament` - 1 use in 7d (09-01); the web's only
  unregister path. Keep.

## Log-only / not built

- Nothing in this lane refuses a payment that was paid before, except under an
  open `ca_payout_freeze`, which by design refuses every tournament payment
  and is Dan-operated.
- Not built: seeding bounty obligations from the legacy key shapes
  (`tourney:<t>:bounty:<elim>:<uid>`, `:ownbounty:`, `mb:<award>:<uid>`,
  `mb-residual:<t>`) inside `fn_settle_tournament_obligation`. It would make
  the obligation the full per-player bounty total for events that straddle
  the cutover, but it means editing the hottest function while other lanes
  hold it, and the cumulative-from-the-row design does not need it.

## Decisions that are Dan's

1. R3 from log to refuse (roadmap 1.4): the eight re-pointed paths give the
   R3 log its first chance at 24h of zero engine rows. Flip is Dan's.
2. The engine's own cancel refund (`tournamentRecovery.ts:157`, Lane A2)
   passes the NET amount (debits minus refunds already given) as the `refund`
   obligation total, while the settle function seeds `amount_paid` from those
   same refund credits. When a prior partial refund exists it under-pays by
   that amount; when none exists (the normal case) it is exact. One-line fix
   (pass the gross) in TS; not this lane's file, flagged for the orchestrator.
3. Whether `atomic_tournament_unregister` (caller-supplied refund amount,
   service_role only, 3 uses a week from outside this repo) should be revoked
   now rather than at the 3.3 gate.
