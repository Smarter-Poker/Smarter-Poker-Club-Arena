# Hold'em hole cards are the same size as PLO's

**Dan, 2026-08-28, verbatim:** "THE CARDS INSIDE OF THE CLUB ARENA FOR HOLDEM
GAMES WERE NEVER CHANGED. THEY NEED TO BE THE SAME SIZE CARDS WE USE FOR PLO
INSIDE OF HOLDEM. MAKE SURE THAT THE HOLDEM CARDS (HERO CARDS AND BOARD CARDS)
ARE THE SAME AS PLO GLOBALLY"

## What was wrong

On 2026-08-19 (bug list item 3) PLO hole cards went up ~50%. That change retuned
the three `:has()` guards on `.seat__cards--hero` and left the two-card set
alone, on the stated reasoning that the enlargement must not "leak" into
hold'em — there was even an e2e test named **"hold-em hole cards are NOT
resized"** holding the gap open.

That was the wrong reading of the constraint. The PLO sizes are capped by ROW
WIDTH — the row hangs off the right of the hero seat and has to stay inside the
viewport — and PLO5/PLO6 step DOWN from PLO4 purely to keep that width constant.
A two-card row is the narrowest row on the felt, so hold'em always had the most
room of anyone. It just never got any of it.

Result, on the same felt, same seat, same breakpoint: a 44px hold'em card beside
a 60px PLO4 card, for nine days.

## What changed

`--sp-card2-*` on `.seat` now carries the **PLO4** numbers at every breakpoint.
PLO4 is the reference because it is the largest of the three PLO sets.

| Breakpoint         | was (w/h/step) | now (w/h/step) | PLO4 guard |
| ------------------ | -------------- | -------------- | ---------- |
| base (desktop)     | 44 / 62 / 32   | 60 / 84 / 43   | 60 / 84    |
| `max-width: 640px` | 42 / 59 / 30   | 57 / 80 / 41   | 57 / 80    |
| `max-width: 480px` | 36 / 50 / 26   | 51 / 71 / 37   | 51 / 71    |
| `max-width: 380px` | 32 / 45 / 23   | 45 / 63 / 32   | 45 / 63    |

Heights stay `round(w * 1.4)` — the 2.5:3.5 playing-card ratio, exact so the
card art is never resampled.

Step is `0.72 x width`, which is the exposure ratio the two-card row has always
had (32/44, 30/42, 26/36, 23/32 all round to 0.72). Keeping the RATIO rather
than the pixel value means the pair overlaps exactly as it did; only the cards
are bigger. Row width is `w + step` = 103 / 98 / 88 / 77px, comfortably inside
the PLO4 row (135 / 129 / 117 / 102px) that already fits at every breakpoint.

## The one place they are still sized apart, on purpose

`.seat__cards--hero.seat__cards--revealed` — the hero's hand once it is TABLED —
now reads a new token, `--sp-cardrev-w`, which holds the pre-change two-card
sizes (44 / 42 / 36 / 32).

That row lays out WHOLE cards with a 1px gap rather than overlapping them, so
its width is `n x w`, not `w + (n-1) x step`, and a PLO6 hand has to fit the same
strip of backdrop beside the seat. It was pinned to `--sp-card2-w` only because
the two happened to share a value. Carrying the enlargement into it would have
taken a tabled PLO6 hand on a 375px phone from 137px to 195px against 151px of
room — the row would run off the screen at exactly the moment other players are
trying to read it.

This is not an exception to Dan's rule. A tabled hold'em hand is still the
LARGEST hand on the felt at showdown: 1.00 of that base, against PLO4's 0.92 and
PLO6's 0.70.

## Board cards: already identical, verified

No change was needed and none was made. The board is sized by
`.table-surface .community-cards__card { flex: 0 1 calc((100% - 4 * gap) / 5) }`
in `TablePage.css` — one fifth of the board row whatever the count on the felt.
Nothing in `CommunityCards.css` or `TablePage.css` branches on game type; the
only thing that resizes the board is `data-boards` (run it twice). A hold'em
flop and a PLO flop have always drawn at the same size.

## Tests

- `tests/components/HeroCardRowGeometry.test.tsx` — two new beats. One asserts
  the two-card size EQUALS the PLO4 size at all four breakpoints, read from the
  stylesheet per breakpoint rather than as four literals, so retuning PLO moves
  hold'em with it. The other pins the tabled row to `--sp-cardrev-w` and forbids
  it reading `--sp-card2-w`. The base-breakpoint width table updated to 60/43.
- `tests/e2e/hero-card-row.spec.ts` — **"hold-em hole cards are NOT resized"
  replaced by "hold-em hole cards are the SAME SIZE as PLO"**. The old test
  guarded the opposite invariant and is what kept this shipped. The new one
  checks the map AND measures a hold'em card against a PLO4 card in the same
  browser.
- `tests/unit/seatCardsAndPlate.test.tsx` — the revealed-row beat follows the
  token rename and now also forbids the old one.
- `tests/table-seat-ring-integrity.test.ts` — its `.seat { width: 96px }` pin was
  written as "within 4000 characters of the opening brace". `.seat` is where
  every seat-wide token is declared, each with the paragraph explaining why, so
  documenting one token pushed `width` past the budget and failed the beat with
  nothing about the seat box having changed. It now strips comments and reads
  the rule's own body — same invariant, immune to prose.

## Verified

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` over every suite that reads `SeatSlot.css`
  (HeroCardRowGeometry, seatCardsAndPlate, shipped-invariants,
  table-seat-ring-integrity, spinAnimationParity, avatarChoreographyCascade,
  avatarHeightsAreUniform, mobileBoardAndActionBar, pokerbrosWinnerPresentation,
  showdownSystem, tourneyUxSweep20260825) — all green.
- The Playwright browsers are not installable in this sandbox, so
  `hero-card-row.spec.ts` was verified arithmetically (row widths against the
  viewport at all four breakpoints) and runs for real in the required
  `CSS Beat E2E` check on the pull request.
