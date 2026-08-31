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

---

# Addendum — the ladder had no way DOWN (same day)

The audit above ended with a sweep for unwired code, which found four
functions written and tested this morning with **zero callers**:
`canMoveUp`, `shouldMoveDown`, `bestAffordableGame`, `isBroke`. That is the
`sessionVerdict` failure again, and this time the reason they could not be
called is the interesting part.

## `stakeBandAllows` was an exact match

A band is EARNED (Dan 2026-08-29) on bb/100, and `stakeBandAllows` answered
`stakeBandFor(horse) === stakeBandForBigBlind(table)`. Exact. So a horse whose
roll could no longer carry its own band did not move down — **it stopped
playing.** Measured live, before any reset:

| band  | horses | cheapest open table                 | who can sit at 10,000 |
| ----- | ------ | ----------------------------------- | --------------------- |
| micro | 127    | **none — every micro table closed** | —                     |
| low   | 336    | 1/2 (ref 200)                       | all                   |
| mid   | 73     | 2/4 (ref 400)                       | nits cannot           |
| high  | 48     | **none — nothing above 2/5 exists** | —                     |

**175 of 584 horses — 30% of the fleet — were banded into a stake with no
table in it and had nowhere legal to go.** That is a live bug today, not a
consequence of the reset.

## Merit is a ceiling; the bankroll picks beneath it

Nothing here ever lets a horse play ABOVE its band — that half of the rule is
untouched and now pinned explicitly. What changes is that the band stops being
the only game it may play.

This is not the escape hatch `stakeBandAllows` deliberately refuses. That
hatch was about seating a nosebleed regular in a micro game _for convenience,
while it could perfectly well afford its own stake_ — "a nosebleed regular in
a micro game is the tell". A descent only happens when the horse genuinely
cannot afford its band any more, and a broke high-stakes player grinding back
up from a small game is the most recognisable story in poker.

## Hysteresis is why there are three thresholds

One threshold makes a horse flap: at exactly the sit bar it drops a rung, the
smaller game re-qualifies it, and it climbs straight back — every cycle,
forever. The policy already carried the three figures, and this is the first
time any of them are used:

- `canSit` (25 buy-ins) to ENTER a game;
- `shouldMoveDown` (17) the LOWER bar at which you leave it;
- `canMoveUp` (35) the HIGHER bar to climb back.

Between 17 and 25 a horse stays put; it must clear 35 to return.

## Two bugs the tests found in my own code

**The empty ladder.** With nothing priceable the descent loop fell through
every band and landed on the cheapest, so a cycle where the table read came
back empty would have re-banded the ENTIRE FLEET to `micro` — and the latch
would have persisted it until each horse individually clawed back. An empty
ladder is an unknown, not a verdict.

**The merit demotion.** A horse that had descended `high` to `mid` carries
`mid` in the latch. If merit then demotes it to `low`, the latch must lose —
otherwise the horse plays above its earned band, the one thing this must never
allow. Both are pinned; both mutations go red.

## Verification

tsc clean both roots. Server **3,066 / 268**, client **9,959 / 702**.
17 mutations caught in total across the day's work. Two existing pins were
MOVED rather than deleted — `HorseStakeBands` and `HorseBankrollWiring` both
pinned `stakeBandAllows` in the candidate filter; each now pins
`resolveStakeBand` and keeps the property it was really guarding (the band
decision happens before the weighted pick, and the bankroll sits alongside the
band rather than instead of it).

## What the micro relaunch still has to fix

Descent rescues the 48 `high` and the mid-band nits. It cannot rescue the
**127 `micro`-banded horses**: micro is the bottom of the ladder, so there is
nothing below to drop to, and merit forbids going up. Those 127 need micro
tables to exist. `ladder_exhausted` counts exactly them.

---

# Addendum 2 — the last two unwired functions, and a seated horse that could not afford its seat

## A seated horse now stands up when it can no longer afford the game

The seating gate only ever ran BEFORE a horse sat. After buy-ins and reloads a
wallet can fall under the level that justifies the stake, and nothing stood it
up for that — so the ladder could demote a horse in principle while it went on
playing a game it could not afford in practice.

The rotator now checks `shouldMoveDown` per seat. At the **looser** bar
deliberately (17 buy-ins, not `canSit`'s 25): a horse that merely dips under
the entry bar mid-session finishes what it is doing. Using the entry bar here
would stand a horse up the moment it fell below 25 and re-seat it at 25 — the
flap the three thresholds exist to prevent.

## `isBroke` and `bestAffordableGame` deleted

Both were correct, tested, and had zero callers — the same failure this audit
was written to find, so leaving two more behind would have been the wrong
lesson. Each was superseded the moment something real needed the job:

- `bestAffordableGame` picked from a synthetic ladder; `resolveStakeBand` does
  it against the bands and tables that actually exist, with hysteresis it
  never had.
- `isBroke` compared a roll to a hard-coded cheapest buy-in; the freeroll
  router asks the better question — can this horse afford the cheapest **paid
  event on the board** — which cannot go stale when the schedule moves.

Deleted rather than kept "just in case". Dead code with passing tests reads as
working machinery, which is exactly how the first four went unnoticed.

**Every exported bankroll function now has a production caller.**

## Verification

tsc clean both roots. Server **3,072 / 268**, client **10,013 / 702**.
19 mutations caught across the day.
