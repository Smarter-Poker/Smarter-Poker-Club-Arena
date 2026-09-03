# 2026-08-31 — V32 audit: the raise that was priced as a bet, and the clamped overbet

Dan's standing instruction between phases: verify everything merged, then hunt
before moving on. The Phase 2 audit re-read the merged V32 code cold and found
two real imprecisions, both in what the layer would ANSWER rather than in the
arithmetic of an answer.

## 1. Facing a raise was priced as facing a bet

If hero bet 30 and villain raised to 90, hero "faces a bet" by every gate V32
carried — but villain's action came from a RAISE node, and the warehouse holds
no raise nodes. Pricing a check-raise range with the open-bet cell is the donk
mistake with the seats swapped, and the donk case WAS excluded while this one
was not.

Gate added: `player.bet === 0` — hero has put nothing in voluntarily this
street, so the wager faced is a bet by construction. Postflop only, so blinds
never trip it. Pinned by a wiring test that builds the raise sequence and
asserts every V32 counter stays silent.

## 2. The all-in overbet consulted the mid-bet range

`pot` and `toCall` at the consult are EFFECTIVE — clamped to hero's stack by
the uncallable-excess correction. A villain jamming three pots into a short
hero read as a 0.6-pot bet and consulted the bet_mid range: the wrong range,
by the width of the polarity gap between a mid bet and an overbet.

The fix separates two numbers that were conflated: the size the bettor CHOSE
(raw — defines the range) and the price hero actually pays (effective —
defines the odds). `rawBetFraction` carries the first; `pot`/`toCall` keep
carrying the second. Pinned by a test where only the raw path can find the
range at all.

## Verification

- tsc clean; engine **1,472 tests / 128 files**, services **538 / 50** green.
- Two new mutations, each caught: reverting to effective bucketing fails the
  overbet pin; removing the raise gate fails the silence pin.
- Everything from Phase 2 proper re-verified on main: module, wiring, loader,
  telemetry counters, ablation flag, seven original mutations.
