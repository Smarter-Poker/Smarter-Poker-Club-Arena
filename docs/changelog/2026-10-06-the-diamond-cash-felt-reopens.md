# The Diamond cash felt reopens (2026-10-06)

## What happened

Dan opened Diamond cash games for his certified run early on 2026-10-06.
`20261006021858_the_arena_cash_switch_returns_to_closed` closed them again by
mistake: its author could not trace who had opened the switch. Later that day
Dan approved reopening them ("YES, GO AHEAD AND PROCEED") once the rake path
was live and a Diamond cash hand was proved to settle.

The engine already sent the settler's three rake facts (#6268) and priced a
Diamond hand by the owner's settings (#6288); the engine serves release
`9fdbf692`, which contains both. The proof was run next, and it failed.

## The proof, and what it found

One real NLH 1/2 hand was played by the engine's own `HandController` under
production's `ca_diamond_economics` rows and handed to the engine's own
`postHandTasks` and `logHandHistory`. Their exact request (pot 400, flop seen,
rake 15, the three facts on both seats, a null chip rake obligation) was
replayed against production in one rolled-back transaction, with cash opened
only inside it: two 200-Diamond buy-ins through `atomic_table_buyin`, a lease
through `claim_table_lease_v2`, a hand number from `fn_next_hand_number`, then
the engine's two calls, `fn_ca_retain_hand_submission` and
`fn_ca_commit_hand_submission`.

Everything accepted it, including the Diamond settler, which recomputed the
same 15. Then the 12-argument door refused the whole hand:
`atomic hand commit refused (post_commit_fee_mismatch)`.

## The cause

`fn_ca_commit_hand_settlement` had two rules that contradict each other for
every raked Diamond cash hand. Its Diamond refusal requires the chip rake
object (`p_post_commit_obligations->'rake'`) to be null, because that object
drives the chip rake leg a Diamond must never reach. Its fee binding required
`p_rake > 0` to come with that object. Before #6288 every Diamond hand had
`p_rake = 0`, so the contradiction was unreachable. With cash open, every
Diamond hand reaching a flop with a rakeable pot would have been refused after
it was played.

## The fix

`20261006154344_a_raked_diamond_cash_hand_passes_the_commit_door` wraps the
seven chip-rake clauses in `NOT v_diamond` and states the Diamond rule (the
null chip object) in the same check. A chip hand, and every tournament hand,
is bound exactly as before. A Diamond hand's rake is bound where it is settled:
`fn_poker_diamond_settle_cash_hand` recomputes it from the owner's settings,
refuses any other number and accrues it per payer in the same transaction. The
live body is edited in place at two md5-pinned anchors.

With the fix applied inside the same rolled-back rehearsal, the hand settled:
rake 15 accrued 8 and 7 to its payers by contribution, stacks 0 and 385 in
custody, receipts written, the hand projected, both players cashed out to
their wallets (2500 to 2300 and 2500 to 2685), no chip rake or chip ledger row
touched, and the sweep banked the 15 to `ca_diamond_house`, the destination
the owner settings name. The Diamond identity read 0 at every step.

`tests/a-raked-diamond-cash-hand-passes-the-commit-door.law.test.ts` pins it.

## The switch

`20261006154844_the_diamond_cash_felt_reopens` sets `cash_games_enabled` back
to true, mirroring the file that closed it: one row, one column, tournaments
required open before and after. It refuses to run unless the door fix is
live, and it is applied only after the fix has been applied and verified.
