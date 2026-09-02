# 2026-08-30 — PLO horses never played back, and the reason was a scale mismatch

Dan, from a live PLO spin: _"I literally full potted it every hand, horses
folded 95% of the time, never even raised, or called when they were first to
act... THAT IS NOT GTO PLAY."_

He was right, it reproduced on the first try, and the cause is one line.

## The defect

`decidePreflopV7`'s thresholds are **percentile-intent** — they are
calibrated against `holdemPreflopScore`, which is percentile-style
(median ≈ 0.5). `HorseLogic` fed them the **raw** `omahaPreflopScore`, whose
distribution is compressed. Measured over 400 random PLO hands:

    min 0.000   p25 0.200   median 0.240   p75 0.317   max 0.723

So in Omaha the median hand arrived at the decision looking like a
bottom-quartile hold'em hand, and the top of the entire PLO range barely
reached the value of a mediocre one. Every open bar, every 3-bet bar and
every call bar was therefore effectively unreachable.

The line at HorseLogic even documented the contract it was breaking:

```ts
// Hand strength 0..1 (percentile-style, variant-aware)
if (vi.isOmaha) strength = omahaPreflopScore(player.cards, vi.isHiLo);
```

**HorseEval already carried this exact diagnosis** — the note above
`placeOmahaBandCombo` says `omahaPreflopScore` is not percentile-style and
that matching percentile bands against it "selects almost nothing". A
reservoir CDF was built to fix it _for HorseMind's opponent reads_. Nobody
applied it to the decision itself.

## Measured through the real `decide()`, 300 deals per cell

|                    | plo4 BEFORE                      | plo4 AFTER                    | nlh (reference)               |
| ------------------ | -------------------------------- | ----------------------------- | ----------------------------- |
| open, first to act | raise **4%**, call 24%, fold 72% | raise 19%, call 16%, fold 65% | raise 22%, call 17%, fold 61% |
| facing a pot raise | raise **0%**, call 36%, fold 64% | raise 11%, call 29%, fold 60% | raise 10%, call 41%, fold 48% |

A **0%** 3-bet frequency against an opponent potting every hand is not a
strategy, it is a stuck valve — and from the other side of the table it looks
exactly like what Dan described. After the fix PLO tracks hold'em in the same
spot, which is the whole claim of quantile-matching.

Honesty about the harness: these are synthetic states driven through the real
`decide()`, and the absolute frequencies read tighter than a real 3-handed
table would (hold'em opening 22% from the button is itself tight for 3-max).
The comparison BETWEEN variants in an IDENTICAL state is the trustworthy
signal here, not the absolute numbers.

## The fix: quantile-matching, not a flat percentile

The obvious fix — map Omaha to a uniform percentile — is wrong, and
measuring said so. Hold'em's own score is **not** uniform either:

    holdem   median 0.236   p75 0.410   p99 1.000   max 1.000
    omaha    median 0.240   p75 0.317   p99 0.640   max 0.850

The medians nearly agree; the **top end** does not. Hold'em's best hands
saturate at 1.0, so a 3-bet bar at `t(0.74)` is cleared by a real slice of
its range; Omaha never gets there at all, which is why the valve stuck. A
flat percentile fixes the sticking but overshoots the other way — tried it,
and PLO went to a 34% 3-bet and a 24% fold, far looser than hold'em at the
same bar.

So the shipped mapping is **quantile-matching**: Omaha percentile first,
then the hold'em score at that same quantile (all 1,326 two-card combos,
scored and sorted once). A 90th-percentile PLO hand now scores exactly what
a 90th-percentile hold'em hand scores, so every bar in `decidePreflopV7`
means the same thing in both games — which is what "percentile-intent"
claimed all along.

`omahaPreflopPercentile()` maps the raw score through its own empirical CDF
using the **same reservoir** the band sampler already built and cached
(16,384 combos per `(holeCount, isHiLo)`, private deterministic RNG, so
building never disturbs the live `fastRandom` stream). Ties take the
mid-rank so a common score does not slam to the bottom of its block. One
binary search per decision, no I/O, nothing added to the hot path's
allocation profile.

Wired at all three preflop sites in `HorseLogic`: `decidePreflopV7Glue`, the
legacy preflop path, and `calculateHandStrength` — which also advertises
percentile-style output. Postflop is untouched: it already uses real Monte
Carlo equity, which is why the symptom was preflop-only.

## A wrong turn worth recording

My first reproduction used `gameVariant: 'plo'` and showed something far
more alarming: the best hand in the game refusing to raise at all. That was
**my test string, not production**. `OMAHA_VARIANTS` is
`{plo4, plo5, plo6, plo8, flo8}`, and `'plo'` is not a member — so
`variantInfo('plo')` returns `isOmaha: false` while `BettingStructure`
still calls it pot-limit via `startsWith('plo')`, and the strength fell
through to the constant `0.3`.

I checked production before "fixing" it: every live table is `plo4`, `plo5`,
`plo6`, `plo8`, `nlh`, `short_deck` or `pineapple`. **No table uses `'plo'`,
so this is not a live bug** — but the asymmetry between the two helpers is a
real trap for the next person who writes that string, and it is recorded
here rather than silently patched.

## Verification

- The A/B above was produced by toggling only the percentile mapping,
  through the real `HorseLogic.decide()`, with a deterministic dealer.
- `HorseOmahaPercentile.test.ts` — 8 tests. The behavioural ones run PLO
  and NLH through the SAME spot and assert PLO is in the same league as
  hold'em, rather than freezing a magic frequency — so they survive a future
  retune of the bars while still catching a stuck valve. Plus the raw
  score's compression
  (pinned, because it is _why_ the mapping must exist), the percentile's
  uniformity, AAKKds at the top, 4/5/6-card and hi-lo all mapping without
  throwing, sub-4-card left alone, plus behavioural floors for open
  frequency and 3-bet/fold frequency set far below the observed values so
  they catch the valve sticking rather than freezing a number.
- Full server suite green: **232 files, 2,578 tests**, including
  `HorseLeague` (zero illegal actions across a full matchup) and the chip
  conservation property tests.
