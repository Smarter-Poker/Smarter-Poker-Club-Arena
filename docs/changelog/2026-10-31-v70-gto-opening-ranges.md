# V70: Hold'em opening ranges read on each seat's GTO order (2026-10-31)

Dan, 2026-10-31 15:33 Chicago: "AUDIT AND IMPROVE THE HORSES OPENING RANGES IN
BOTH TOURNAMENTS AND CASH GAMES, THEY SEEM LIKE THEY ARE OFF OPPOSED TO WHAT
THEY SHOULD BE OPENING WITH BASED ON GTO. AUDIT IT AND MAKE ANY AND ALL
IMPROVEMENTS".

Option: `v70GtoOpeningRanges` (default on, explicit `false` keeps the old open),
registered in `HorseDataLedger.ts` with the `v70_gto_open` receipt.

## What the audit found

`server/scratch/rfi-audit.ts` drives `HorseLogic.decide` end to end (every
graph owner after the preflop reference included) on an unopened pot folded to
the seat, for all 169 classes at every seat, 40 seeds per class, and reports
combo-weighted raise / limp share and open size. The live measurement over 24h
of production (`/home/claude/wt/horse-rfi-live-2026-10-31.md`, 153,706 horse
unopened decisions) says the same things.

Every layer that decides an unopened Hold'em pot: the 169-class score
(`holdemPreflopScore`, a hand-tuned high-card-heavy ladder) plus ±0.03 jitter;
one bar per position bucket (`OPEN_THRESH`: early/middle/late, the button
separate, full-ring early +0.06); style tightness (multiplies the bar) and the
per-horse `tightness` mod (fleet median 1.02-1.07); the ICM premium
(`riskAdd`); ante widen 0.05; V57 tournament aggression (-0.02/-0.03/-0.08 SB);
depth (+0.03 under 50bb, -0.02 over 150bb); the Phase 6 atlas open shift;
bubble pressure; the maniac bar; the SB blind-vs-blind bar (0.30 / 0.24 HU)
and limp mix (>= 0.22, 75%); the push/fold block (<= 12bb, or red M) and the
V20 orange-zone open-jam (M < 10, <= 22bb); the V27 push/fold charts at
<= 15bb (live only, `memory_charts_gold`); open size 2.2-3.0bb (2.05-2.4 with
an ante, 2.0-2.4 at <= 25bb), late -0.15. V60 cash pressure does not touch the
open.

1. **Membership was wrong, not mainly width.** The ladder ranks KTo/QJo above
   every suited connector and suited king, so early seats opened offsuit
   broadways and folded small pairs, suited wheel aces, K9s-K5s, J9s, T9s, 98s,
   87s, 76s.
2. **Position buckets were too coarse.** Nine-handed, UTG/UTG+1/UTG+2 shared
   one bar (11.5% each) and LJ/HJ another (~20% each); live UTG+2 opened LESS
   than UTG. Five-handed the first seat opened the 6-max UTG range (14.8%).
3. **Tournaments:** early seats too tight (UTG 13.9%), CO/BTN too wide
   (36.5% / 55.1% at 9-handed 50bb), the shape the same as cash.
4. **Short-handed tournaments:** the M-zone table scaling (players / 10) put
   every heads-up and three-handed stack under 22bb into jam-or-fold. Heads-up
   SB at 20bb jammed 29.9% and folded the rest; at 25-40bb it opened 50%.
   Live: heads-up SB opened 46% over 7,692 decisions.
5. **Cash SB** opened 39% + 11% limp offline (live 31% + 3%) at the same 2.3bb
   as every other seat.
6. **Cash under 50bb** every seat 2-3 points tighter (the depth tighten).

## The fix (root)

`server/src/engine/HorseGtoOpeningRanges.ts`:

- Seat = dealt-in players still to act behind hero, blinds included (SB 1,
  BTN 2, CO 3, HJ 4, LJ 5, UTG+2 6, UTG+1 7, UTG 8), from the dealt census
  (`preflopPlayersBehind`, sharing `dealtSeatOrder` with `classifyPosition`).
  A 6-max UTG and a 9-max LJ (five behind) open the same range; every seat at
  every table size 2-9 is its own seat, and the ladder is monotonic.
- Per-seat priority ORDER from reference charts (`GTO_OPEN_CHARTS`), ties
  broken by the next wider seat's chart and then the old ladder.
- The order is mapped onto the old score scale by combo share
  (`scoreAtShare`), so the style multiplier, ICM premium, bubble widen,
  maniac bar and Phase 6 shift keep their meaning in the same units.
- Width from per-seat targets (`OPEN_TARGET`, `OPEN_TARGET_THREE`,
  `OPEN_TARGET_HU`), not literals. Ante tables have their own set.
- `HorsePreflop` (unopened, no limper, NLH two-card, not pot/fixed limit, not
  short deck, not all-in-or-fold, not straddled): open bar = `t(seat bar)`
  - spin widen + Phase 6 shift (+ the old depth tighten in an ante-free
    tournament under 50bb); the SB limp band is read on its own order; the SB
    opens 2.8-3.2bb without an ante deeper than 25bb.
- Jam-or-fold zones: at four or more dealt they are untouched (see the league
  section for why). Two- and three-handed, jam-or-fold applies only at <= 15bb
  (12bb without the M layer), the push/fold charts' own zone.

Source of the charts: transcriptions of standard solver-derived 6-max 100bb
RFI (GTO Wizard NL500 6-max simplified, 2.5x opens, rake: solver widths UTG/LJ
~17, HJ ~21, CO ~28, BTN ~45, SB raise ~45) and the full-ring early-seat
charts; MTT widths from the 1bb big-blind-ante chip-EV shape (8-max 50bb: UTG
17.6, LJ 22.5, HJ 27.1, CO 34.5, BTN 46.7). No unopened deep-stack solver
artifact exists in this repository (`memory_charts_gold` is push/fold <=25bb),
so these are reference charts, not a hydrated solver read.

## Before / after (balanced style, tightness 1.0, 40 seeds, combo-weighted RFI %, `+L` = limp)

| context               | seat                                    | before                                                      | after                                                       |
| --------------------- | --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| cash 6-max 100bb      | UTG / HJ / CO / BTN / SB                | 14.8 / 19.9 / 25.8 / 42.3 / 39.4+L11.3                      | 15.2 / 20.4 / 26.0 / 42.5 / 42.6+L13.5                      |
| cash 6-max 40bb       | UTG / HJ / CO / BTN / SB                | 12.5 / 18.2 / 22.3 / 39.0 / 37.7+L12.5                      | 15.2 / 20.4 / 26.0 / 42.5 / 42.6+L13.5                      |
| cash 6-max 200bb      | UTG / HJ / CO / BTN / SB                | 16.4 / 20.7 / 29.3 / 45.3 / 39.4+L11.3                      | 15.2 / 20.4 / 26.0 / 42.5 / 42.6+L13.5                      |
| cash 9-max 100bb      | UTG / +1 / +2 / LJ / HJ / CO / BTN / SB | 11.5 / 11.6 / 11.6 / 19.9 / 20.2 / 26.9 / 42.1 / 38.7+L9.5  | 10.8 / 12.9 / 13.9 / 15.0 / 21.0 / 27.2 / 42.4 / 41.2+L12.5 |
| cash 5-max 100bb      | HJ / CO / BTN / SB                      | 14.8 / 25.9 / 41.8 / 39.0+L10.3                             | 20.5 / 26.1 / 42.1 / 41.4+L13.1                             |
| cash 3-max 100bb      | BTN / SB                                | 42.5 / 38.8+L10.1                                           | 48.2 / 43.3+L13.7                                           |
| cash HU 100bb         | SB                                      | 48.1+L3.2                                                   | 71.2+L13.7                                                  |
| MTT 9-max 50bb BBA    | UTG / +1 / +2 / LJ / HJ / CO / BTN / SB | 13.9 / 13.7 / 13.6 / 22.4 / 23.3 / 36.5 / 55.1 / 38.7+L9.5  | 16.2 / 17.5 / 20.1 / 21.7 / 24.5 / 30.7 / 46.3 / 44.0+L14.5 |
| MTT 9-max 30bb BBA    | same seats                              | 11.5 / 11.6 / 11.6 / 19.9 / 20.2 / 28.7 / 43.6 / 37.8+L10.0 | 14.5 / 16.1 / 19.1 / 20.7 / 22.5 / 27.3 / 42.6 / 41.1+L16.4 |
| MTT 8-max 50bb BBA    | UTG / +1 / LJ / HJ / CO / BTN / SB      | 13.9 / 13.7 / 22.3 / 22.4 / 36.9 / 57.1 / 39.0+L9.9         | 17.7 / 20.1 / 21.6 / 23.5 / 31.9 / 47.6 / 44.1+L15.4        |
| MTT 6-max 30bb BBA    | UTG / HJ / CO / BTN / SB                | 14.8 / 19.9 / 27.3 / 44.0 / 38.4+L12.0                      | 20.8 / 21.7 / 26.1 / 42.8 / 42.5+L17.8                      |
| MTT 9-max 20bb / 15bb | all                                     | jam-or-fold, unchanged                                      | unchanged                                                   |
| spin 3-max 25bb       | BTN / SB                                | 52.7 / 40.9+L8.5                                            | 52.4 / 47.3+L10.4                                           |
| spin 3-max 18bb       | BTN / SB                                | jam 31.9 / jam 31.4                                         | 52.4 / 47.3+L10.4 (2bb opens)                               |
| HU MTT 25-40bb BBA    | SB                                      | 50.0+L1.8                                                   | 73.6+L13.7                                                  |
| HU SNG 20bb           | SB                                      | jam 29.9                                                    | 58.3+L23.0                                                  |
| HU 12bb               | SB                                      | push/fold, unchanged (charts live)                          | unchanged                                                   |

Open sizes: unchanged except the SB, cash/no-ante >25bb, 2.31 -> 2.72bb.

Fleet (each style at its production median `tightness` mod, 2026-10-31:
balanced 1.05, grinder 1.02, lag 1.07, tag 1.034, tricky 1.047), cash 6-max
100bb after: balanced 13.2/19.3/23.4/40.7/40.8+L14.8, tag 11.9/18.3/21.8/39.6,
lag 16.9/21.3/28.3/44.3, grinder 11.0/16.7/21.1/38.8. Styles stay ordered
(lag > balanced > grinder at every seat); the mods make the live fleet run 1-3
points under the balanced numbers.

### Hand-class deltas (balanced, raise frequency moved by >= 0.4)

- cash 6-max UTG: now opens 44, A6s, T9s; now folds QJo, KTo.
- cash 6-max HJ: now opens 22, 33, K9s, K8s, K7s, J9s, 98s, 87s, 76s; now folds QTo, JTo.
- cash 6-max BTN: now opens T7s, T6s, T5s, Q9o, 96s, 95s, 85s; now folds J3s, J2s, 98o, 87o.
- cash 6-max SB: now opens T7s, T6s, K9o, Q9o, J9o, T9o, K8o, 98o, K7o.
- cash 9-max UTG: now opens 66, A9s; folds KJo, ATo. UTG+1: opens 33-66, A9s, A5s-A3s; folds KJo, ATo. UTG+2: opens 55, 66, A9s-A2s, KJo. LJ: folds 33-55, A7s, A6s, QJo, KTo, QTo, JTo, 98s (15.0%, the 6-max UTG range). HJ: opens 22, 33, K9s-K6s, J9s, 98s, 87s, 76s; folds QTo, JTo.
- MTT 9-max 50bb UTG: opens 22-66, A9s-A2s, T9s; folds KJo, QJo. CO: folds Q5s-Q2s, J6s-J3s, A7o-A2o. BTN: folds J3s, J2s, 94s, 98o, 84s, K7o-K3o, Q7o, Q6o, 87o, 76o, 65o, 54o. SB: opens T7s, T6s, K9o, Q9o, J9o, T9o, 96s, 95s, K8o, Q8o, 98o, 85s, K7o.

Remaining differences from the reference charts are the low-frequency edge of
each chart cut by the target width (UTG 22, QJo; HJ QTo, JTo, A9o, 97s; CO Q5s,
K9o, Q9o, T9o, A7o; BTN J3s, T4s, K6o).

## League (paired deals, 6000 pairs, seed 2026103170; a = on, b = `{ v70GtoOpeningRanges: false }`)

| card                          | mirror bb/100                                  | divergent | human field bb/100                       | divergent |
| ----------------------------- | ---------------------------------------------- | --------- | ---------------------------------------- | --------- |
| nlh 100bb                     | -0.25 +/- 1.68                                 | 858       | +1.83 +/- 2.33                           | 98        |
| nlh 40bb                      | +0.79 +/- 1.12                                 | 1041      | -1.12 +/- 1.90                           | 114       |
| nlh 200bb                     | -0.99 +/- 2.09                                 | 810       | +8.71 +/- 5.21                           | 95        |
| mtt 40bb (180 left / 30 paid) | -1.19 +/- 0.64; seed 2026103171 +0.08 +/- 0.70 | 661       | -0.90 +/- 0.84 (4 seeds: -0.35 +/- 0.53) | 65        |
| mtt 20bb                      | inert (jam zone untouched)                     | 0         | inert                                    | 0         |
| mtt 24bb                      | +0.33 +/- 0.40                                 | 368       | -1.36 +/- 1.04                           | 27        |
| spin 3-max 25bb               | -0.88 +/- 0.97                                 | 731       | n/a (human field is 6-max only)          |           |

How the cards shaped the change:

- **Width at the band centre lost to the human field.** With cash targets at
  the centre of each band (17.5/21.5/28/45/45) the human-field cards ran
  -4.40 +/- 3.33 (100bb) and -5.07 +/- 2.31 (40bb, below -2 stderr). Splitting
  the change: the new ORDER at the old widths ran +1.95 / +0.22 / -0.81; the
  old order at the new widths -1.8 at 40bb. The calling-heavy population
  punishes width, not membership, so cash sits at the lower half of each
  band.
- **No-ante MTT 40bb** ran -1.17 +/- 0.61 against the human field over four
  seeds until the old under-50bb depth tighten was kept for ante-free
  tournaments (-0.35 +/- 0.53).
- **The orange-zone shove (16-22bb, four or more dealt) is kept.** Replacing it
  with a small open measured +1.9 +/- 1.6 in the 20bb mirror but -8.7 +/- 2.9
  against the human field over four seeds (-8.43, -2.32, -12.40, -11.53); the
  population over-folds to the shove. It stays as it was; see follow-ups.
- The heads-up league cards are inert: `playHand` posts the small blind at the
  seat after the dealer even two-handed (the engine's dealer posts it), so the
  league never presents a heads-up SB an unopened pot. The heads-up change is
  measured by the audit and pinned by tests only.

No card is below -2 stderr in the shipped configuration.

## Tests

- `server/src/engine/HorseGtoOpeningRanges.test.ts` (new): chart parsing,
  monotone seat widths/bars, strictly monotone share scale; cash 6-max bands per
  seat; HJ/UTG/BTN memberships with the off arm showing the old shape; style
  ordering; SB open bigger than the button; 9-max monotonic early seats; MTT
  9-max bands; 8-max monotonic ladder; jam zone at 20bb byte-identical on and
  off; heads-up 25bb SB raises >= 60% without jamming; 3-max spin 18bb opens
  small.
- Off arms added in `HorseOpponentExploitNeutrality.test-support.ts` and
  `HorseOmahaTournamentPressureCorpus.test-support.ts` (as V64/V65/V68/V69).
- `HorseVariantScaleParity.test.ts` and `HorseOmahaPercentile.test.ts` use
  hold'em as the yardstick for Omaha's open; they keep hold'em's pre-V70 open
  (`HOLDEM_YARDSTICK`). Omaha never reads the option.

## Follow-ups (reported, not changed)

1. **Orange-zone shove, four or more dealt, 16-22bb.** The whole opening range
   is jammed (9-max 20bb BBA: BTN jams 43.6%, UTG 11.5%). Nash with a 1bb ante
   at 20bb is far narrower and solvers mostly open small. It beats the
   human-calibrated field (see above), so changing it needs a decision on
   which population to optimise for.
2. **Push/fold charts ignore the ante.** `memory_charts_gold` Tournament charts
   equal the Cash ones cell for cell (15bb: UTG 10.5, MP 13.7, CO 18.6, BTN
   26.6, SB 45.6 jam); with a 1bb big blind ante the Nash jam ranges are
   substantially wider. The offline fallback (charts not hydrated) is tighter
   still (15bb BTN 20.7%, HU 12bb SB 37.1%).
3. **Defence / 3-bet** (`server/scratch/defend-probe.ts`, cash 6-max 100bb,
   2.5x open, balanced): the BB facing a BTN open calls 35.7% and 3-bets 10.5%
   (~46% defend; solver ~60-65%), and gives the IDENTICAL answer facing a UTG
   open (solver ~30-35%). In this probe fixture raiser position did not reach
   the BB defend at all; a later graph owner (the V32 facing-defence layer is
   the first suspect) may be answering both spots - verify before fixing. `THREEBET_VS` / `CALL_VS` key on the five position buckets, so a CO and
   a BTN open (both 'late') are re-raised the same and the 9-max UTG/UTG+2 opens
   are defended alike. The 3-bet and flat ranges read the same high-card ladder
   the open used to, so the membership problem fixed here (suited connectors
   and small pairs ranked under offsuit broadways) applies to flats and 3-bet
   bluffs too. SB vs BTN 3-bets 12.9% and flats 1.1% (in line); BTN vs CO
   3-bets 9.5%, flats 7.7%.
4. **Omaha 3-handed button** opens ~29% (`HorseOmahaPercentile` fixture), tight
   for PLO.
5. **League heads-up blind posting** (see the league section).
6. **Open size** is ~2.1-2.3bb from every non-SB seat; solver 100bb cash opens
   are ~2.5x from early seats.
