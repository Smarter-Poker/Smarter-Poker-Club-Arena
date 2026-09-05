# The horse knows where it is sitting

2026-09-05. Dan: _"THE MOST IMPORTANT IS SITUATIONAL AWARENESS! WHICH THERE IS
ALMOST ZERO PROOF THAT IT EXISTS OR THAT THEY TRULY UNDERSTAND THAT THEY ARE
PLAYING LIVE AT THE TABLE."_

The audit that followed found the brain knows a great deal about the HAND and
almost nothing about the SESSION, and that one of the numbers it reasons with
was simply invented.

## 1. Every pot-odds calculation was priced off a guess

`rakeDrag` used two hardcoded numbers — ten percent, and a cap "approximated
at 2.5bb" — while `ServerTableEngineBase.getRakeOverride()` had always held the
real schedule: `tables.rake_percent`, `tables.rake_cap_bb`, refreshed on a
timer, falling back to the club's own defaults.

The two were never connected. A club on 5%, or capped at 1bb, was charging one
rake while its horses reasoned about another — and the error lands exactly
where it hurts:

```
potOdds = toCall / ((pot + toCall) * (1 - rakeMarg))
```

the closest decisions on the board. Overstating the rake folds hands that were
a call; understating it calls hands that were a fold. Every hand, every street,
on every table whose schedule was not 10%/2.5bb.

The schedule is now threaded from the engine to all four call sites. Absent —
the league simulator, a unit test, a table whose config has not loaded — it
falls back to the old constants, so the change is byte-identical where nothing
is known. A rake of **zero** is now a real answer rather than a missing one: a
freeroll's pot odds are honest at every pot size.

This is a correctness fix, not a strategy change, so it ships on.

## 2. The only time input in the whole brain was a hash of the clock

Grepping `HorseLogic.ts` for `session|tilt|pnl|handsPlayed` returned two lines,
both inside `moodOf()`:

```ts
const key = userId + '|' + Math.floor(Date.now() / 3_600_000);
return (h % 1000) / 1000; // 0..1, stable for the hour
```

Deterministic, zero-mean across the fleet, and by construction unrelated to
anything that had happened to that horse. **A horse two hundred hands and three
buy-ins into a session played exactly like one that had sat down thirty seconds
earlier, and nothing in the code could tell them apart.**

`HorseSessionMemory` now measures, per seat per table: hands played here,
minutes seated, net chips and net bb, and whether the session is long enough
(30 hands, about three orbits nine-handed) that anybody watching has a read.

Two design points worth keeping:

- **It reads no database.** `HorseDataLedger` forbids a DB read at decision
  time and is right to — the decision runs inside the turn timer. Everything is
  measured from the engine's own hand boundaries, in memory, on the box already
  dealing the cards.
- **Net is summed across hands, so a rebuy cannot pollute it.** The obvious
  implementation (remember the buy-in, subtract from stack) reads a rebuy as a
  catastrophic loss. Summing `(stack after hand − stack before hand)` makes
  chips added _between_ hands invisible by construction, with no cooperation
  needed from `autoRebuyHorse` or any other funding path. There is a test for
  exactly this: bust for −200, top up, win 10, and the answer is −190.

There is no `is_horse` in that file and there must never be one (CLAUDE.md
10.5). It records every seat identically; a human's session is measured the
same way and the number is already correct if a surface ever wants it.

## 3. The proof Dan asked for

Two receipts fire on every decision taken with a live session attached:
`v41_session_read`, and `v41_table_image` for the subset past the image
threshold. **They fire whether or not the behaviour flag is on**, and
deliberately — a receipt gated behind a default-off flag proves nothing, which
is the whole reason the receipt exists.

The behaviour itself (`v41Session`) is **default OFF**: a table image means the
horse's own patterns are visible, so it should mix more and lean on its pure
lines less — and whether that is worth anything is a question for a league
matchup, not for an argument. Shipping it on without a significant run is
precisely the mistake the ledger keeps a list of.

`HorseSessionMemory.test.ts`, `HorseRakeIsTheTables.test.ts`. The ledger's own
contract test caught all three additions before I registered them, which is
what it is for.
