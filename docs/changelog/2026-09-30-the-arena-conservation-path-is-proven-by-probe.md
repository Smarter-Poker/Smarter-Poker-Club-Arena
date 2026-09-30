# The Diamond Arena's conservation is unexercised, and proven by probe

**2026-09-30.** `poker_diamond_custody` and `poker_diamond_movements` are both
empty, Diamond Arena cash games are switched off
(`ca_arena_settings.cash_games_enabled = false`, 0 open tables), and so every
figure phase 4 publishes is structurally zero: `in_play`, `arena_seats`,
`arena_entries`, `fn_ca_arena_diamonds()`. `fn_diamond_arena_reconciliation`
returns `balanced: true` for every player **vacuously**, and all four of its
unmatched detectors return no rows platform-wide.

A phase that reports no fault while it has never run reports nothing. So the
path was exercised end to end inside one transaction that was rolled back
(CLAUDE.md 11.5: one `execute_sql` call, one self-aborting `DO` block, the
error is the success case). **No diamond moved. Nothing committed.**

**The finding: the path is sound.** Two buy-ins, a settled hand that moved 30
diamonds between two seats, and two cash-outs all behaved correctly, and the
supply identity held at every step.

## What the probe did

Two fixture wallets (`00000000-0000-0000-0000-%`, no purchase lots, no open
debts, no live seats), one empty plain NLH 1/2 arena table, 100 diamonds each.
`cash_games_enabled` was flipped true inside the transaction and rolled back
with everything else.

The real doors were called, not reimplementations: `fn_poker_diamond_buyin` ->
`fn_poker_diamond_reserve`, then `fn_poker_diamond_settle_cash_hand`, then
`fn_poker_diamond_cashout` -> `fn_poker_diamond_release`.

## What it measured, exactly

| reading                        |    before | after 2 buy-ins | after the hand | after 2 cash-outs |
| ------------------------------ | --------: | --------------: | -------------: | ----------------: |
| wallet A                       |       380 |             280 |            280 |           **410** |
| wallet B                       |       300 |             200 |            200 |           **270** |
| custody rows                   |         0 |               2 |              2 | 2 (both released) |
| custody balance total          |         0 |             200 |            200 |             **0** |
| movement rows                  |         0 |               2 |              2 |             **4** |
| arena float                    |         0 |             200 |            200 |             **0** |
| all player holdings            | 6,853,624 |       6,853,424 |      6,853,424 |     **6,853,624** |
| `fn_ca_mint_supply(diamonds)`  | 6,853,624 |       6,853,624 |      6,853,624 |     **6,853,624** |
| **supply identity difference** |  **0.00** |        **0.00** |       **0.00** |          **0.00** |

- **Custody and movements are written.** Two `reserve` rows of 100, each
  carrying its wallet journal id; then one `release` of 130 and one of 70,
  each carrying its own. Custody opened `active` at 100 apiece and closed
  `released` at 0.
- **Conservation holds across the buy-in.** 200 left the wallets and 200
  appeared in the arena float; the Mint's supply did not move, because a
  deposit is a transfer and not issuance. `register_followed_arena_leg` was
  **0** at every step, which is the intended behaviour: the register must not
  follow `arena_deposit` or `arena_withdraw`, or it would burn the float on
  the way in and mint it on the way out.
- **Conservation holds across the hand.** 30 moved from seat B to seat A.
  Custody followed the seat exactly (130 / 70 against stacks 130 / 70), the
  wallets did not move, and the arena float stayed at 200. The settle door
  refuses a roster whose deltas do not sum to zero, and reported
  `conservation_checked: true`.
- **Conservation holds across the cash-out.** A took 130 and B took 70. A
  ended at 410 (380 + 30) and B at 270 (300 - 30), exactly the hand result.
  The float returned to 0 and total holdings returned to 6,853,624.
- **The statement stops being vacuous and starts being right.** Before: 0
  sessions, `balanced: true` with nothing to check. After: A reads sessions 1,
  buy_ins 100, cash_outs 130, in_play 0, `net_result_settled` **+30**; B reads
  buy_ins 100, cash_outs 70, `net_result_settled` **-30**. The two settled
  results sum to zero.

## The detectors were made to fire

A reconciliation that has never reported a fault is not evidence that it can.
Two of its four unmatched conditions were broken deliberately inside the same
rolled-back transaction:

| break                                                                | reported                                     |
| -------------------------------------------------------------------- | -------------------------------------------- |
| a movement row whose amount disagrees with its wallet journal row    | `reserve_amount_mismatch`, `balanced: false` |
| a live cash seat whose custody balance is nudged away from the stack | `seat_stack_drift`, `balanced: false`        |

The other two were not reached, and that is worth saying rather than implying
coverage. `release_movement_missing` needs a release movement deleted and
`journal_missing` needs a journal row deleted;
`poker_diamond_movements_append_only` refuses both. `journal_missing` is still
reachable in production through the account-deletion door, which archives
journal rows.

## What did NOT need fixing

`fn_diamond_arena_reconciliation` returning `balanced: true` for a player with
no sessions is a signal answering when it has nothing to check (CLAUDE.md
10.86 rule 1), but it never reaches a player as a claim: the only consumer,
`DiamondArenaStatement.tsx`, branches on `statement.sessions === 0` and prints
"No Diamond Arena Sessions Yet" instead of "Every Session Reconciles". That
branch was unpinned, and is now pinned by
`tests/the-register-is-a-supply-ledger.law.test.ts`.

The RPC's shape was left alone on purpose. Adding a field would have pulled in
`tests/the-route-and-the-client-agree.law.test.ts` (every returned key must be
read by the client or listed as unread) and the wallet UI, for a defect the
client already handles.

## Honest limits of this proof

- It was run against **an empty arena at rest**. It proves the doors and the
  arithmetic, not behaviour under concurrency, under a real engine dealing
  hands, or with purchased lots inside the 14-day settlement window (the
  fixtures deliberately had no lots, so the DR16 refusal path was not
  exercised here).
- Tournament entry custody was not exercised; only the cash seat.
- `cash_games_enabled` remains **false** in production. Nothing about this
  changes that, and turning the arena on is the owner's switch.

So: **unexercised in production, and proven sound by probe.** No code changed
for this finding, because nothing was broken.
