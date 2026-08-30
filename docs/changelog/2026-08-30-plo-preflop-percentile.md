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

## Measured through the real `decide()`, 3-max plo4 spin, 300 deals

|                        | BEFORE (shipped)                | AFTER                            |
| ---------------------- | ------------------------------- | -------------------------------- |
| facing a pot raise     | fold 188, call 111, **raise 1** | fold 72, call 126, **raise 102** |
| first to act, unopened | fold 208, call 62, **raise 30** | fold 83, call 41, **raise 176**  |

A 0.3% 3-bet frequency against an opponent potting every hand is not a
strategy, it is a stuck valve — and from the other side of the table it
looks exactly like what Dan described.

## The fix

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
- `HorseOmahaPercentile.test.ts` — 9 tests: the raw score's compression
  (pinned, because it is _why_ the mapping must exist), the percentile's
  uniformity, AAKKds at the top, 4/5/6-card and hi-lo all mapping without
  throwing, sub-4-card left alone, plus behavioural floors for open
  frequency and 3-bet/fold frequency set far below the observed values so
  they catch the valve sticking rather than freezing a number.
- Full server suite green: **232 files, 2,578 tests**, including
  `HorseLeague` (zero illegal actions across a full matchup) and the chip
  conservation property tests.
