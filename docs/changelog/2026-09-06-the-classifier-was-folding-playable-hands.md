# The classifier was folding playable hands, and short deck was reading as hold'em

2026-09-06. Two defects found by probing V45/V46 against real deals rather
than re-reading the code, plus the panel finally showing what the horses now
measure.

## 1. Four percent of every PLO hand was being force-folded

`connectedSpan` returns a sentinel when a hand has fewer than four distinct
ranks — which is every hand containing a pair. The classifier read that
sentinel as a fact, so:

```
9932 rainbow  -> trash -> foldAlways
J733 rainbow  -> trash -> foldAlways
```

Neither is a fold. Both can flop a set. `trash` carries `foldAlways`, which
folds to **any** bet at any price, so measured over 20,000 random deals
**4.35% of all PLO hands were being folded preflop regardless of the odds**
— and `dangler`, which TIGHTENS the open bar, had swallowed **42.9% of the
deck**, quietly narrowing the fleet's opening range in every Omaha game.

Both shipped in #3198 and were live for a few hours (`v46_class_read` fired
8,335 times today).

**Fixed.** The classifier now asks for four distinct ranks before it reads a
span. `trash` is only the hand that can make no nuts at all — two low pairs,
rainbow, no ace — and any other weak hand is just a weak hand the bars fold
at the right price. After:

|                                  | before | after                           |
| -------------------------------- | ------ | ------------------------------- |
| force-folded (`trips` + `trash`) | 4.35%  | **0.91%**                       |
| `trash`                          | 3.52%  | **0.08%**                       |
| `dangler`                        | 42.86% | 35.62%                          |
| `aa_ds` + `aa_dry`               | 2.49%  | 2.49% (the true AAxx frequency) |

**A distribution test now pins it**, because that is the shape of test that
catches this: every hand a by-hand test names still looks reasonable in
isolation. It asserts force-folding stays under 1.5% of deals, that AAxx
lands in the aces classes at its real frequency, and that no class may take
more than 40% of the deck — a class that broad is a bucket, and its shift
becomes a fleet-wide bar change nobody chose.

## 2. Short deck was reading as hold'em

`readScopeOf` filed 6+ under `holdem` because both deal two cards. Every
frequency in short deck is different — strip the deuces through fives and
VPIP runs near 50% where full-deck hold'em sits at 25%, because everyone
connects with everything. So **205,562 short-deck seat-hands a week were
polluting the same player's NLH read**: the exact defect the scope exists to
remove, with a different pair of games than the audit named.

It is now its own family, `sixplus` (not `short`, so the family token can
never be confused with the table-size token in the same key). The check
constraint and the flush RPC both widened.

## 3. The panel shows what the horses now measure

Three RPCs existed with no reader, which is the same failure as a tag nobody
reads. `pages/horses/hand-reviews.js` gains three cards in the page's own
idiom — real `<button>` expanders, `aria-expanded`, CSV export, and the
page's error discipline that a failed read must LOOK failed rather than
render as "No Data Yet":

- **Tournament Scoreboard** — 66% of horse seat-hands are tournaments and
  this page could not show one result. ROI, ITM and average finish per type,
  with the caption saying to compare against minus-the-fee rather than zero,
  because the fleet plays itself.
- **Frequency Leaks** — the leaks no 20bb hand tag can see, with a fleet-wide
  banner when a third of the studied horses share one: that is a bar in the
  brain, not a set of dials.
- **Solver Agreement** — the absolute score, with the day-over-day change
  coloured, because a fall is the one regression the league card above it
  structurally cannot see.

`ca_horse_solver_agreement` is added and allowlisted like its siblings.
