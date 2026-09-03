# 2026-09-02 — The club name gets the top of the card

Dan, with a screenshot of the club identity card where "DEEP STACK SOCIETY" had
wrapped onto two lines and sat on top of "ID: 11192" and "Dan Bekavac":

> "the club name should be across the very top of the card, all the way left to
> right, with the logo under it. So DEEP STACK SOCIETY IS ONE LINE ACROSS THE
> TOP. UNDER THAT SHOULD BE DAN BEKAVAC, NEXT LINE CLUB ID, NEXT LINE PLAYER ID
> LAST LIKE 192 PLAYING AND THE COPY LINK."

## The stack now

```
      13.5% +----------------------------------+
            |         C L U B   N A M E        |  full width, one line
      24.5% +----------+-----------------------+
            |          |  Dan Bekavac      31% |
            |   LOGO   +-----------------------+
            |          |  [icon] ID: club  52% |  painted icon
            |          |  [icon] ID: player 63%|  painted icon
      65.5% +----------+-----------------------+
            | LEVEL 26 |  174 Playing   [copy] |  73%, one line
      81%   +----------+-----------------------+
```

The name was the first row of a two-row grid it shared with the alias, in the
right-hand column beside the logo. That is why a long name wrapped down onto the
alias: the grid row grew, and the row below it had nowhere to go. It is its own
band now, so nothing above it can push it and it cannot push anything.

## What did NOT move, and why that matters

**The two ID rows are untouched.** The club and profile icons that label them
are painted into the shell PNG at y 52.42% and 63.15%. Moving the rows would
leave those icons labelling empty space — the stylesheet header has warned about
exactly this since v3 of the artwork was re-cut to bring the icons _down_ to the
lines. Dan's order keeps Club ID and Player ID adjacent and in that sequence, so
his layout and the artwork agree and nothing had to be re-cut.

The logo and the level box rose by 7 points to sit under the new band, keeping
their existing relationship to each other.

## The count and the copy link are now actually one line

They were already the last two things on the card, but the count was anchored
`bottom: 15%` and the share button to the painted copy frame at 65.19% — so they
were never on the same line. The count occupies the share's exact band now and
centres in it, putting both on the frame's centre line at 73.13%.

## One line, full width, never truncated — and how that is guaranteed

Two of Dan's rules meet on this string and pull against each other: the name may
not wrap, and it may never be cut off ("NEVER A 'MIDWAY UN...' FONT NEEDS TO BE
DYNAMIC IT ALWAYS DISPLAYS THE FULL NAME"). CSS cannot satisfy both on its own —
`clamp()` sizes text from the _card's_ width, never from how much text there is.

The first attempt was a character count: size = band ÷ (average advance ×
characters). Measuring the real font killed it. In Chromium at weight 850:

| name               | em per character |
| ------------------ | ---------------- |
| DEEP STACK SOCIETY | 0.62             |
| SHARK CLUB         | 0.67             |
| ACES               | 0.70             |
| MMMM… (18)         | 0.84             |
| WWWW… (10)         | 0.95             |

No single coefficient is both safe for the widest name and generous to the
ordinary one: pick 0.95 and every real club is shrunk by a third for a case that
never happens; pick 0.62 and the one club called "WWW…" runs off the card.

So the count is only the **first paint** — close enough that nothing visibly
jumps — and a `useLayoutEffect` then measures the text the browser actually laid
out and scales to the exact fit. Width is linear in font size, so one
measurement gives the answer outright: no loop, no binary search. A
`ResizeObserver` repeats it when the card resizes. Where no layout is available
(happy-dom, or any server render) the measurement is skipped and the estimate
stands, rather than the name collapsing to zero.

## Two defects found by looking at it

Rendering the real card in Playwright and reading the screenshot caught two
things the numbers did not:

1. **I re-broke a bug Dan had already reported.** Giving the playing line the
   same 7.2cqw icon gutter as the ID lines — for a straight left edge down the
   column — cut "1,204 PLAYING NOW" off by 7px. That is "COPY BUTTON ICON NEEDS
   TO BE CENTERED IN THE FRAME AND NEVER CUTTING OFF THE 446 PLAYING NOW FONT",
   from earlier the same day. The gutter is gone from that line and the bay is
   wider on both sides; a tidier left edge is not worth re-shipping it.
2. **The caps grazed the painted top rail** on the squat 2.4/1 lobby card. Every
   size on this card is `cqw`, so type is proportionally much taller against a
   short card than against the native 1650/953 one. The band moved down a point
   and the ceiling came from 7.4cqw to 7.

Both were confirmed fixed by measurement rather than by eye: the harness reports
`scrollWidth - clientWidth` for every text box, and the name span's width
against its band, across four name lengths and both card ratios. All zero.

## Verification

- `npx tsc --noEmit` — exit 0
- `npx vitest run` — **855 files, 11,706 tests, all passing**
- `npm run build` — exit 0
- Rendered and read at 375px in both the 2.4/1 lobby ratio and the native ratio.

## Pins

`tests/unit/lobbyTournamentBoardDesign.test.ts` carried two bare pins — `top:
52%` (logo) and `top: 72.8%` (level) — recording where those boxes sat while the
name was a column beside them. Both moved, so the pins moved with them in the
same commit, and are stated now as Dan's _order_ (name → logo → level; name →
alias → IDs) rather than as loose numbers that say nothing about why they are
what they are. The name band's own `top` is deliberately not pinned to a
literal, since it was already nudged once; what is pinned is that it spans the
card, that it is `nowrap` with no ellipsis, and that the count shares the share
button's band and carries no gutter.

Those negative pins read a comment-stripped copy of the stylesheet. This file
explains every position in a comment beside it, so a pin that greps raw text
matches the note about the value that was _removed_ and reports it as still
present — that cost three separate red runs in two days.

`tests/unit/lobbyMobileControls.test.tsx` renders the card and asserts the DOM
order, and calls both sizing functions directly, including the case where no
layout is available.

`tests/e2e/club-mobile-wallet-reach.spec.ts` builds a fixture out of the real
markup; it still nested the name and alias inside the deleted
`.club-identity__details`, so it was updated too — a fixture that mirrors markup
the component no longer renders is testing a layout that does not exist.
