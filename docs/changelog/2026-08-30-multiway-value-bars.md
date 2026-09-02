# 2026-08-30 — Horses barely bet multiway, and it was the same scale bug again

Dan: _"KEEP AUDITING ... UNTIL YOU CAN VERIFY EVERYTHING IS WORKING AND LOGIC
AND DECISION MAKING IS CORRECTED AND OPTIMIZED FOR ALL GAMES AND SCENARIOS."_

Two coverage gaps remained. Streets came back clean. **Multiway did not.**

## The gap that was never swept

Every sweep before this one — the variant scale parity work, the postflop
audit, all of it — was **heads-up**. Multiway postflop was the least-verified
path in the engine, and it is also where the solver layer deliberately goes
silent (`oppCount === 1` is a gate on the V29/V30 consult), so the heuristics
run alone there.

## What it found

C-bet frequency with the betting lead, measured through the real `decide()`,
200 deals per cell:

| variant    | 1 opp | 2 opp | 4 opp  |
| ---------- | ----- | ----- | ------ |
| nlh        | 71%   | 24%   | **2%** |
| plo4       | 71%   | 24%   | **2%** |
| plo6       | 72%   | 26%   | **3%** |
| short_deck | 70%   | 24%   | **1%** |
| pineapple  | 79%   | 24%   | **4%** |

A preflop raiser betting 2% of the time into four opponents is a stuck
valve, in every variant. On a 6-max or 9-max table with a multiway flop the
fleet was checking essentially everything — exploitable, and visibly robotic
to anyone sitting at the table.

## The mechanism, confirmed before touching anything

`decidePostflop`'s value-bet bars are absolute equity numbers calibrated on
the HEADS-UP equity distribution (`equity >= 0.8 + mw`, `0.62 + mw`,
`0.52 + mw`). But `equity` is computed against `min(oppCount, 4)` opponents,
and that distribution collapses as opponents are added. 250 random NLH flops
per row:

    opps  median   %>=0.80   mw     effective bar   % clearing it
     1     0.473      9%     0.00       0.80             9%
     2     0.280      2%     0.03       0.83             2%
     4     0.154      0%     0.09       0.89             0%

The bar meant "top ~9% of hands" heads-up and **literally nothing** four
ways. Worse, `mw` pushed the bar UP (0.80 -> 0.89) on a distribution that had
already collapsed DOWN — compounding the tightening instead of conserving it.

**This corrects what I wrote in the previous changelog.** I had said `mw` was
"additional conservatism on top of correctly-diluted equity — the right
design", and that raising it would double-count. The fact was right; the
conclusion was wrong. Because the thresholds are ABSOLUTE, the dilution
itself already applies enormous tightening, and `mw` compounds it. It is the
same defect class as the preflop variant scale bug, on the opponent-count
axis.

## The fix

`multiwayValueBar(headsUpBar, oppCount)` expresses a value bar as the
PERCENTILE it was always meant to be, then returns the equity sitting at that
percentile for the actual opponent count. `mw` then supplies the intended
extra multiway tightening on top of a scale-neutral bar — which is what it
was for.

Deciles measured over 600 random flops per cell. nlh and plo4 agree within a
few points at every opponent count, so **one table serves every variant**:
the dilution is a property of counting opponents, not of the game.

**Only the four value-BET bars use it.** The calling side compares raw equity
to POT ODDS — a probability against a probability — and is untouched.
Normalising that would misprice every call. Heads-up returns the bar
unchanged, so nothing about HU play moves.

### After

| variant    | 1 opp | 2 opp | 4 opp (was) | 4 opp (now) |
| ---------- | ----- | ----- | ----------- | ----------- |
| nlh        | 71%   | 31%   | 2%          | **18%**     |
| plo4       | 73%   | 36%   | 2%          | **14%**     |
| plo6       | 67%   | 41%   | 3%          | **12%**     |
| short_deck | 73%   | 39%   | 1%          | **9%**      |
| pineapple  | 74%   | 41%   | 4%          | **19%**     |

A realistic declining profile — bet most heads-up, less three-handed, least
five-handed — instead of a valve slammed shut. Heads-up is unchanged within
noise, by construction. The folding side is unchanged, as intended.

## Streets: swept, and clean

The other gap. Lead and facing-a-pot-bet, every street, every variant:

- **flop** c-bet 67-77%, facing-bet folds 19-67%
- **turn** barrel 31-56%, facing-bet folds 26-77%
- **river** bet 62-71%, facing-bet folds 41-76%

No stuck valves, no 0% or 100% cells, sensible street-to-street shape. The
PLO family defends much wider than hold'em against a pot-sized bet, which is
the equity arithmetic being right rather than a leak.

## Verification

- `tsc --noEmit` exit 0.
- Full server suite: **236 files, 2,654 tests, all passing** — engine and
  benchmark (125 files / 1,364 tests, including `HorseLeague` zero illegal
  actions, chip conservation, determinism and near-zero self-play) plus the
  remainder (111 files / 1,290 tests).
- `HorseMultiwayValueBar.test.ts` pins the contract: heads-up is bit-for-bit
  unchanged, the bar falls monotonically with opponents but never collapses,
  it stays monotonic in the bar itself, it clamps past four opponents rather
  than extrapolating off the table, and it preserves the calibrated
  percentile.
