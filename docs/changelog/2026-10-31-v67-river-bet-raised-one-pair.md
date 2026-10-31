# A hold'em one pair that bet the river and was raised is priced against the raise (V67)

Leak 4 of the 2026-10-31 leak report (`/home/claude/wt/horse-leak-report-2026-10-31.md`):
the horse bets the river with one pair, is raised, and calls or jams.
V66 covered the same line on the flop and the turn and deliberately left the
river out. This is the river.

## Measured first (7 days of `horse_hand_reviews`, nlh, 12% sample, |net| >= 20bb, SELECT only)

| class (horse decision)                                  | seg  | n   | won   | weekly net bb (scaled) |
| ------------------------------------------------------- | ---- | --- | ----- | ---------------------- |
| river one-pair bet, raised, then call or call-all-in    | cash | 226 | 11.9% | about -129,000         |
| same                                                    | MTT  | 125 | 19.2% | about -47,000          |
| same, cash, call of a raise under 0.7 pot               | cash | 90  | 0-5%  | -9,043 (sample)        |

Average raise 0.72 pot. When raised the horse folded 1.4% (top pair, cash) to
17% (under pair). Reference: two pair or better called the same raise and won
44-65%.

## What the code did (verified on the fixture)

The report blamed the committed branch's `!polar62` gate. That gate is real
but not the cause by default: V62 has been opt-in since 2026-10-30, so
`polar62` is false in production and V61/V63 already shade this call. The
cause is one layer up, the same one V66 found on the flop and turn: the
contact sampler reads a RAISE over hero's own river bet exactly like a bet.
On `Qh7d2s4c9h`, hero bet 8 into 12 and was raised to 24 (toCall 16 into 44,
needs about 30%): second pair `Ts9d` read 52-58% and top pair top kicker
`AsQd` read higher, so V63's 8 points and any flat shade capped at 25 still
left both calling 40 of 40 seeds. A shade-only change was measured inert on
the fixture before the stratum was added.

## The change (`v67RiverBetRaisedOnePair`, default on; explicit false is today)

Single-board Hold'em (not Omaha, short deck, fixed limit, multiple boards or
bomb pots), river, hero bet or raised this street and now faces a raise,
hero holding the V61 bluff-catch class (one pair, or two pair through the
board's pair), no measured over-aggressor read on the raiser
(`exploit.callDownMod <= 1`), inside V61's gates (off when V61 is off):

1. **The river raise stratum** (`HorseEval` `raisePolar67`, receipt
   `v67_river_raise_stratum`). The raiser's sampled hand is drawn through the
   same exact per-call band index V62/V66 use: 10% bluff
   (`V67_RIVER_RAISE_BLUFF_SHARE`), otherwise two pair+ 75% / top pair or
   overpair 22% / weaker pair 3% (`V67_RIVER_RAISE_VALUE_MIX`). It replaces a
   V62 polar read for that raiser. With it, TPTK reads 29-32% against the 3x
   raise and second pair about 12%.
2. **The raise shade** (`v67RiverBetRaisedShade`, receipt
   `v67_river_bet_raised_one_pair`). The V63 shape plus
   `V67_RIVER_RAISE_SHADE` = 0.10, capped at `V67_RIVER_RAISE_SHADE_CAP` =
   0.25, applied in the committed branch (replacing `shade61c`) and in the
   V38 river verdict (replacing `shade61`), and not withheld for `polar62`.
3. **Call or fold at that price.** In the committed branch the class takes
   V66's exit: call when `eq15 >= required`, fold otherwise; the 0.42 floor
   and the jam do not apply. Commitment is unchanged (`committedLegacy`), and
   a near-all-in getting a tiny price still calls because the price is the
   bar.

Flop and turn, Omaha, two pair of hero's own cards and better, and a one-pair
hand that did not bet the river are untouched.

## Measured on the fixture (`HorseRiverBetRaisedOnePair.test.ts`, 40 seeds)

Hero opened, villain called (pot 12), checked to the river; villain checked,
hero bet 8, villain raised to 24 (toCall 16 into 44) on `Qh7d2s4c9h`.

| hand / spot                                         | V67 on (call/fold) | V67 off (call/fold) |
| --------------------------------------------------- | ------------------ | ------------------- |
| AsQd top pair top kicker, 100bb                     | 0 / 40             | 40 / 0              |
| KsQd top pair, 30bb (committed branch)              | 0 / 40             | 40 / 0              |
| Ts9d second pair, 100bb                             | 0 / 40             | 40 / 0              |
| AsQd, tournament                                    | 0 / 40             | 40 / 0              |
| KsQd near-all-in, toCall 6 into 218                 | 40 all-in calls    | 40 all-in calls     |

Two pair of hero's own cards (`Qs9c`), a set (`7s7c`), the flop, the turn and
Omaha are identical on and off (asserted).

## League (duplicate-deal, 6000 pairs, equity governor off; a = V67 on, b = off)

Mirror (seed 2026103109) and human-field twin (seed 2026103110):

| card      | mirror bb/100  | divergent pairs | human twin bb/100 | divergent pairs |
| --------- | -------------- | --------------- | ----------------- | --------------- |
| nlh 100bb | +0.42 +/- 0.22 | 4               | inert             | 0               |
| nlh 40bb  | +0.16 +/- 0.09 | 3               | inert             | 0               |
| mtt 40bb  | inert          | 0               | inert             | 0               |

12,000 hands per card, no illegal actions, no truncated streets. No card
below -2 standard errors, so the extra shade ships at 0.10. The class is very
rare in the league (the horse must bet the river with one pair and be
raised; the human-field twin never raises a river bet), so the live review
rows are the primary evidence.

## Re-measure live

Same query as the report's section 2.4: `horse_hand_reviews`, nlh, first
horse river bet with one pair, raised, by action. Expect the fold share of
raised one-pair river bets to rise from 1.4-17% toward most of them, the
class net to move toward zero, and the 753 unraised top-pair value bets and
the two pair+ rows unchanged. Receipts `v67_river_bet_raised_one_pair` and
`v67_river_raise_stratum` count the decisions the gate touched. To rerun the
league: copy `server/scratch/league-v66.ts` with `off = {
v67RiverBetRaisedOnePair: false }` and run
`SUPABASE_URL=https://supabase.invalid SUPABASE_SERVICE_ROLE_KEY=offline-league-placeholder EQUITY_GOVERNOR=off npx tsx scratch/league-v67.ts 6000 <seed> [human]`;
`v67RiverRaiseShadeOverride` sets the extra shade for a calibration card.
