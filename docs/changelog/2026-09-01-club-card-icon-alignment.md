# Club identity card: icons level with the IDs, Playing Now lower, and the card only shrinks

Dan, 2026-09-01, with two screenshots (desktop and mobile):

> 1. INSIDE THE CLUB CARD, THE CLUB ICON AND THE PROFILE ICON NEED TO SHIFT DOWN
>    TO BE EVEN WITH THE "ID" NEXT TO IT.
> 2. 176 PLAYING NOW NEEDS TO BE MOVED DOWN MORE.
> 3. WHEN YOU SWITCH TO MOBILE VIEW, IT GETS DISTORTED, COPY ICON MOVES OUT OF
>    ITS FRAME, CLUB AND PROFILE ICON SHIFT... (IT CAN'T DISTORT, ONLY SHRINK)

## What was actually wrong

Measured before touching anything, with a Playwright harness that loads the real
component CSS and the real lobby nesting and reports every part of the card as a
percentage of the card box:

| part           | at 1024px (card 314x131) | at 375px (card 173x72) | artwork anchor   |
| -------------- | ------------------------ | ---------------------- | ---------------- |
| club ID line   | centre 52.42%            | centre 57.14%          | icon at 49.05%   |
| player ID line | centre 62.51%            | centre 70.36%          | icon at 59.78%   |
| Playing Now    | bottom 80.88%            | bottom 81.47%          | -                |
| share button   | x 78.1-85.6%             | x 71.8-97.2%           | frame 75.9-85.6% |

Three separate causes, one shape:

1. **The ID lines were rows three and four of the club-name grid.** Their
   vertical position was a by-product of the club name's row height, so it
   drifted from the icons that label them - 3.37% off on desktop, 8.09% on
   mobile.
2. **The card carried breakpoint overrides that mixed pixels and
   per-breakpoint percentages** into a box whose artwork scales purely with
   width: `@media (max-width: 900px)` moved the details bay, `@media
(max-width: 360px)` re-picked font sizes, and `@media (pointer: coarse)`
   gave the share button a fixed 44x44px body. On a 72px-tall card that button
   was 61% of the card's height and its right edge sat at 97.2%, which is
   precisely the copy icon walking out of its painted frame.
3. **`translateY(1.65cqw)` and `margin-top: 1.4cqw`** are WIDTH-derived nudges
   applied to VERTICAL positions. The lobby card is stretched to 2.4/1, so
   1cqw is 2.4% of its height there and 1.73% of a native card's - the same
   declaration moved things by different amounts in different places.

## What changed

**`src/components/club-buttons/ClubIdentityCard.css`** - rewritten around one
rule, stated at the top of the file: every position is a percentage of the card
box taken from the artwork, every size is `cqw`, there are no breakpoint
overrides, and no painted value carries a pixel or rem bound. A `clamp()` with a
rem floor is a rearrangement that waits for a narrow enough card.

- `.club-identity__ids` is a new bay pinned at `top: 47.06%` with two 10.73%
  rows, putting the ID lines' centres on 52.42% and 63.15% - the icon centres.
- `.club-identity__details` keeps the club name and alias only, with the alias
  offset moved from `translateY(1.1cqw)` into the row heights so it lands in
  the same place on any card ratio.
- `.club-identity__playing` bottom edge moved from 80.88% to 85%, and it stops
  at the copy frame's left edge so a six-figure count clips rather than runs
  under the button.
- `.club-identity__share` occupies the painted copy frame exactly
  (`left: 75.92%; top: 65.19%; width: 9.68%; height: 15.88%`), and its 44px
  thumb target is now an invisible `::after` band. The band paints nothing, so
  unlike the old rule it cannot move anything.

**`public/assets/club-buttons/club/club-identity-template-no-level-v3.png`** -
the club and profile icons moved DOWN 32px (3.37% of card height), uniformly, so
their spacing is unchanged and both land level with the ID lines. New filename
because v2 is already in browser and CDN caches. v2 is left on disk for one
release so a client running a cached bundle does not 404 its own card art; it
can be deleted after this ships.

**`src/components/club-buttons/ClubIdentityCard.tsx`** - the two `IdentityLine`s
moved into the new `.club-identity__ids` wrapper.

**`src/pages/dev/ArenaGameCardsShowcasePage.css`** - dropped a 15px pixel size
on the share icon that made the showcase lie about what the real card does.

## Verification

- Re-measured with the same harness at 1024, 900, 600, 420, 375 and 320px: the
  ID lines land within 0.05% of their icons and every part of the card reports
  the SAME percentage at every width. The card is now the desktop card, scaled.
- Rendered screenshots at 1024 and 375 and compared them side by side.
- `npx tsc --noEmit` clean.
- `npx vitest run tests/` - 805 files, 11147 tests, all passing.
- `npx playwright test tests/e2e/club-mobile-wallet-reach.spec.ts` passes, which
  is the beat that proves Share still owns a 44px thumb target at 375px.

Test pins updated in the same commit, with the reason written beside them:
`tests/unit/lobbyTournamentBoardDesign.test.ts` and
`tests/club-lobby-premium-machine.test.ts` pinned `translateY(1.65cqw)`,
`margin-top: 1.4cqw` and the `@media (pointer: coarse)` 44px button. Those three
declarations are the bug, so the pins now guard the cure instead: the ids bay,
the share button's frame percentages, the `::after` band, and - as a standing
guard - that this file contains no `@media (max-width`, no
`@media (pointer: coarse)`, and no `rem` bound.

## Left alone deliberately, and raised with Dan

The logo box is `width: 21.7%` with `aspect-ratio: 1/1`, which on the lobby's
2.4/1 card resolves to 52% of the card's height and spans 25.95-78.02%. The
artwork's logo frame opening is 21.45-62.57%, and the Level box starts at
72.80%, so today the logo overflows its frame and runs under the Level box -
which section 10.7's ruling says must never happen. Fixing it means resizing
Dan's club logo on screen, which he did not ask for, so it is reported rather
than changed.
