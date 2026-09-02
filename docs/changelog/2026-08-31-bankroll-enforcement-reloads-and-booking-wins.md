# 2026-08-31 — Bankroll enforcement: the reload, and actually booking the win

The bankroll layer shipped earlier today gated SEATING. This audits every
other place a horse can commit chips and closes the two that were live leaks.

## The reload was the leak

`HorseSessionRotator` topped a short stack back to a full buy-in every 90s
cycle, at 25% probability, for any horse under 45% of a buy-in — wallet
funded, **with no reference to the bankroll at all**. It is the single
easiest way to lose a roll, and it is exactly what Dan asked to prevent:
"not risk more of their stack than they should."

A reload is a fresh commitment to a table the horse is ALREADY losing at, so
`topUpAllowance` holds it to a stricter test than the original seat:

- the roll must still cover the stake **after** paying — a reload that drops
  a horse under its own sit bar is the reload that turns a bad session into
  a bust;
- total exposure to one table cannot walk past the single-buy-in share **one
  reload at a time**;
- a horse already down its stop-loss does not reload at all. It leaves.

## Booking a win was never wired

`sessionVerdict` shipped tested and **nothing called it**. The rotator left
on a probability curve over `stack / (bb * 100)` — an _assumed_ buy-in. A
horse that sat short and doubled did not register as a winner; one that
bought in deep and was stuck looked healthy.

Session P&L is the honest measure, and it is now read exactly, from
`chip_ledger` — which already records every buy-in and top-up with a
`table_id` and a timestamp. **No money path was touched to obtain it**, and
no column was added to `table_seats`.

When the figure is available the policy decides and the departure is
**certain, not probabilistic** — booking a win is a decision a player makes,
not a coin they flip.

## Aggregate exposure

`canSit` is evaluated per table, so it answers identically for the first
table and the fourth: four tables at a 5% share each is a fifth of the roll
in play. `canOpenAnotherTable` caps live exposure at three single-table
shares — enough to multi-table normally, short of the point where one bad
run across four tables is the bankroll. Currently latent (the floor runs one
table per horse) and will bind the moment the micro games widen the floor.

## Two failure modes, both deliberate

**Failing open.** A rotator that mistakes "the ledger did not load" for
"this horse is stuck" would empty the floor. Every rule degrades to the
pre-bankroll behaviour when its input is missing.

**The silent miss.** The roll is keyed `${club_id}:${user_id}`, and the seat
query did not select `club_id` — every lookup would have missed, disabling
the cap **without failing anything**. Caught before shipping, and pinned: a
test now asserts the column is in the select, and removing it fails.

## Verification

- tsc clean both roots; services **626 tests / 56 files**, engine
  **1,502 / 133**.
- 13 new pins (43 across the bankroll suites).
- **Six mutations, every one caught**: stop-loss no longer blocking a reload,
  per-table ceiling removed, the post-reload sit check removed, aggregate
  ceiling removed, the top-up cap unwired, and `club_id` dropped from the
  seat select.

## Still open, and why

- **Rebuys fund from the club treasury** (`autoRebuyHorse` ->
  `fn_horse_fund_from_treasury`), so busting a cash game never touches the
  horse's own roll. After the reset this is the largest remaining
  correctness gap — a horse cannot truly go broke while the treasury
  refills it. It is a money-path and chip-conservation change, so it is
  Dan's call, not an agent's.
- **Tournament entry has solvency but no discipline.** `fn_register_horse_
for_tournament` refuses only on `insufficient_balance`, so a 1,000-chip
  horse can enter a 950 event. Needs a buy-ins-covered rule.
- **Broke horses are not routed to freerolls.** Twelve are live; nothing
  registers a broke horse into one. The rakeback rail, by contrast, already
  works — 1,012 of 1,014 payouts have gone to horses.
