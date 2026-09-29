# The Advertise page is on the console (2026-09-22)

`src/pages/ClubAdvertisePage.tsx` and its stylesheet are rebuilt on Dan's
approved master art. It was the highest-scoring generic surface left in the
app on the #ClubArenaConsole inventory: **34** (13 corner radii, 8 gradients
and box shadows, 22 pixel font sizes, zero references to `club-buttons/`).
After this it scores **0** and drops off the list, which now reads three
surfaces to go.

Sheets: [club mode](./shots/sheet-advertise-club.jpg),
[sponsor mode](./shots/sheet-advertise-sponsor.jpg). Both are the real
component rendered headless at 393px with the real fonts and the real global
CSS, before beside after.

## Why it was still generic

The page was skipped in the earlier sweep because its console version needed
the sponsor pricing and country targeting that `AdCampaignService` carries,
and a restore had dropped that service. `src/services/AdCampaignService.ts`
is on `main` today (`git cat-file -e origin/main:src/services/AdCampaignService.ts`
passes), so the reason is gone.

## What it was, and what it is

It was six rounded navy cards on a three-stop page gradient, each with its own
border, its own radius and its own heading; a cyan gradient pill for the
primary action; a hatched dashed rectangle per advertising surface; a filled
capsule per campaign status; and a `U+25C6` glyph typed in wherever diamonds
were mentioned.

It is now **five consoles cut from the approved masters**, one per section,
each with its own crest so the page is not one chassis repeated (Dan,
2026-09-13: "I DO NOT WANT EVERY SINGLE CARD TO LOOK EXACTLY THE SAME"):

| Console       | Master                | What it prints                                                                                     |
| ------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| Advertise     | spade head, flat foot | club name or Smarter.Poker in the eyebrow, the lede on the glass, the diamond balance as a row     |
| Your Business | shark, one plate      | sponsor mode only: business name and contact email, SAVE on the painted blue plate                 |
| Where It Runs | club crest, flat foot | one engraved row per surface: its true shape, its label, its price, its exact creative size        |
| Your Pictures | diamond crest         | the surface creative and the 3:4 poster, each in a well cut into the glass, both pickers lit words |
| The Details   | shark, one plate      | headline, destination, days, audience, the total, and PAY AND SUBMIT on the plate                  |
| Your Adverts  | flat crest            | one engraved row per flight, its status in the master's own ink, the day by day table              |

Nothing on the page draws a control any more. Every figure is a row closed by
an engraved rule (a black line with an 8% inner light, the cut the master's own
chrome rules are made of), every field is a groove in the glass, every
secondary action is a lit word, and the two primary actions are labels laid
over plates that are painted in the art. Sizes are `cqw` against the console,
so a 320px phone and a 430px one get the same picture, and each console is
capped at 560px so a wide screen gets black margin rather than a bigger phone.

## Defects found and fixed in the same pass

The redesign is the audit. Four things were wrong before it and are not now.

1. **A tall surface made the rate card unusable.** Every surface shows its
   TRUE shape, which is the point of the picker - but Empty State is 1080 by
   1440, and at full body width that is a screen and a half of empty box for
   one row. `shapeStyle()` caps the WIDTH at `band * ratio`, which bounds the
   height at one band without touching the aspect ratio: a 6:1 banner still
   fills the body, a 3:4 poster shrinks to the same band height as everything
   else.

2. **A campaign on a surface with no rate card row printed its raw enum.**
   `rates.find(...)?.label ?? c.slot` put `lobby_strip` on the screen. It goes
   through `enumToTitleCase()` now, and the same for a display status with no
   label.

3. **Data reached the screen in whatever case the database held** (Dan,
   2026-09-14: "THE FIRST LETTER OF EVERY WORD MUST ALWAYS BE CAPITALIZED",
   with no exception for where the string came from). The rate card blurb, a
   campaign headline, the review note from the house and the club and business
   names now all print through `titleCase()` at the print site. Filenames do
   not: a picked file has to stay recognisable as the file that was picked.

4. **A campaign with no picture rendered `<img src="">`,** which asks the
   browser to download the whole page again. The picture well is only rendered
   when there is a picture.

## What was deliberately preserved

Every handler, guard and pinned literal. Nothing about the money moved: the
price is still the database's, `canAfford` still treats an unreadable balance
as "we do not know" and shows a dash rather than a zero, the role read still
fails closed, both uploads still go into their own folder before the RPC is
called, and both confirm dialogs carry the same words. The diamond figures are
still `toLocaleString()` in full - a buyer is paying an exact number, and
`ClubDiamondCostsPage` already sets that precedent on the console.

The two `aspectRatio` inline styles `tests/unit/houseAds.test.ts` and
`tests/unit/advertiserSelfServe.test.ts` pin are untouched, as are
`.club-advertise__preview--poster` and `.club-advertise__days`.

One kit fact worth recording: **the shark family's title and subtitle zones
overlap.** `SHARK_CONSOLE_ZONES.title` runs y 76 to 142 and `subtitle` runs
y 126 to 148 on a 154-tall head, so a console that passes both prints one over
the other. The first render of this page did exactly that. The shark consoles
here pass a title and no subtitle; `WaitListModal`, the only other shark
caller, never passed one.

**Fixed the same day.** The shark and riveted heads now carry measured
three-line bands and a shark console prints a title and a subtitle cleanly;
`tests/painted-zones-never-overlap.law.test.ts` keeps them apart. Nothing on
this page moved. See
[`2026-09-22-the-console-zones-that-sat-on-each-other.md`](./2026-09-22-the-console-zones-that-sat-on-each-other.md).

## Verified

`npx tsc --noEmit -p tsconfig.app.json` clean. `check-css-modules`,
`check-title-case`, `check-painted-text-case`, `check-nav-title-case`,
`check-ui-text`, `check-no-emoji`, `check-horses-are-players` and
`check-discarded-read-then-write` all OK. `verify-source-bindings.py`: 759
pins intact. `npx eslint` on the page: silent. Green:
`tests/unit/advertiserSelfServe.test.ts`, `tests/unit/houseAds.test.ts`,
`tests/unit/classNamesResolve.test.ts`,
`tests/unit/discardedErrorReadRatchet.test.ts`,
`tests/no-hover-effects.law.test.ts`,
`tests/the-console-standard-stays.law.test.ts`.

Rendered at 393px in club mode, sponsor mode and the empty-ledger state.
