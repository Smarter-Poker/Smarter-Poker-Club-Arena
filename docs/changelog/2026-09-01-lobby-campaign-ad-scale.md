# Desktop lobby ad: scaled to the bay instead of cropped by it

Dan, verbatim:

> on desktop in the club arena again, the 'dynamic ad image' is cut off, and it
> needs to scale to size. because when you 'shrink the page' it fits perfectly

## Root cause: two crops of one ad, meeting two different bays

The campaign well is the promo strip inside the lobby's FIND YOUR GAME panel
(the "$250,000 GTD MAIN EVENT / LEARN MORE" artwork).

There are two files of the same artwork in
`public/assets/club-buttons/lobby/`:

| File                                       | Size       | Aspect                                | Served      |
| ------------------------------------------ | ---------- | ------------------------------------- | ----------- |
| `shark-club-championship-ad-v2.png`        | 2172 x 724 | 3:1, ad centred in a tall black field | above 900px |
| `shark-club-championship-ad-mobile-v4.png` | 2172 x 302 | 7.2:1, the identical ad cropped tight | below 900px |

On desktop `.club-lobby-machine > .club-lobby-command-top` is `display: contents`,
so the campaign well is a flex item of the machine column with `min-height:
92px` and nothing telling it how tall to be. At a 1440px viewport the right
column is about 1000px wide, so the bay is roughly **11:1** — and the base rule
`.club-lobby-command-top__campaign-button img { object-fit: cover }` was never
overridden for desktop. Cover on a 3:1 image inside an 11:1 bay keeps the middle
**28%** of its height. The ad's content band is about the middle 45%, so the top
of the trophy and the entire "SATURDAY, JUNE 14 / $530 BUY-IN / LATE REG 8
LEVELS" line were sliced off.

Below 900px the tight 2172 x 302 crop is served into a bay whose `aspect-ratio`
is that exact ratio, with `object-fit: contain`. That is Dan's "shrink the page
and it fits perfectly", and it is the correct arrangement for a short wide bay
at any width.

## The fix

The tight crop is not a phone variant. It is the shape this bay actually is, at
every width. So:

- **`src/pages/ClubHomePage.tsx`** — the house ad resolves to the tight crop for
  both regimes. The breakpoint-scoped `<source>` is gone because both regimes
  now want the same file; the `<picture>` wrapper stays because it is the box
  the campaign CSS sizes, and because that is where a per-breakpoint `<source>`
  goes if a club ever ships two crops of its own banner. The 3:1 file is still a
  real asset used by the tournament lobby, tournament results and the arena
  workspace pages, so nothing was deleted.
- **`src/components/lobby/ClubLobbyCommandTop.css`** — a final
  `@media (min-width: 901px)` block gives the bay `aspect-ratio: 2172 / 302` so
  its height comes from the artwork rather than a fixed 92px, and sets
  `object-fit: contain` on the image. Appended at the end of the file
  deliberately: this stylesheet has ten overlapping campaign blocks and the last
  one is the one that wins.

`contain` is the guarantee rather than the layout. A club's own `banner_url` can
be any shape at all, and `contain` means the worst case is black at the sides,
never a headline with its top sliced off.

`max-height: clamp(96px, 13vh, 156px)` is the ultrawide guard: on a 2560px
monitor the bay is ~1800px wide and `2172 / 302` alone would make it 250px tall,
which would eat the game list. When that cap binds the ad letterboxes; it still
never clips.

## Breakpoints checked

- **1440px and up** — bay ~1000 x 139, ad full bleed, nothing cropped.
- **901px to 1440px** — same rule; the bay shrinks with the column and the ad
  scales with it.
- **900px and below** — untouched. Same file, same `aspect-ratio: 2172 / 302`,
  same `contain` it already had.
- **430px and below, including 375px** — untouched, and it was already the
  breakpoint that fit.

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run tests/unit/lobbyCampaignScale.test.ts
tests/club-lobby-premium-machine.test.ts` — 24 tests, all passing.
- New `tests/unit/lobbyCampaignScale.test.ts` pins the three things that would
  bring the crop back: the bay's aspect ratio, `contain` (and the absence of
  `cover`) in the winning desktop block, and the lobby no longer reaching for
  the 3:1 file.
