# NLH cash horses 3-bet and defend their opens like the tournament layer (V60)

Dan, 2026-10-24: "HORSES NEED TO 3BET AGGRESSIVE HUMANS MORE IN POSITION",
"YOU'VE GOT TO MAKE THESE HORSES KILLERS. THEY ALL NEED TO BE WINNING
PLAYERS" - cash and tournament alike. The 2026-10-25 tournament aggression
layer (V57) moved the tournament numbers and deliberately left cash alone.

## Measured first (human-seated NLH hands, 2026-10-26..29, SELECT only)

| facing a single open     | horses               | humans               |
| ------------------------ | -------------------- | -------------------- |
| cash: fold / call / 3-bet | 78.6 / 17.0 / 4.4   | 32.7 / 57.7 / 9.7    |
| tournament               | 79.1 / 13.1 / 7.8    | 52.9 / 33.5 / 13.6   |

| opener facing a 3-bet    | horses               | humans               |
| ------------------------ | -------------------- | -------------------- |
| cash: fold / call / 4-bet | 61.8 / 24.7 / 13.5  | 32.0 / 52.0 / 16.0   |
| tournament               | 66.6 / 20.4 / 13.0   | 35.3 / 48.3 / 16.4   |

Turn barrels after a flop bet are no longer a gap (cash 49.5% vs humans
57.7% on a small sample; tournament 62.1% vs 54.3%).

## The change (`HorsePreflop.ts`, NLH cash only, `v60CashPressure` default on)

- Facing a single open with no caller: value 3-bet bars stated as hand
  shares against the opener's width - small blind vs a steal 0.56 (top ~15%),
  big blind vs a steal 0.64 (~11%), button/cutoff vs a late open 0.64, vs a
  middle open 0.70 (~9%), vs an early open 0.76 (~6%); other seats a shade
  wider. Re-steal bluff volume x1.3, as in tournaments.
- Opener facing a 3-bet up to 100bb effective: continue from the top 10%
  in position (0.66) and top 8% out of it (0.72); 4-bet bar -0.015 and 4-bet
  bluffs x1.4. Deeper than 100bb the V21 deep discipline is untouched.
- Not Omaha, not pot limit, not all-in-or-fold, not heads-up; the exploit,
  pressure and premium layers keep every bar they already lowered.

Offline probe over all 1,326 combos at 100bb, six-handed (off -> on):
BTN vs CO open 3-bet 8.8 -> 12.7%, BTN vs MP 7.2 -> 10.3%, BTN vs UTG
6.2 -> 8.1%, SB vs BTN 11.2 -> 17.0% (flats 5.8 -> 0.4%), BB vs BTN
11.2 -> 14.0%, BB vs UTG 6.2 -> 8.8%; opener facing a 4.5x 3-bet, full
range, fold 88.8 -> 83.6% in position and 90.8 -> 87.9% out of it.

Pinned by `HorseCashPreflopPressure.law.test.ts`. The tournament law keeps
its cash assertions through the explicit off arm. This is a source
calibration from measured frequencies, not a held-out profit certificate;
the live re-measure after the next engine activation is the next step.
