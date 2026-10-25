# A horse folds its trash early, like a person (2026-10-24, phase 3 of 9)

## The tell

Production, three hours of Lightning on 2026-10-24: 130,681 horse seats,
101,314 horse folds, **zero** early (Lightning Fold before the action reaches
the seat). People press Lightning Fold the moment trash lands. A person who
notices that nobody at the table ever folds out of turn has found every horse.

## What changed

`server/src/lightning/LightningHorseEarlyFold.ts` decides, at the deal, whether
a horse's hand is one its own brain folds from that seat whatever happens; if
so (80% of the time - people sometimes wait) the host folds it through the
person's own door, `handlePlayerAction('fast_fold', 'lightning-hand:<id>')`,
after a person's reaction (log-normal, median about 1.3 s, 0.45-4 s). The
pending fold is cancelled the moment the horse's turn arrives, and at hand end.

Qualifying: the brain's own preflop percentile (no jitter) below
`EARLY_FOLD_MAX` (hold'em, Omaha and Short Deck 0.11); never a blind, never a
VPIP-floor table, never a seat its account's client is driving. Every fold
files `lightning_horse_early_fold` (or `_refused`) into horse telemetry.

## Why 0.11 cannot change a decision

Parity harness (real HandController, real HorseLogic, mixed horse and
random-human 3-6 handed tables, 40-200bb, 500 hands per variant across NLH,
FLH, PLO4/5/6/8 and Short Deck): weakest hand the brain ever continued from a
non-blind seat facing a price was 0.188 (hold'em), 0.152 (Omaha), 0.174 (Short
Deck). The harness has no opponent reads, so the ceiling also clears the widest
exploit bars the brain can apply from a non-blind seat: the loose-opener flat
bar 0.174 and the button isolation floor 0.15 (hold'em), each less the 0.03
decision jitter. Only WHEN these hands fold changes.

## Pins

`server/src/lightning/aHorseFoldsItsTrashEarlyLikeAPerson.law.test.ts`: parity
on 160 seeded mixed hands each for NLH, PLO5 and Short Deck (every qualifying
hand the brain was asked about, it folded); real early folds through the door
with the hand's context, never under 450 ms, never a blind, never after the
brain was asked for the seat; and the exclusions.

## Retired the same day (superseded by #7958)

Dan ruled the same afternoon: "YES, HORSES SHOULD FOLD RIGHT AWAY IF THEY WERE
ALREADY FOLDING." #7958 implements that ruling (an already-folding horse folds
at its first priced look, with no think time, through the person's Lightning
Fold door). The delayed early fold built here would never fire behind it, so
its host wiring and law are removed. `LightningHorseEarlyFold.horsePreflopStrength`
stays: the Lightning strength matrix uses it to read archetype hand strength.
