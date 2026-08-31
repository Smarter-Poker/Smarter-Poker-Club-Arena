# The treasury had no ledger, and a trigger was inventing one

2026-08-31

`reconcile_ledger_nightly`'s `club_treasury` check had been permanently
critical, and the drift GREW with table volume rather than with anything anyone
did to a treasury: 30.5M to 41.7M in twelve hours. Three separate causes, three
migrations.

## 1. `20260831_ledger_trigger_stops_inventing_the_treasury.sql`

`public.fn_club_members_ledger_writer()` is the ONLY writer of `chip_ledger` in
the entire database. It fires `AFTER UPDATE OF chip_balance` on `club_members`
and it guessed the other side of every trade:

    from_type := CASE WHEN d > 0 THEN 'club_treasury' ELSE 'player_wallet' END
    to_type   := CASE WHEN d > 0 THEN 'player_wallet' ELSE 'club_treasury' END

It never read `clubs.chip_treasury`. `atomic_table_buyin` and
`atomic_seat_cashout_locked` move chips between `club_members.chip_balance` and
`table_seats.stack`; the treasury is not on either side and is never touched.
So every buy-in was journaled as a phantom treasury INFLOW and every cash-out
as a phantom OUTFLOW. 62,495 of Club JAQK's 62,499 treasury ledger rows were
these inferences.

The counterparty is now DECLARED, never inferred:

    PERFORM set_config('app.ledger_counterparty', 'club_treasury', true);
    PERFORM set_config('app.ledger_counterparty_entity', club_id::text, true);

Undeclared defaults to `table_stack`, which is what a `chip_balance` delta
almost always trades with here. `table_stack` is a new member of the
`chip_ledger` from_type/to_type domain -- without adding it the trigger's
INSERT would have failed the CHECK, fallen down the retry ladder and landed in
`ca_ledger_write_failures`, i.e. it would have DELETED the audit trail rather
than corrected it. So the constraint change is in the same migration.

Everything else about the trigger is verbatim, including the properties that
matter most on the hottest money path: it still cannot raise, it still cannot
block a chip movement, and a terminal failure is still swallowed into
`ca_ledger_write_failures`. The category retry ladder gained a third rung for
the same reason it had a second one -- A LABEL MUST NEVER COST THE ROW ITS
EXISTENCE, and now neither may a counterparty.

History was NOT rewritten. Every existing row stands.

## 2. `20260831_journal_the_real_treasury_writers.sql`

23 functions write `clubs.chip_treasury`. Zero wrote `chip_ledger`. After
migration 1 the treasury therefore had an honest but EMPTY ledger. The four
with real volume now journal:

| function                       | movement                       | live volume                                      |
| ------------------------------ | ------------------------------ | ------------------------------------------------ |
| `fn_horse_fund_from_treasury`  | `club_treasury -> table_stack` | 9,076,675 chips over 20,806 calls for one club   |
| `fn_horse_seat_from_treasury`  | `club_treasury -> table_stack` | the same movement through the other door         |
| `credit_club_rake_to_treasury` | `table_stack -> club_treasury` | rake credited direct                             |
| `atomic_distribute_rake`       | `table_stack -> club_treasury` | the `v_route = 'club_chip_treasury'` branch only |

`fn_horse_seat_from_treasury` was not in the brief. It was included because it
is the same money movement as `fn_horse_fund_from_treasury` by a different
door -- one creates the seat, the other tops it up -- and journaling one and
not the other would put a hole in the ledger the exact shape of which door the
engine happened to use.

Every ledger INSERT is wrapped in its own `BEGIN / EXCEPTION WHEN OTHERS` that
logs to `ca_ledger_write_failures` and swallows, mirroring the trigger. That is
the whole point: A RECORD OF THE MONEY MOVING MUST NEVER BE ABLE TO STOP THE
MONEY MOVING. The `atomic_distribute_rake` insert sits inside the `leg_key`
first-claim guard, so a replayed hand credits once and journals once.

HORSES ARE PLAYERS (CLAUDE.md 10.5). No `is_horse` branch was added anywhere;
a post-apply assertion fails the migration if one appears in any of the four.
The two horse functions are horse PLUMBING -- the engine supplying what a
browser would -- which is the one sanctioned kind of horse branch, and nothing
here gives a horse a different deal.

## 3. `20260831_treasury_baseline_and_reconcile_from_the_line.sql`

The check compared an ALL-TIME sum of ledger movement against an ALL-TIME
stored `chip_treasury`, when the earliest ledger row is 2026-08-27. Four days
of flow against forever. It was never going to be zero.

The player-wallet pool solved exactly this on 2026-08-26
(`20260826_baseline_the_unledgered_gap.sql`): what cannot be reconstructed is
WRITTEN DOWN rather than invented, and reconciliation runs forward from the
line. `ca_treasury_baseline` is that, for the treasury:

| club       | opening balance | ledger at baseline | unledgered gap |
| ---------- | --------------- | ------------------ | -------------- |
| `a41434bb` | 1,376,610.47    | -7,073,839.25      | 8,450,449.72   |
| `a0000000` | 1,051,788.71    | -32,171,602.52     | 33,223,391.23  |
| `fade0000` | 0.00            | -9,766.78          | 9,766.78       |

The line is drawn AFTER migrations 1 and 2 on purpose. Drawn before them it
would have been a line under a lie, and every row after it would have kept
lying.

Only the `club_treasury` CTE of `reconcile_ledger_nightly` changed.
`frozen_wallets_pool`, `insurance_bank`, `insurance_offer_unresolved`,
`seat_stack_exit`, `chip_circulation`, `cashout_escrow_stuck`,
`negative_balance`, `over_claimed_send` and `bomb_award_ledger_gap` are
reproduced byte-for-byte, and a post-apply assertion fails the migration if any
of them goes missing. THE SEVERITY THRESHOLDS ARE UNCHANGED -- 0 is ok, <= 1.00
is warn, more is critical. Widening them to manufacture a pass would be the
same class of mistake as the one being fixed.

## Result

|                      | before          | after                                                 |
| -------------------- | --------------- | ----------------------------------------------------- |
| `club_treasury` rows | 3, all critical | 2, all `ok`, drift 0.00                               |
| worst treasury drift | 33,248,242.62   | 0.00                                                  |
| second worst         | 8,467,853.85    | 0.00                                                  |
| third                | 9,766.78        | not checked -- 0 stored, 0 flow, nothing to reconcile |

The 7 remaining criticals in the run are `bomb_award_ledger_gap`, which predate
this work and are untouched by it.

## Verification

Every probe was run inside a transaction that was ROLLED BACK by a terminal
`RAISE EXCEPTION` (CLAUDE.md 11.5 -- never spend real chips to test a rule).
No chips moved. `ca_ledger_write_failures` is still empty.

- club_members trigger, credit: exactly 1 row, `table_stack -> player_wallet`
- club_members trigger, debit: exactly 1 row, `player_wallet -> table_stack`
- `fn_horse_fund_from_treasury(5)`: 1 row, `club_treasury -> table_stack`, `cat=buyin`, table_id stamped
- `credit_club_rake_to_treasury(7)`: 1 row, `table_stack -> club_treasury`, `cat=rake`
- `atomic_distribute_rake` forced down the treasury route: 1 row, `table_stack -> club_treasury`, `cat=rake`, hand_id stamped

Live production traffic confirms the cutover in the data: phantom
`* -> club_treasury` trigger rows stop dead at 10:36:54 UTC, the moment
migration 1 landed, and every subsequent buy-in is journaled against the felt.

## What is NOT fixed, honestly

Only 4 of the 23 functions that write `clubs.chip_treasury` journal. The
`club_treasury` check reads `ok` today because no treasury moved through one of
the other 19 since the cutover. The first time `fn_club_bank_send`,
`fn_mint_club_chips`, `fn_union_send_to_club_atomic`, `fn_member_leave_to_treasury`,
`fn_credit_treasury`, `fn_debit_treasury`, `decrement_club_treasury`,
`fn_apply_prize_guarantee`, `fn_admin_remove_player_chips`, `fn_club_bank_claim_back`,
`fn_club_bank_reverse`, `fn_close_club_wallets_on_union_join`,
`fn_leave_club_atomic`, `fn_mint_chips_from_diamonds`, `fn_seed_horses_to_floor`,
`fn_union_clawback_from_club`, `fn_union_promo_send`, `fn_union_settle_player_pnl`
or `fn_wallet_claim_back` moves money, this check will go critical again.

THAT IS THE CHECK WORKING. It will now name a real unjournaled writer instead
of drowning in phantom buy-ins. The fix is to journal that writer, not to move
the baseline again.

Two other observations worth writing down:

- `atomic_distribute_rake`'s `club_chip_treasury` branch is DORMANT in
  production today. All 3 clubs carry a `union_id` and no table is private, so
  every hand routes to `union_rake_wallet`. The journaling was still added and
  proved by forcing the route in a rolled-back probe, because the branch is one
  private table away from being live.
- The baseline snapshot takes `FOR UPDATE` on `clubs` to serialise against the
  treasury writers. A transaction that started before the baseline and commits
  after it could still contribute a ledger row stamped before the line while
  its treasury delta lands after the snapshot. The exposure is sub-second and
  worth at most a few chips of rake; it is recorded here rather than papered
  over.
