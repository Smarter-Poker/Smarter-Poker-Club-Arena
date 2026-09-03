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

## The pin that went red, and why it was the pin's fault

`tests/unit/lobbyUnionCreateControls.test.ts >  keeps the desktop selector deck
sticky and mobile controls inside the approved chassis` failed on this branch:

    AssertionError: expected '@media (min-width: 901px) {\n .club-…'
    to contain 'display: contents'

That looks like a collision between this fix and the deck lock, because
`display: contents` on `.club-lobby-machine > .club-lobby-command-top` is what
makes the campaign well a bare flex item with only `min-height: 92px` - the
condition this fix exists to correct. It is not one. **`display: contents` was
never touched by this branch**, and it is still exactly where it was, at
`ClubLobbyCommandTop.css` line 1946.

The pin sliced its subject out with

    commandCss.slice(commandCss.lastIndexOf('@media (min-width: 901px)'))

which is a guess about file order, not a statement about the deck lock. This
fix appends a SECOND `@media (min-width: 901px)` block - the campaign bay - so
`lastIndexOf` re-pointed the pin at the ad block, which of course declares
neither `display: contents` nor `position: sticky`.

So neither side was wrong and nothing was weakened. Both tests now find their
block by what it declares:

- `lobbyUnionCreateControls.test.ts` anchors on
  `.club-lobby-machine > .club-lobby-command-top {` (one occurrence in the
  file) and walks back to the `@media (min-width: 901px)` that opens it. All
  three declarations - `display: contents`, `position: sticky`, `top: 0` - are
  still asserted, about the block that owns them.
- `lobbyCampaignScale.test.ts` had inherited the identical `lastIndexOf`
  fragility and would have broken for the next author who appended a desktop
  block. It anchors on this block's own `DESKTOP CAMPAIGN BAY` header.
  `.club-lobby-command-top__campaign` alone is not an anchor - eighteen blocks
  declare it.

The two rules genuinely coexist: `display: contents` decides how the campaign
well participates in the machine column, and this fix gives that well an
`aspect-ratio` and `object-fit: contain` so it no longer depends on
`min-height: 92px` to have a shape. Different properties, same element, no
conflict.

## Re-verified after the test fix

Measured in headless Chromium against the real `ClubLobbyCommandTop.css` and
the real DOM shape, with the ad column at its production ~1000px width. `drawn`
is the rendered content box of the `contain`-fitted image; `CLIPPED` compares
it against the element box:

    2560x1440  bay=996x138.5  drawn=960x133.5  contain  CLIPPED=false
    1920x1080  bay=996x138.5  drawn=960x133.5  contain  CLIPPED=false
    1440x900   bay=996x117    drawn=805x112    contain  CLIPPED=false
    1200x900   bay=996x117    drawn=805x112    contain  CLIPPED=false
     901x800   bay=897x104    drawn=712x99     contain  CLIPPED=false
     900x800   bay=892x124    drawn=784x109    contain  CLIPPED=false
     430x932   bay=422x58.7   drawn=314x43.7   contain  CLIPPED=false
     375x812   bay=367x51     drawn=259x36     contain  CLIPPED=false

Nothing clips at any width. At 1440x900 the `max-height: clamp(96px, 13vh,
156px)` cap binds before the aspect ratio does, so the ad letterboxes to 805 of
996px rather than filling the bay - that is the documented ultrawide/short-
viewport guard doing its job, and letterboxing is the outcome the guard was
written to prefer over eating the game list.
