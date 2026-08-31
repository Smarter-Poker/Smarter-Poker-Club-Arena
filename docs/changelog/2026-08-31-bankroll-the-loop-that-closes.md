# 2026-08-31 — Closing the bankroll loop: tournaments, reloads, freerolls, and a dead minting path

The layer shipped earlier today gated cash SEATING and cash RELOADS. Three
other ways a horse could commit chips were still ungated, one number the fleet
depends on could never come down, and a retired money path was still sitting in
the schema pointed at the wrong chip pool.

## 1. The dead path that would have made the reset invisible

`atomic_seat_horse` debited **`public.wallets`** — the pool CLAUDE.md 11.5
records as frozen since 2026-08-21, "nothing reads it", and which ends with:
_"If you find a money path writing to it, that path is broken."_

It matters because of what happens today. The reset lands on
`club_members.chip_balance` — the pool `atomic_table_buyin` debits, every
cash-out credits, and every bankroll rule reads. `atomic_seat_horse` reads
neither. **The 584 horses hold an average of 1,229,703 chips each in the legacy
pool (718,146,564 in total)**, so anything reaching that function would have
seated a "10,000-chip" horse in any game on the board.

It was dead — no TypeScript caller, no DB caller (its only mention is its own
name inside the `guard_wallet_balance_write` allowlist, a string, not a call),
no anon or authenticated grant, and **zero rows in 30 days** matching its audit
signature. Dead code that mints is worse than dead code: the cost is zero right
up until somebody wires it back up. Dropped, with both facts re-asserted at
apply time and the full body pasted as a rollback.

The allowlist entry was deliberately left alone: editing
`guard_wallet_balance_write` means touching the trigger protecting every wallet
write on the platform, and an allowlist naming a function that no longer exists
is inert. Risk without benefit is not a tidy-up.

**And the live path is correct** — verified, not assumed: `atomic_table_buyin`
debits `club_members.chip_balance`, cash-out and tab-close both credit it. The
reset will behave exactly as intended.

## 2. Tournaments had solvency, not discipline

`fn_register_horse_for_tournament` refused on `insufficient_balance` and
nothing else, so a horse with 1,000 chips could enter a 950 event and be broke
on one hand of it.

The bar is much higher than the cash bar, and that is about variance, not
caution: an MTT pays nothing to most of the field most of the time, so a roll
that comfortably survives 25 cash buy-ins is busted by an ordinary run of 25
tournaments. Nit 100 buy-ins, standard 60, gambler 30. Priced on the **full**
entry, buy-in plus fee — pricing off the prize contribution understates a
turbo's real cost by its whole rake.

**Measured against the actual next 24 hours: no starvation.** Every scheduled
tier (3, 5, 10, 15, 25, 100, plus 4 freerolls) admits **100% of the fleet** at
a 10,000 roll. The first tier that would bite is 200, and none are scheduled.

## 3. A freeroll is never gated — and a broke horse goes to the FRONT

This is the other half of what Dan asked for: _"if they run out of chips, they
must play freerolls to earn their chips back."_ Nothing anywhere preferred a
broke horse for free money — the hourly rotation picked by id, so the horses
that most needed a freeroll were no likelier to get one than anybody else.

"Broke" is measured against the cheapest **paid** event actually on the board,
not a constant: a hard-coded floor goes stale the day the schedule changes, and
the question really being asked is "is there a paid game this horse could be
playing instead?"

The rakeback half of that loop already works — **1,012 of 1,014 payouts have
gone to horses.**

## 4. The rebuy was a reflex, not a decision

Both engine rebuy sites sized the reload as `big_blind * 100` flat — ignoring
the table's own minimum and maximum, and the roll entirely — and asked one
question: "have I already rebought twice?"

Now two questions. _Should it_ (inside its stop-loss, and can the roll still
carry this stake at all) and _for how much_ (the table's limits and the policy
share). A horse that can no longer afford a stake stands up, drops a rung, and
comes back — which is the ladder working.

The hard-coded `>= 2` becomes the temperament's own figure, and **standard —
six in ten of the fleet — stops in exactly the same place**, so this is a
spread around today's behaviour rather than a move away from it.

**Where the chips come from is unchanged.** Still `fn_horse_fund_from_treasury`.
This changes the answer, not the source; no money path is touched. And it makes
a horse MORE of a player, not less (10.5): a human's reload is limited by their
own wallet, and a horse's was limited by nothing at all — an asymmetry in the
horse's favour, and the law runs both ways. Timing is untouched: the five-second
window is upstream of this call and stays exactly as it is. This only decides
the answer the horse gives inside it, which is the thing the window exists for.

## 5. Aggregate exposure, wired

`canSit` answers identically for the first table and the fourth. The ceiling is
three single-table shares. Two details that would each have silently disabled
it: the seat read did not select `stack` (so exposure could not be summed —
the same class of bug as the missing `club_id` caught this morning), and a seat
bought _this cycle_ had to count immediately or a single pass could seat a
horse four times while every check read zero.

## 6. Telemetry, because a refusal and an outage look identical

Every one of these decisions was silent, and after the reset the first question
will be "is the ladder working, or is it quietly emptying the floor?" Thirteen
reasons, zero-suppressed — a line of zeroes every cycle is a line nobody reads.

`ladder_exhausted` is a **gauge**, not a counter, and that distinction is the
point: 40 stranded horses re-counted every 30 seconds reads as 115,200 a day
and means nothing. It is written unconditionally so it can fall back to zero —
guarding it with `if (stranded > 0)` looks harmless and means the number can
never come down.

## 7. The ladder itself — why the micro relaunch is load-bearing

Priced at a 10,000 reset:

| stake     | 100bb | gambler (12) | standard (25) | nit (40) | who sits      |
| --------- | ----- | ------------ | ------------- | -------- | ------------- |
| 0.05/0.10 | 10    | 120          | 250           | 400      | all           |
| 0.10/0.20 | 20    | 240          | 500           | 800      | all           |
| 0.25/0.50 | 50    | 600          | 1,250         | 2,000    | all           |
| 0.50/1    | 100   | 1,200        | 2,500         | 4,000    | all           |
| 1/2       | 200   | 2,400        | 5,000         | 8,000    | all           |
| 2/4       | 400   | 4,800        | 10,000        | 16,000   | std + gambler |
| 2/5       | 500   | 6,000        | 12,500        | 20,000   | gambler only  |

**As of this morning every micro table was `closed`** — 1/2 was the cheapest
open game on the platform. The move-down rule assumes a rung below; without the
micros a standard horse that loses half its roll has nowhere to step down TO,
and the symptom is a floor that quietly stops filling with no error anywhere.
That is what the `ladder_exhausted` gauge now counts, and it is the number that
says whether the relaunch gave the fleet somewhere to go.

## Verification

- tsc clean both roots. Server **3,053 / 267 files**, client **9,959 / 702
  files**. 23 new pins.
- **13 mutations, every one caught.** Three of them found weak pins first —
  a wiring assertion that passed with the call short-circuited behind `false`,
  a rebuy test whose roll was small enough that the sizing arithmetic returned
  zero on its own (so it was green with the rule deleted), and a window bounded
  by `sliceEnclosingBlock` that was too coarse to see its own `continue` go
  missing. Each pin was tightened until the mutation went red.
- The repo's own `noFixedSizeSourceWindows` gate caught a `+ 700` byte window
  in the first draft of these tests. Replaced with an adjacency assertion.
