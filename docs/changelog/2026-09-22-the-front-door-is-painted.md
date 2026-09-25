# The Front Door Is Painted Now (2026-09-22)

`src/pages/PokerArenaLandingPage.tsx` was the last surface in the arena still
drawing its own chrome. It is now five #ClubArenaConsole frames cut from Dan's
approved masters.

Before and after, rendered headless at 393px on black:

- [Hero and the closing call to action](./shots/sheet-arena-landing-hero.jpg)
- [The three content consoles](./shots/sheet-arena-landing-body.jpg)
- [The whole page](./shots/sheet-arena-landing-full.jpg)

## What was generic

The inventory (`node .claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs`)
scored it 16: five corner radii and six gradients or box shadows, and not one
reference to `club-buttons/`. Concretely, the page drew:

- a `linear-gradient(180deg, #6cc1ff, #3aa8ff)` pill with a 30px blue glow for
  the primary call to action, and a `1px solid rgba(185, 202, 215, 0.45)`
  outline for the secondary one, both at `border-radius: 6px`;
- six feature cards, each a `border-radius: 6px` box with its own
  `linear-gradient(160deg, ...)` fill and a 22% white border;
- three step cards in the same dress, each with a `border-radius: 50%` blue
  disc behind its numeral;
- a closing panel with a third gradient, `linear-gradient(110deg, ...)`;
- a page background of its own: a radial blue wash over a vertical ramp, plus
  three page-local colour tokens (`--trust-black`, `--trust-chrome`,
  `--trust-blue`) that exist in no schema.

Every one of those is a control drawn in CSS. The master paints all of them.

## What the console prints now

Five `SpadeConsole` frames, one per section, each wearing a different crest so
no two frames on the page are the same picture (Dan 2026-09-13: "I do not want
every single card to look exactly the same"). All five are cut from the same
1000-wide spade master; only the emblem changes.

| Section                 | Crest   | Foot       | Zones printed into                                 |
| ----------------------- | ------- | ---------- | -------------------------------------------------- |
| Hero                    | spade   | two plates | `eyebrow`, `title` (as the h1), `subtitle`, `pill` |
| Everything A Club Needs | club    | flat cap   | `eyebrow`, `titleBesidePill`, `pill`               |
| How Poker Arena Works   | diamond | flat cap   | `eyebrow`, `titleBesidePill`, `pill`               |
| Fair Play, In Writing   | vip     | flat cap   | `eyebrow`, `titleBesidePill`, `pill`               |
| Ready To Deal?          | flat    | two plates | `eyebrow`, `titleBesidePill`, `pill`               |

Everything between head and foot prints on the black glass: feature and step
titles in the master's lit blue and engraved silver, body copy in `sc-copy`,
and an engraved rule between rows (a black top edge with an 8% inner light)
rather than a drawn divider. The step numerals are the numbers, lit; the disc
they used to sit on was a control the art does not paint. The six resource
links are lit words cut into the glass, each with a 44px target.

`PokerArenaLandingPage.module.css` went from 186 lines of chrome to 108 lines
that only type text: no radii, no gradients, no fills, no borders around
content, no page-local colour tokens, no `:hover`. Every size is `cqw` against
the console, so 375px and 393px get the same picture.

## Two additions to the shared kit, and why each was forced

**`PlateButton` accepts an `href` and becomes an anchor.** Both ways in leave
this app (the World Hub sign-up form and the shared sign-in route), this route
is prerendered for crawlers that never run the bundle, and a button that calls
`location` is not a link to any of them; it also has to survive a middle click
and a long press. The art, the zone and the fit are identical, only the element
changes. It is ONE optional field rather than a second props type in a union:
the union version was written first and cost every existing caller its
contextual typing, turning `TournamentLobbyCard`'s inline `onClick` into an
implicit `any` the moment `plates` accepted two shapes.

**`SpadeConsole` accepts `titleAs`, defaulting to `'h2'`.** This is the one
surface where the console's painted title zone is the document's top-level
heading, and `scripts/prerender-public-routes.mjs` refuses to publish a page
with no `<h1>` in its rendered region. The hero's title zone is now
`<h1>Poker Arena</h1>` with `Private Online Poker Clubs` in the subtitle zone
beneath it. The page keeps exactly one `<h1>`, and heading order now runs
h1, h2, h3 instead of starting at h2.

## Every console carries a pill, and that is not decoration

The first render had none, and it showed two defects at once. The master head
PAINTS the pill slot whether or not a word goes into it, so an empty one reads
as a frame with a piece missing; and with no pill the console prints its title
into the wider `title` zone, so `HOW POKER ARENA WORKS` had its last letter
sitting on the pill's chrome rim. That is exactly what
`SPADE_CONSOLE_ZONES.titleBesidePill` exists for, and the console selects it
the moment a pill is present. Each word is a fact the section already states:
the account is free, there are six things a club gets, there are three steps,
the rules are public.

`Everything A Poker Club Needs` was shortened to `Everything A Club Needs` in
the same pass, because at the narrower zone the longer string hit
`useFitText`'s floor and would have been clipped by the zone rather than fitted
inside it. The primary plate label is `Create Account` rather than
`Create A Free Account` for the same reason: it fits its painted face with air.
The word "free" is still on the page four times, including in the hero's own
pill.

## The prerender, which is what makes this surface different

`/` is in `src/prerender/entry-server.tsx`'s route map, so this component's
markup is also the static HTML in `dist/index.html`. Checked on the built
output, not reasoned about:

- `npm run build` is green end to end, prerender included:
  `[prerender] / -> dist/index.html (335 words)`, over the 120-word floor
  `verifyDocument` enforces;
- the rendered region carries `<h1 class="sc-zone sc__title sc-ink--silver">Poker Arena</h1>`;
- both ways in are real anchors in the static markup, with their real hrefs
  (`/auth/login?redirect=%2Fhub%2Fclub-arena%2F` and the absolute World Hub
  sign-up URL). No JavaScript is needed to follow either;
- every zone's position is an inline percentage, so the static page is laid
  out correctly before the bundle boots;
- the inlined page CSS rebases every art URL to the web sub-path, for example
  `url(/hub/club-arena/assets/club-buttons/console/spade-console-v1/top.png)`,
  and all eight referenced files are present in `dist/`;
- `renderToString` produced no React warning. Nothing on this page reads
  `window`, layout or a browser API while rendering; `useFitText` is a layout
  effect, so the static HTML ships each label at its designed size and the
  browser fits it on mount.

## Measured

- `scripts/ci/route-performance.mjs`, mobile `/hub/club-arena/`:
  LCP **764ms** (budget 4000ms), **CLS 0.000** (budget 0.15), transfer
  **1411kB** (budget 3MB). CLS is zero because each slice's box is sized by
  its own `aspect-ratio` before the art arrives, which the old page's
  unsized cards could not do.
- `scripts/ci/public-a11y.mjs`: **0 violations** on `/hub/club-arena/` at both
  the phone and the desktop viewport, blocking and advisory.
- `scripts/ci/entry-chunk-delta.mjs`: nothing new before first paint. The page
  is still lazy in `src/App.tsx`, and `SpadeConsole` was already a reviewed
  entry-chunk module.
- The inventory now scores this surface 0.

## What was deliberately not done

- The riveted and shark masters were not used. Either would have been a
  legitimate second family, but riveted alone is 561kB of PNG and shark is
  302kB, against the four alternate spade crests at roughly 160kB each, on the
  one page in the arena where first paint is a search ranking input.
- `tests/the-public-arena-is-indexable-and-the-private-arena-is-not.law.test.ts`
  was NOT edited. It reads this source for the four literal
  `trackCta('sign_up', 'hero')`-shaped calls, and the first draft had factored
  them into one `waysIn(placement)` helper, which made the pin unreadable. The
  calls were restored as literals at four call sites instead, which is the
  console standard's trap 7.6 ("two literal branches beat one clever ternary")
  applied to an analytics pin. No source binding needed restamping.
- No new law was written. Nothing here is a rule Dan has stated that the
  existing laws do not already pin.

## Preserved

`window.scrollTo(0, 0)` and the `landing_viewed` capture on mount; all four
`landing_cta_clicked` combinations (`sign_up`/`sign_in` x `hero`/`closing`);
`<main className={styles.page} id="main-content" tabIndex={-1}>`, which is the
skip link's target and the page's only landmark; every feature, step and
resource string; the `features-heading`, `steps-heading` and `trust-heading`
ids and the `aria-labelledby` that points at each; `aria-label="Poker Arena Resources"`
on the resource nav. The page still fetches nothing.
