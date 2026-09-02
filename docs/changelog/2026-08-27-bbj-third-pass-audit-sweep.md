# 2026-08-27 — Third pass: the line-by-line sweep

Dan: _"go through it all line by line, check for any bugs, stubs, gaps, errors,
regressions or wiring issues... then find any and all ways to improve, enhance
and upgrade this page and functionality to the max."_

A full defect audit of the BBJ feature and both hand-detail surfaces. Several of
these were mine, introduced in the three PRs before this one.

## The reader was inventing an action

`normalizeVerb` returned `'check'` for anything it did not recognise. So any
verb the engine writes outside its table — a timeout, a sit-out, a verb added
next quarter — was drawn to the player as a **Check that never happened**,
indistinguishable from a real one, on a surface that is about money. Unknown
verbs now carry the engine's own word, which is ugly exactly once and never a
lie.

## `"all in"` with a space double-counted the pot

`TO_LEVEL_VERBS` was tested against the raw string while the _label_ went
through a normaliser that collapses spaces and hyphens. A row storing
`"all in"` was therefore labelled All In and had its amount treated as an
increment — adding the whole raise-to level on top of what that seat already had
in. One normalisation feeds both now.

## An antes-only log killed the blinds

The blind-synthesis guard fired on any forced-money verb and `ante` was in the
set. A tournament row recording antes but no blinds suppressed the blinds
entirely: the pot rebuilt short by SB + BB, the whole stack column was
withdrawn, and every preflop raise-to was differenced against a committed map
with no blinds in it. Only blind verbs count as evidence of blinds.

## The pot line was a claim, not a label

It printed `Main(x)` after **every** street, so a flop section announced
`Main(24.00)` on a hand whose main pot was 240 — true only on the last street.
Only the final street speaks for the pot, and only there is the real main/side
breakdown shown.

## The discard street was swept under PreFlop

`pineapple_discard` was folded into preflop by the shared model, so **74,631
discard actions** appeared under a heading they did not happen on. It is its own
street now, labelled the same word Hand History uses.

## The table modal showed the known-wrong rundown on every open

`replay` is null while the raw row is fetched, and the tab fell straight through
to the legacy street walk — the one that file's own header documents as
over-counting every raised pot and defaulting every position badge to seat 1. So
on **every** open the player saw the wrong numbers first and watched them
silently change. `useHandReplayModel` has always returned a state; it was being
discarded. Now a skeleton, and the fallback says plainly that its figures are
the reduced ones.

## The example winners were not marked as examples

`BBJRecentHits`'s own doc-comment says every example row is _"stamped EXAMPLE
and greyed"_. They were only greyed — under a caption reading **"Last 3 Bad Beat
Jackpot Winners"**, which is a factual claim that this club paid three jackpots,
printed over three invented players with plausible dates and a real chip figure.
Now captioned "What A Winning Hand Looks Like", with a per-row EXAMPLE tag and a
line saying no jackpot has been paid on this pool yet.

## 375px

- The winners row left **~4px for the player's name** — 76px avatar + a 128px
  five-card strip + a 103px nowrap timestamp out of 351px usable — and the card
  strip had no `overflow`, so it painted over the column beside it. The
  mitigation breakpoint was 359px, which 375 never reaches. Relaid as two rows.
- The showdown row clipped the last one to three hole cards of **every Omaha
  hand**; the 380px query made the who-column _narrower_, the opposite of what
  375 needs.
- The column header was a three-track grid labelling a six-track row, so
  "Player / Action / Stack" never sat above the columns they name.

## Eligibility was a rendering detail

`BBJQualifyingHands` read it as `config.eligible !== false && cards.length > 0`.
The day PLO6 or short deck becomes eligible in `RakeConfig`, the panel players
read the rules from would go on telling them it is not. The config decides; the
cards are drawn if we have them, and the minimum hand is printed when we do not.

## The celebration overlay could throw, or print ∞

`BBJCelebration` is full-screen and its inputs come off a bus event rather than
a typed query, and it read `loser.username` and `loser.share.toLocaleString()`
with no guard. A partial `bbj_hit` threw and took the screen with it at the
worst possible moment; a `tableShare / 0` upstream would have rendered the
infinity glyph into a payout figure.

## Everything else

A null pool rendered _nothing at all_ · the Basic tab claimed "the live table
could not be read" on every open, before the fetch was issued, and a successful
but empty read was indistinguishable from a failure · `loadJackpotData` held a
stale closure on `user?.id`, so "Your Contribution" never loaded · the jackpot
page rendered a screen of zeros with no error state and no retry anywhere · two
independent RPCs were awaited in series on every load and every
`HAND_COMPLETED` tick · the realtime subscription was unfiltered and fired for
every jackpot on the platform · the scroll-lock effect re-ran with a forced
layout on every parent render because `onClose` is an inline arrow · the avatar
asked for 96px and drew 76 · run-it-twice boards existed only as a text label ·
the bad beat was not marked in its own showdown (the CSS was there and had no
writer) · the payout box never showed the total it breaks down · two null names
could throw and blank a whole list · `fmt()` printed the string `"NaN"` · the
dialog had `role="dialog"` and no Escape, focus move, focus restore or
`aria-modal`, and its tab strip was two plain buttons · `BBJRulesPanel`'s
tablist had no `aria-controls`, no tabpanel and no keyboard · a `role="button"`
row had `outline: none` and a 1.1:1 focus indicator · the running pot was
mutated inside JSX · **344 lines of dead CSS**.

## Two of my own fixes were wrong first

Worth recording, because in both cases the test caught me rather than the code:

- My first `settleStreet` guard required two contributors, which broke the _most
  common_ uncalled bet — a flop bet everyone folds to. The replacement is better
  than either version: infer the return, then let the engine's own `pot_size`
  arbitrate. If the rebuild without the inference matches and the one with it
  does not, the inference is withdrawn, rows and chips.
- `handHistoryMoneyAgreement` caught that the detail tab no longer carries the
  per-player money block. That block belongs on Hand Summary — keeping a second
  one in the detail tab was the duplication that let the two figures drift in
  the first place. Those tests are repointed, not weakened, and the two surfaces
  now cannot disagree for a stronger reason than a test:
  `HandHistoryService.buildResult` and `HandDetailView` both derive net from
  `buildReplay`.

## Verified in production

```
payouts                              29
linked to their hand                  5
recipients missing                    0
shares not summing to total           0
hand detail returning NULL            0
full rundown / summary card        5 / 24
winner rows on the club avatar        5
winner rows on a social photo         0
jackpot hands the pruner can take     0
```

`tsc` clean · client **7,500** tests · server **1,992** tests.

## Kept, not wired

`BBJRulesPanel` has four props (`section`, `highlightVariantKey`,
`highlightBB`, `embedded`) that its only call site does not pass, which makes
its "YOUR GAME" and "YOUR STAKES" branches unreachable. They are a props API for
an embedding host that does not exist yet. Left in place and recorded here
rather than deleted or pretended to be live.

`BBJTicker` has zero importers and is the only surface using the one-call
`fn_bbj_pool_for_club` resolver. Also recorded rather than quietly removed.
