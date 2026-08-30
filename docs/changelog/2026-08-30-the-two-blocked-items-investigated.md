# 2026-08-30 — The two "blocked" items, investigated properly

Dan pushed back on my calling two things blocked. He was right to. One claim
survived with a much stronger proof AND turned out to have a constructive
path I had missed. The other was simply wrong — and the "fix" I was lining
up would have been a serious regression.

## 1. Facing-a-bet: the lookup is impossible, the CAPABILITY is not

### What I claimed, and how it is now proven

I said the warehouse holds no facing nodes. My evidence was weak — I checked
whether `actions` contained a `fold` key. Two stronger tests:

**v2 is definitively open-node only.** Sampled 1,124 rows: every `node` path
is `r:0` or `r:0:c` (the root, and "checked to hero"), across 286 distinct
nodes, and every action set is `bet_*/check`. Zero rows carry a fold action.

**v1's `f` values cannot be rescued, even ordinally.** The obvious salvage is
that `f` might be a fold frequency on some other scale — useless in
magnitude but usable as an ORDER. Tested across 40 solved turn rows:

    hand   avg f
    AA     447.8      <- the strongest hand "folds" MOST
    87s    401.8
    QQ     338.9
    32o    251.9
    72o    191.3      <- the weakest hand "folds" LEAST

    rows where 72o folds more than AA: 0 of 40

The ordering is **inverted** from fold-propensity. `f` is an EV or regret
magnitude, not a strategy on any scale. That is a falsifiable test and it
failed cleanly, which is a far better basis for the claim than "the numbers
look too big", which is all I had before.

### The path I had missed

A facing-a-bet LOOKUP is impossible. A facing-a-bet DECISION is not.

The open-node data contains, for every solved spot, **the opponent's exact
betting range**: `frequencies[bet_code]` is a 1,326-long vector of how often
each combo bets, at a known `size_pct`. That is precisely the input a
defense decision needs.

Today the horse facing a bet computes MC equity against a HorseMind band —
a behavioural read. It could instead compute equity against the range the
solver actually bets in that spot, then compare to the pot odds the known
`size_pct` implies. That is solver-grounded defense built entirely from
open-node data.

It costs almost nothing extra to store: the bet-frequency vector IS the
range, and V31 is already going to aggregate exactly that vector. The same
aggregation yields both the betting policy and the range to defend against.

**So the correct status is not "blocked on data". It is "specified, and
buildable on top of V31".** I was wrong to call it blocked, and the reason I
was wrong is that I looked for the answer in the shape I expected (a facing
cell) instead of asking what the available data could support.

## 2. Multiway: not blocked, not broken — and I nearly broke it

I said multiway "stays heuristic by necessity". I went to improve it and
measured the true equity dilution per extra opponent, 120 random spots per
variant, against the linear model `mw = (oppCount-1) * step`:

    variant     eq vs1  vs2    vs3    vs4  | real drop (2opp) | model step
    nlh         0.487  0.323  0.239  0.188 |      0.163       |   0.030
    plo4        0.498  0.331  0.248  0.199 |      0.167       |   0.045
    plo5        0.487  0.322  0.237  0.190 |      0.164       |   0.050
    plo6        0.507  0.336  0.251  0.201 |      0.171       |   0.055
    short_deck  0.502  0.336  0.255  0.202 |      0.166       |   0.030

A 5x gap. It looked exactly like the variant-scale bug on the opponent-count
axis, and the variant-specific stepping looked wrong too, since the real
drop is nearly identical across variants (0.163-0.171).

**It is not a bug, and "fixing" it would have been a bad regression.** The
crux is one line:

```ts
equity = simulateEquity(player.cards, gs.communityCards, Math.min(oppCount, 4), ...)
```

Equity is **already computed against N opponents**, so it already contains
the entire 0.163 dilution. `mw` is an ADDITIONAL conservatism on top of
correctly-diluted equity — a margin for the harder equity realisation and
higher made-hand density of a multiway pot. Raising 0.03 to 0.163 would have
double-counted the dilution and made every multiway horse absurdly tight.

The one real limitation is deliberate: equity is capped at 4 opponents for
Monte Carlo cost, while `mw` keeps growing linearly past that, which is what
compensates for the cap.

## The pattern worth keeping

Three times today an alarming measurement turned out to be my own error, and
each was caught the same way — by checking the MECHANISM before believing
the number:

1. `gameVariant: 'plo'` (not a real variant string) — "the best hand refuses
   to raise".
2. A `userId` mismatch in synthetic history — "0% c-bet in every variant".
3. This one — "the multiway model is 5x off".

Only the fourth measurement, the PLO preflop scale, was a real bug. The
difference was never the size of the anomaly; it was whether the mechanism
explained it. A measurement is a question, not a verdict.
