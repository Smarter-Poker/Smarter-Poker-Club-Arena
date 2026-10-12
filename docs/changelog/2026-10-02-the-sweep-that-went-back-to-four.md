# The sweep that went back to four, and why three of them were never generic

2026-10-02. The #ClubArenaConsole inventory printed `0 to go` on 2026-09-23 and
`4 to go` nine days later. One of the four was a real surface that needed art.
The other three had not changed at all; the scorer had three separate defects,
and each one is a fix from 2026-09-22 left standing one level up. That is
CLAUDE.md 10.86 rule 4 word for word: when you fix something, ask what the next
person will reach for, and check that it works.

## What the list said

```
score  radius grad hover px  imp  file
   10      0    5     1   0    3   src/components/club/SpinActivationPanel.tsx
    2      1    0     0   1    1   src/components/tournament/details/MultiDayStagePanel.tsx
    1      0    1     0   0    2   src/pages/CreateTablePage.tsx
    1      0    1     0   0    1   src/pages/DiamondPlayersPage.tsx
```

## The one that was real

`MultiDayStagePanel` renders "Your Day 2 Seat" on the tournament Overview, and
its Open Table action was a control drawn entirely in CSS:

```css
border: 1px solid var(--tl-hairline, rgba(111, 220, 255, 0.14));
border-radius: var(--tl-radius-pill, 999px);
background: var(--tl-surface-raised, #223046);
```

Section 0 of the standard forbids exactly that: every painted control in Club
Arena comes from Dan's master art, and a surface with a single action prints it
as a lit word rather than leaving a second plate painted and empty. It is a lit
word now, in the tournament family's own `--tl-accent`, aligned with the labels
above it. Before and after:
[`shots/2026-10-02-multi-day-stage-open-table.jpg`](./shots/2026-10-02-multi-day-stage-open-table.jpg).

The rest of the panel was already right - rows on the glass, label over value, a
hairline opening each group - so nothing else moved. `OpenTableButton`, the
`navigate` call, the `Open Table` accessible name and the `button` role are
untouched: `tests/components/MultiDayStagePanel.test.tsx` pins the first three
and `tests/no-auto-table-switch.law.test.ts` pins that the panel navigates only
from that click.

## The three that were not

### A comment is not a rule

`:hover` is the heaviest term the scorer has, weighted five times because the
real thing is forbidden outright. `SpinActivationPanel.css` scored 5 of its 10
points on one, and the match was line 19 of its own header:

> the panel is the same picture in all three hosts. No :hover.

Measured across `src/` on 2026-10-02: **zero real hover rules, and 109
stylesheets containing the word inside a comment.** The law has worked so
completely that every match this counter could ever find was prose. And the law
itself has masked comment bodies since the day a sweep matched a `:hover` inside
one and cut a stylesheet in half - the scanner simply never did.

### An engraved rule is not a frame

September taught the scorer to read a declaration's VALUE before judging it,
because `border-radius: 0` refuses a frame rather than drawing one. It did not
teach it what a shadow is for. Step 5 of the method prescribes the divider
between two rows on the glass in full:

```css
border-top: 1px solid #000;
box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%);
```

**488 of the 1,985 `box-shadow` declarations in `src/` are that rule.** All five
of `SpinActivationPanel`'s were, and they were its entire `grad` score - on a
panel that owns no frame at all, because it prints rows on whatever glass its
three hosts give it (a settings page, the lobby's Spins Wallet popup, the Union
Dashboard). Same shape as September: the more correctly a surface followed the
standard, the more generic this said it was.

A shadow is paint when it has a blur or a spread. Offsets of at most 2px with
neither are a rule. A `0 0 0 1px` ring still counts, because a spread is a drawn
border by another route.

### A surface wears the sheet it imports, and the lobby card art is a master

`DiamondPlayersPage` imports `ClubMembersPage.css` whole and adds 27 lines of its
own; its header says so in the first sentence. That roster sheet is pinned by the
Players Casino Realism asset and interaction contract, which makes the page
finished work on a different approved authority (step 1.5 of the method). The
scanner resolved a stylesheet by filename alone, so it judged the 27-line delta,
found one `inset 0 -2px 0 var(--members-blue)` underline - the fourth of a set
whose other three live in the pinned sheet - and nominated the page.

`CreateTablePage` renders nine of the lobby's own painted `ArenaGameCard`s and
deliberately draws no console around them (Dan, 2026-09-20, quoted in the page:
"DO NOT ATTACH EVERYTHING TOGETHER WITH THE SAME DISPLAY WINDOWS"). The
scanner's `master` test carries a comment naming three authorities and a regex
implementing two: the lobby's card art was missing. So the page was nominated for
the one thing it was right to leave out. Both surfaces as they render today:
[`shots/2026-10-02-already-on-an-approved-authority.jpg`](./shots/2026-10-02-already-on-an-approved-authority.jpg).

## Why the list went back to four at all, and what reads it now

The inventory is a script somebody runs on purpose. A surface could land generic
and stay generic until an agent thought to look, which is CLAUDE.md 10.83
exactly: a check nobody can see is not a check.

`tests/unit/consoleInventoryIsHonest.test.ts` now holds the sweep at zero.
**The reader is the required Client Unit Tests check, on the pull request that
adds the surface** - not a timer, not a watcher, not a repair job. It goes red in
the same pull request as the cause, names the file, and tells the author the
three ways out: put it on an approved master, add it to `INTERNAL_ONLY` if no
player and no club operator can reach it, or add it to `RULED` with the ruling
written out. Widening a counter is not one of them.

The same file pins each of the four verdicts above, and the controls that stop a
future correction from going too far. Both were proved by mutation before this
shipped:

- put the drawn pill back, and `the one real surface stopped drawing its control
in CSS` and `reports nothing left to rebuild` both go red;
- widen the hairline test to swallow every shadow, and `and a real shadow is
still paint, across the tree` goes red.

That last control is the one that matters. The point was to stop counting the
standard's own handwriting, not to stop counting: 1,325 painted declarations over
111 surfaces survive, and 40 surfaces are scored on shadows alone, their
stylesheets holding no gradient at all. Widen the hairline test and that last
number collapses. The sweep has to end by running out of work, never by going
blind.

## The scanner now reads

```
241 surface(s) already spoken for (83 pinned by a visual test), 0 to go.
```
