# The Diamond Arena Is A Club Card

Dan, 2026-09-09, with a screenshot of the lobby carousel: "THE DIAMOND ARENA
CARD HAS TO LOOK AND FEEL EXACTLY LIKE THE CLUB ARENA CARDS DO, SAME SQUARE
SHAPE, ON THE BOTTOM HAVE AN ACTIVE PLAYERS TAB, AND NEXT FREE ROLL STARTS IN
X:XX TIMER." On review: "IT SHOULDN'T SAY AUTOMATIC ENTRY ANYWHERE."

## What was there

The Diamond Arena entry in `CarouselSection` was a bare 2:3 poster
(`public/cards/diamond-arena.png`) dropped between two four-zone club cards.
Different shape, different frame, no figures.

## What is there now

`src/components/club/DiamondArenaCard.tsx`, drawn from `ClubCardPanel.css`:
the same ID plate, square viewport, name plate and stats rail every club and
union card gets, with a `--arena` dress (ice-white exterior where a club is
nickel and a union is gold). The plate reads SMARTER.POKER, as the table in the
art does; the name plate reads DIAMOND ARENA.

The viewport art is `public/cards/diamond-arena-square.jpg`: a 528 x 528
window cut from the original poster at native resolution (the diamond and the
SMARTER.POKER table), not a generated substitute. The original PNG stays in the
repo untouched, per the phase 5 note that preserves it.

The rail carries two figures:

- **ACTIVE PLAYERS**, fed by the same `fn_batch_club_realtime_active_counts`
  read the club cards use (the Diamond Arena club id is already in that batch)
  and the same last-known-figure cache, so it opens with what it knew last and
  never prints a word in a number bay.
- **NEXT FREEROLL**, a countdown to the earliest REGISTERING 0-buy-in
  tournament in the Diamond Arena club (`src/hooks/useNextDiamondFreeroll.ts`).
  The card ticks locally once a second; the hook re-reads once a minute and
  again the moment a countdown expires. Gold ink, red and pulsing inside the
  last ten seconds. `M:SS` under an hour, `H:MM:SS` under a day, `2d 4h`
  beyond. The Diamond Arena has no tournaments yet ("BUT IT WILL"), so it
  prints `0:00` until one is scheduled.

The card never says "Automatic Entry"; the carousel's aria-label now reads
"Diamond Arena - Click To Enter Lobby" like every other card.

## A fix in the shared kit

On a 165px phone card the name plate printed "DIAMOND A...". The name text now
scales with the card (`clamp(11px, 8cqw, 16px)`) the way the stats already
did; desktop cards stay at the 16px cap. Every club card inherits it.

## Verification

Rendered from the real `CarouselSection` at 393px and 1100px through the
console harness: live, last-ten-seconds, no-freeroll and two-days-out states,
reviewed by Dan before push. `tsc` clean; the four copy gates OK;
`classNamesResolve`, `discardedErrorReadRatchet`, `no-hover-effects`,
`carouselLiveStats`, `carouselThreeUp`, `club-card-realtime-human-stats`,
`pokerArenaSelection` green, plus the new `tests/components/diamondArenaCard.test.tsx`.
