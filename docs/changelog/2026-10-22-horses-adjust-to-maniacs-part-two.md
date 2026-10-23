# Horses adjust to maniacs, part two (2026-10-22)

Follow-up to `2026-10-22-horses-adjust-to-maniacs.md`. Four changes, each
measured on the real-HandController harness (`HorseManiacPressure.test-support`)
before and after with the same seeds, and each pinned in
`HorseManiacPressure.law.test.ts` or `HorseOpponentExploitBehavior.test.ts`.

## 1. A style change is seen in a handful of hands

The exploit read decays with a 30-hand half-life. A maniac who calmed down
stayed read as a maniac for 38 (NLH) and 43 (PLO4) hands, and horses kept
calling a reformed player light for all of them. `HorseOpponentExploit` now
also keeps an 8-hand window over the raise, bet and call statistics. When a
player's recent play is credibly back inside the horse envelope the read turns
off; an aggressive turn engages early when the long window already places the
player past the envelope edge and the fast window confirms it at a stricter 97%
credibility (eight fast opportunities at least), so a short hot streak from a
horse-like history never engages. Measured: off after 21 (NLH) / 17 (PLO4) hands; on after 11 hands
(was 15 in NLH). Horse-versus-horse play is unchanged
(`HorseOpponentExploitNeutrality.law.test.ts` passes on the recorded corpus).

## 2. The limp-then-pot player

`maniacRaiseWidth` reads preflop raising only, so a player who calls preflop
and pots every street was never priced as a maniac. `isPostflopManiac`
(betting at least 55% when checked to, credibly outside the envelope) now
sends those folds through the same equity re-check. Heads-up postflop folds
holding more than the price plus twelve points: 12 of 46 to 0 (NLH), 43 of 87
to 0 (PLO4).

## 3. Thicker value into a station

Against a credible station (new read only, so horse-versus-horse sizing is
unchanged): value bets size up to 1.6x (was 1.3x), thin value bets 85% of the
time with a lower bar, and a strong but dangered hand keeps betting 70% of the
time instead of 45%.

## 4. The short tournament stack and the maniac

At 20 big blinds or less, first in, with a maniac still to act, a tournament
open is the shove: a raise there is a raise that folds to the shove, and under
ICM those chips are worth more than chip EV says. The brain already shoved at
these depths on the measured seeds; this pins it.

## Release

`HorseLogic.ts` and `HorseOpponentExploit.ts` are hashed policy sources, so
PLO4 generation 5 (8ea7564b) returns to shadow and is retained as
`RETIRED_2026_10_22B_PHASE10_SELECTION`, the 2026-10-17 precedent. The locked
matrices requalify on the new source.
