---
name: club-arena-console
description: >
  The #ClubArenaConsole painted-chassis standard: how to rebuild a generic Club
  Arena page, popup, card, frame or button on Dan's approved master art, verify
  it in a headless render at 393px, and ship it. Use when the user writes
  "#ClubArenaConsole", says a surface is "still generic", "boring", "needs to be
  on the master" or "needs upgrading", asks to redesign or restyle anything in
  Club Arena, or asks for before/after screenshots of a Club Arena surface.
  Every agent or subagent doing the work must read this file in full and pass it
  to any subagent it spawns.
version: 1.5.0
---

# #ClubArenaConsole — The Painted-Chassis Standard

The Club Arena counterpart to `#SmarterCasinoRealism`. That standard governs the
Marketplace / Diamonds language. **This one governs Club Arena**, where the rule
is stricter: you do not _style_ a surface, you **rebuild it on Dan's approved
master render**.

Repo: `Smarter-Poker-Club-Arena`. Read `CLAUDE.md` and `AGENT-PLAYBOOK.md` first;
they own deployment, money and law. This document owns the picture.

---

## 0. The one idea

> **Paint what never changes. Print what does.**

Every frame, plate, bay, rail, well and pill is **already painted** in a master
PNG that Dan approved. Your job is to lay live DOM text into measured zones on
that art — never to draw a button, a border, a gradient or a pill in CSS.

If you catch yourself writing `border-radius`, `linear-gradient` or `box-shadow`
to make something _look like_ a control, stop. The control exists in the art.
Find its pixel coordinates and print into them.

### 0.1 Marketplace adaptation: preserve the store, upgrade its parts

When Dan asks a Marketplace, VIP, Rewards, Merch or Club Shop surface to share
the #ClubArenaConsole **look and feel**, that is not permission to replace its
information architecture with one Spade Console, attach every store to one
display window, or invent destination-selector objects. Preserve the existing
page layout, routes, labels, data, controls and purchase flow. Upgrade the real
cards, filters, rows, buttons, frames and typography in their existing places
with an appropriate approved painted family.

The adaptation rules are strict:

- Same visual language does not mean a one-to-one clone. Each store keeps its
  own layout and function while sharing material quality, lighting, inks and
  control craftsmanship.
- Never create a selector, showcase frame or empty replacement card merely to
  demonstrate the style. If the existing layout has no job for it, it does not
  ship.
- Approved product art stays approved. In particular, the existing gold VIP
  card artwork and layout are immutable unless Dan explicitly asks to replace
  them. Plan name, price, term, Diamond price and selection state remain live
  DOM text in the artwork's established zones.
- Keep Marketplace navigation on the current surface. Never add
  `target="_blank"` or call `window.open`; use the existing in-app route, page,
  modal or iframe contract.
- Never stretch a fixed-height master to fit a variable-height product,
  fulfillment or benefit card, and never 9-slice across a painted feature. Use
  native-ratio top, middle and bottom slices. If no approved slice family can
  fit the content, preserve a controlled existing frame, report the art gap
  and do not fabricate a substitute.
- Never trade commerce correctness for a visual upgrade. Preserve exact
  account, request and offer ownership, idempotency and durable-intent
  compare-and-swap guards, stale-async response rejection and unmount safety.
  Verify every purchase from its UI trigger through the authoritative receipt.
- Upgrade the real interactive element in place. A floating line icon, emoji,
  generic font glyph or Lucide-style overlay is not an upgrade. Seat the icon
  in the painted art or remove it and use a clear text label.
- Marketplace surfaces do not use green. Success and available states use the
  approved cyan, silver or gold inks; red remains reserved for refusals and
  destructive actions. This Marketplace rule overrides the general green ink
  token below when adapting a store surface.
- Marketplace throwables are one all-access credit product, never separate
  Tomato, Egg, Snowball, Water Gun or Boxing Glove listings. Its art is a
  clean-alpha composite made from the actual in-game throwable assets; test it
  on white, black, cyan and magenta before release.
- When before-and-after proof is requested, the final after image comes from
  the exact published production build. A local render is a development gate,
  not release proof.

---

## 1. Dan's law

Quoted verbatim, with what each one means at the keyboard. These were paid for
one review round at a time. Do not relitigate them.

| Dan                                                                                                                                                                                                     | In practice                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "CLEAN FRAMES"                                                                                                                                                                                          | One frame per surface. Nothing partial, nothing cut off, nothing incomplete at any edge.                                                                                                                                                                                                                                                                                                                                                                  |
| "CLEAN CONSISTENT BACKGROUNDS (INSIDE THE CARD, BUTTON OR ICON AND OUTSIDE IT)"                                                                                                                         | One tone inside a well and outside it. An inpaint band that is lighter than the glass beside it is a defect.                                                                                                                                                                                                                                                                                                                                              |
| "NOTHING CAN BE COPY PASTED OR OVERLAPPED"                                                                                                                                                              | Never repeat a plate PNG twice on one surface, never overlay art on art.                                                                                                                                                                                                                                                                                                                                                                                  |
| "ALL FONTS AND BUTTONS MUST BE CENTERED INSIDE THEIR FRAMES"                                                                                                                                            | Text is centred in the painted **face**, not in the zone box.                                                                                                                                                                                                                                                                                                                                                                                             |
| "FRAMES SHOULD NEVER SIT ON TOP OF FRAMES"                                                                                                                                                              | No CSS card around a painted card. The art is the frame.                                                                                                                                                                                                                                                                                                                                                                                                  |
| "EVERYTHING MUST BE CLEAN AND CRISP"                                                                                                                                                                    | Native resolution, native ratio. Never stretch, never 9-slice across a feature.                                                                                                                                                                                                                                                                                                                                                                           |
| "ALL ICONS SHOULD FEEL ORGANIC, AND BUILT INTO THE FRAMES"                                                                                                                                              | An emblem is part of the render or it is not there. Never a glyph stuck on top.                                                                                                                                                                                                                                                                                                                                                                           |
| "ALL BACKGROUNDS ON EVERYTHING MUST ALWAYS BE REMOVED"                                                                                                                                                  | Transparent PNGs on black. No panel fills.                                                                                                                                                                                                                                                                                                                                                                                                                |
| "ALL FONTS MUST FEEL ORGANIC AND NATURAL AND MATCH THE LOOK AND FEEL OF THE DYNAMIC IMAGE THEY ARE INSIDE OF"                                                                                           | Use the master's own inks (see §3.4), Roboto Condensed for chrome type, Inter for copy.                                                                                                                                                                                                                                                                                                                                                                   |
| "YOU CAN NEVER JUST COPY AND PASTE A BUTTON, CARD OR ANYTHING EVER, YOU MUST CREATE IT"                                                                                                                 | Derive new art from the master by surgery (§5), never by duplicating a component.                                                                                                                                                                                                                                                                                                                                                                         |
| "THE FIRST LETTER OF EVERY WORD MUST ALWAYS BE CAPITALIZED" (2026-09-14)                                                                                                                                | Every word a player reads, with no exception for where the string came from. Literals are gated; DATA IS NOT: a scenario name, a config label, a DB row, an enum, a hand name reaches the screen through `titleCase()` from `src/utils/titleCase.ts` at the print site. A lower-case word in a render is a defect, not a data quirk.                                                                                                                      |
| "NOTHING SHOULD EVER REVEAL A HORSES IDENTITY" (2026-09-14)                                                                                                                                             | No badge, tag, toggle, filter, column, export or label in the client says which players are horses. Totals count everyone. `is_horse` stays in the plumbing and never reaches a screen. Law: `tests/a-horse-is-never-named.law.test.ts`.                                                                                                                                                                                                                  |
| "THESE POP UPS OR EVENT LOGS (IF INTERNAL USE ONLY) DO NOT NEED DYNAMIC IMAGES AND POP UPS" (2026-09-14)                                                                                                | A surface no player and no club operator can reach - the QA harness, the bus event log, the platform's own engine, analytics and ads dashboards, anything under `src/pages/dev/` - is a tool for the house. The copy laws and the colour schema still bind it; the painted chassis does not. The inventory scanner carries the list in `INTERNAL_ONLY` and leaves them off the sweep. A CLUB owner is a customer: every operator page they open stays in. |
| "NEVER USE DECIMAL POINTS ON ANY FORWARD FACING PAGE"                                                                                                                                                   | `compactChips()`. Whole numbers under 1,000.                                                                                                                                                                                                                                                                                                                                                                                                              |
| "ONCE SOMETHING HITS OVER 1,000 USE 1K, IF ITS 1200 USE 1.2K, IF ITS 10,000 USE 10K"                                                                                                                    | One decimal above 1K, **always rounded down**, `.0` stripped. Never overstate.                                                                                                                                                                                                                                                                                                                                                                            |
| "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS"                                                                                                                                      | §3.4 only.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| "MAKE SURE FONT SIZES NEVER GO OVER THE EDGES OF THE FRAME"                                                                                                                                             | Every printed string is fitted (§3.3), and fits the face, not the rim.                                                                                                                                                                                                                                                                                                                                                                                    |
| "THE SLIDER NEEDS TO GO UP AND DOWN, NOT SIDE TO SIDE (SIDE TO SIDE SWIPES THE PAGE)"                                                                                                                   | Vertical range inputs at the felt; a horizontal drag is the table-switch gesture.                                                                                                                                                                                                                                                                                                                                                                         |
| "THEY SHOULD JUST BE STAND ALONE IMAGES WITH FRAMES AROUND THEM"                                                                                                                                        | Nothing paints outside the frame. See the tiling trap, §7.1.                                                                                                                                                                                                                                                                                                                                                                                              |
| "I PREFER IT WITH ONLY AN ICON AT THE TOP ... IT SHOULD BE A FLAT BOTTOM"                                                                                                                               | Crest at the top, flat closing cap at the bottom, no chip.                                                                                                                                                                                                                                                                                                                                                                                                |
| "I DON'T WANT EVERY SINGLE FRAME AND BUTTON TO BE 100% EXACTLY THE SAME, JUST THE SAME STYLE"                                                                                                           | Dress may vary (emblem / no emblem). Structure may not.                                                                                                                                                                                                                                                                                                                                                                                                   |
| "I DO NOT WANT EVERY SINGLE CARD TO LOOK EXACTLY THE SAME, THEY SHOULD NOT ALL HAVE THE SAME FRAME, WITH THE SAME SPADE AT THE TOP MIDDLE ... NOT ALL THE SAME BORING COOKIE CUTTER STYLE" (2026-09-13) | One chassis with five badges is not variety. Frame FAMILIES are cut from the master by surgery (§5) and assigned by section; each family has its own crests and ink. This supersedes "structure may not vary" above: structure varies BETWEEN families, never within one.                                                                                                                                                                                 |
| "THE 'SPADE' ICON IS PERFECT, HIGH DEFINITION DYNAMIC ICON WITH DEPTH AND THE 3D LOOK AND FEEL ... THE REST ARE ALL CHEAP LOOKING, FLAT AND BORING" (2026-09-13)                                        | Every crest matches the spade: a polished-chrome catch on the emblem, a quilted body, a blue LED at its base, and the rails MITRED INTO the housing. The club, diamond and crown crests fail all four and are to be repainted (§3.6).                                                                                                                                                                                                                     |
| "YOU MUST STICK TO THE SMARTER.POKER COLOR SCHEMA" (2026-09-13)                                                                                                                                         | Every colour on a surface is a token the schema already owns. Never a derived tone, not even a darkened one: 24 "shadow" stops computed from the browns they replaced were rejected on sight. See §3.4.                                                                                                                                                                                                                                                   |
| Rates keep one decimal (2026-09-13)                                                                                                                                                                     | The no-decimals rule is for chip counts. A percentage RATE (rakeback, commission, VPIP) keeps one decimal, because rounding 32.5% to 33% misstates a number a club owner is paid on, and the same law says never overstate.                                                                                                                                                                                                                               |
| The desktop ceiling (2026-09-13)                                                                                                                                                                        | A console stops growing at the master's own width (1000px) and centres. The art is never asked for more pixels than it has; a wide screen gets black margin, not a bigger phone. `--sc-max` may narrow it, never raise it.                                                                                                                                                                                                                                |

**When Dan corrects something, fix it in the master or the kit — not in the one
surface he happened to point at.** Every surface drawn from that art inherits
the fix, and the lobby cards inherit it too.

---

## 2. Repo law that outranks the picture

These are enforced by tests and by the pre-push hook. A red one blocks the whole
platform's publisher, not just you.

- **Title Case** on every popup/page/nav string. `formatPopupText` in
  `src/utils/popupStyle.ts` is the single transform. Gates:
  `scripts/ci/check-title-case.mjs`, `check-painted-text-case.mjs`,
  `check-nav-title-case.mjs`.
  **The gates read literals only.** Anything printed from data (config
  tables, scenario fixtures, Supabase rows, enums, `shortLabel`s) bypasses
  them, and that is where "Aces full of Jacks or better" and "Normal hand
  (baseline)" reached Dan's sheet on 2026-09-14. Wrap dynamic copy in
  `titleCase()` where it is printed, and add that wrap to your review of
  every state you render: read each rendered PNG for a lower-case word before
  you show it.
- **No em dashes** anywhere in UI text (`check-ui-text.mjs`). "Em bars" means the
  character `—`, and nothing else — it is not a rule about artwork.
- **No `:hover`, ever** (`tests/no-hover-effects.law.test.ts`). Use `:active` and
  `:focus-visible`. Phones do not hover and a stuck hover state is a bug.
- **No new unstyled BEM hooks** (`tests/unit/classNamesResolve.test.ts` holds a
  frozen baseline). If you put a `className` on an element, that class must exist
  in a stylesheet the route loads. Otherwise delete it.
- **Bind and act on every Supabase error**
  (`tests/unit/discardedErrorReadRatchet.test.ts` holds a per-file baseline).
  `const { data, error } = await ...` and at minimum `reportError(error, 'Where')`.
- **`.maybeSingle()`, never `.single()`**. No emoji in source.
- **Chips on the felt are never abbreviated** — `formatTableChips` is law there.
  `compactChips` is for everything outside the felt.
- **Percentage rates keep one decimal** (Dan 2026-09-13). `compactChips` and the
  no-decimals rule govern chip counts. A rakeback, commission or VPIP rate is a
  money term and prints `32.5%`, never `33%`. Do not "fix" `toFixed(1)` on a
  rate.
- **Animations must always play**; never add a toggle that disables one.
- Mobile first. Design at **375px**, verify at **393px**.

---

## 3. The kit

### 3.1 Files

```
src/components/console/SpadeConsole.tsx      the chassis component + zones
src/components/console/SpadeConsole.css      the chassis paint, inks, plates
public/assets/club-buttons/console/spade-console-v1/
    top.png            1000 x 348   crest, header well, pill slot, chrome rule
    mid.png            1000 x 8     the side rails, averaged; repeats down the body
    bottom-foot.png    1000 x 72    flat closing cap (rails + 4 corner chamfers)
    bottom-plates.png  1000 x 277   two painted action plates + the flat cap
public/assets/club-buttons/popups/buy-in-v1/
    deck.png           1000 x 627   four bays + two plates + the flat cap
    source/approved-reference.png   THE MASTER. Never edit. Always re-derive from it.
```

Every slice is 1000 px wide. **All zone maths is in master pixels.**

### 3.2 Component API

```tsx
<SpadeConsole
  eyebrow="Shark Club"          // lit blue caps, top left of the well
  title="Club Rules"            // engraved silver, the big one
  titleId="…"                   // for aria-labelledby
  subtitle="…"                  // optional, muted caps
  pill="Staff"                  // prints into the well's PAINTED pill slot
  pillInk="blue"                // silver | white | blue | green | red | gold | muted
  foot="plates"                 // 'plates' | 'foot'   (defaults from `plates`)
  plates={{ secondary: {...}, primary: {...} }}   // PlateButtonProps each
>
  …body, printed on the black glass between the rails…
</SpadeConsole>
```

`PlateButton` is a transparent button laid over a painted plate: it paints
nothing and adds only the label. `ZoneText` is one fitted line inside a measured
zone. `zonePct(zone, canvasW, canvasH)` converts master pixels to the `%`
`left/top/width/height` the DOM needs.

Exports to reuse rather than re-measure:

```ts
SPADE_CONSOLE_W = 1000
SPADE_CONSOLE_TOP_H = 348      SPADE_CONSOLE_PLATES_H = 277
SPADE_CONSOLE_FOOT_H = 72
SPADE_CONSOLE_ZONES = { eyebrow, title, titleBesidePill, subtitle, pill,
                        plateSecondary, platePrimary }
// from BuyInModal, for four-bay surfaces:
BUY_IN_DECK_H = 627
BUY_IN_ZONES  = { bays: [4 x {label, value}], secondaryAction, primaryAction }
BayLabel, BayValue
```

### 3.3 The three mechanics you must get right

**(a) Each slice paints its own box.** The head box carries `top.png`, the body
carries `mid.png` with `repeat-y`, the foot carries the closing art. Never put
the repeating strip on the container — see §7.1.

```css
.sc__head {
  aspect-ratio: 1000 / 348;
  background: url(top.png) top center / 100% auto no-repeat;
}
.sc__body {
  background: url(mid.png) top center / 100% auto repeat-y;
}
.sc__foot {
  aspect-ratio: 1000 / 72;
  background: url(bottom-foot.png) bottom center / 100% auto no-repeat;
}
```

The `aspect-ratio` **must** equal the slice's own ratio. That is what makes the
painted zones line up with the DOM printed into them at any width.

**(b) Everything sizes in `cqw`.** The outermost card sets
`container-type: inline-size`; every font size, gap and pad is `cqw`. A 320 px
phone and a 430 px phone then get the same picture, not the same pixels.

**Percentage padding is not a percentage of the element.** It resolves against
the containing block's inline size, so on a painted plate whose own width is
capped (`width: min(Npx, 100%)`) every percentage inset is inflated by
`containerWidth / plateWidth`, and the plate is right only at the one width
where those two agree. Three World Hub Marketplace surfaces were each mostly
destroyed by it, all live until 2026-09-19:

- `RewardTelemetryConsole.module.css` `.statePanel`, the sign-in panel on all
  100 reward detail pages: `padding: 18%` against a 1180px console on a
  `min(440px, 100%)` plate is 212.4px a side, so the 440x789 plate held a
  **15.2 x 364px content box**, its heading on four lines and its call to
  action 96px wide.
- `pages/hub/merch-store/fulfillment.module.css` `.status`:
  `padding: 4.3% 7% 4.3% 26%` against a 1396px page on a `min(720px, 100%)`
  plate is inflated 1396/720 = 1.938x, so padding-left was 362.95px and
  **92.0% of the plate was dead area**. Past roughly a 2226px viewport its
  content box reaches zero width.
- `src/components/diamond-store/DiamondStoreShell.module.css`
  `.premiumDataCard`: `padding: 10% 9%` gave 57.9px and 52.1px on a VIP benefit
  row with a 220px floor and `overflow: hidden`, and the longest benefit filled
  115px of a 115.2px content box, one line from being cut off.

**`container-type: inline-size` on the plate itself does not fix it.** Container
units resolve against the nearest **ancestor** container, never the element that
declares the containment, so a plate with nothing above it falls back to the
small viewport: `26cqw` measured **374.4px** at a 1440 viewport, worse than the
362.95px it would have replaced. Hold the plate's own width in a custom property
and derive the insets from it. Verified at page widths 366, 900, 1396 and 2200:

```css
.status {
  --status-plate-width: min(720px, 100%);

  width: var(--status-plate-width);
  padding: calc(var(--status-plate-width) * 0.043) calc(var(--status-plate-width) * 0.07)
    calc(var(--status-plate-width) * 0.043) calc(var(--status-plate-width) * 0.26);
}
```

That keeps the same fraction of the same painted artwork, is identical at the
width where the old rule happened to be right, and stays right above it.
`container-type` on an **ancestor** is still correct and is what (b) describes;
this is about the element carrying the percentages itself.

**(c) Every printed string is fitted.** `useFitText(text, 1, minRatio)` measures
the span against its box and writes a `--fit` scale:

```css
.sc-plate__text {
  font-size: calc(4.2cqw * var(--fit, 1));
  white-space: nowrap;
}
.sc-plate__well {
  width: 70%;
} /* the FACE inside the rim - labels fit this */
```

Labels fit the plate's **face** (~70–80 % of the zone), never the whole zone, so
a long word shrinks before it can touch the chrome rim.

`useFitText` verifies its own result. Rendered width is not proportional to
font-size (hinting and per-glyph letter-spacing both round), so a ratio from one
measurement lands a few per cent wide: measured 2026-09-13, "Save Changes" on
an 82.8px face rendered 87.09px and its last letter sat on the rim. The hook now
applies, re-measures and corrects. **Never pass an inflated `scaleX` or
`headroom` as a safety margin** - that was the per-caller fudge this replaced,
and it only makes a label smaller than its face allows. `scaleX` is for a real
`transform: scaleX()` in the stylesheet and nothing else.

### 3.4 Ink — the master's own colours, and nothing else

| Class            | Colour                                  | Use                        |
| ---------------- | --------------------------------------- | -------------------------- |
| `sc-ink--silver` | `#e4e7ec` + bevel shadow                | titles, values             |
| `sc-ink--white`  | `#f4f7fb` + blue glow                   | the primary action         |
| `sc-ink--blue`   | `#45adff`                               | labels, eyebrows, numerals |
| `sc-ink--green`  | `#c8ffd2` (glow `#35d95a`)              | good news, chips in        |
| `sc-ink--red`    | `#ff5b6e` (glow `--accent-red #f02849`) | destructive, insufficient  |
| `sc-ink--gold`   | `--accent-gold #ffd700`                 | held / pinned / top up     |
| `sc-ink--muted`  | `#9aa5b3`                               | secondary meta             |

Brand: `--fb-blue #1877f2`, `--accent-red #f02849`, `--accent-gold #ffd700`,
green `#31a24c`. **No browns, no pinks, no cream-on-amber.**

**The warm accent is brass, gold is for gold things (Dan 2026-09-13).** Two
tokens with jobs, not five accidental golds: `#d6ad52` brass is the warm accent
wherever `tests/rewards-are-diamonds-and-the-schema-has-no-yellow.law.test.ts`
already requires it (it BANS `#ffd700` on the account surfaces and names brass
as sanctioned), and brand gold `#ffd700` is for something that genuinely is
gold: VIP, winnings, top-up.

**Every colour is a schema colour, and the live schema is `club-engine.css`.**
`design-system.css` and `globals.css` are NOT imported by `main.tsx`, so a
token defined only there does not exist at runtime. What is live: the gold ramp
is `--gradient-gold` (`#ffd700` into `#ffa500`), the console's own bevels fall
to `#050607`, and a warm border is brass at reduced alpha over black, the same
technique the engraved rules use. A gold ramp's dark end is one of those. It is
never a darkened copy of a brown, and never a colour you computed.

Sixteen of the finished surfaces build gold as a ramp into a brown dark stop
(`--market-brass`, `--hha-brass`, `--mission-gold-deep`, `--iv-gold-lo`) and
two use a mauve border; the mapping by role is in
`docs/audits/2026-09-13-club-arena-console-sweep.md` §7.

Engraved silver is a **solid colour plus a `text-shadow` bevel**. Never
`background-clip: text` — a clipped gradient reads as a cheap sticker and breaks
on small type.

### 3.6 Crests

Five heads exist (`top.png` spade, `top-flat`, `top-diamond`, `top-vip`,
`top-club`), all seated by `scripts/art/seat-console-crest.py`, and the recipe
for painting a new one is `public/assets/club-buttons/console/spade-console-v1/source/README.md`.
A crest is PAINTED (gpt-image-1, with the spade and the approved diamond bezel
as references), never drawn in code and never cut from another crest.

**The spade is the bar** (Dan 2026-09-09: "the spade is your anchor, if it
doesn't have the same quality, then you fail"). At 3x, the spade has four
things the club, diamond and crown do not: a bright polished-chrome catch on
the emblem's upper edge, a quilted body behind it, a blue LED along its base,
and the rails mitred INTO the housing so the frame flows into the crest. The
club is a flat disc the rails stop dead at; the diamond's emblem is an outline;
the crown is a wireframe on a plate with a thick band. Dan 2026-09-13: "cheap
looking, flat and boring." They are to be repainted against those four
failures, and the painting needs an OpenAI image key on the Mac, which was not
present on 2026-09-13.

### 3.5 Inside a dialog

`src/styles/metallic-popups.css` bevels, recolours and rounds every dialog and
every button inside one with `!important`, at specificity `0,2,1`. The console
brings its own paint, so switch that chassis off **longhand by longhand at
`0,3,0`** and put the ink on the inner span:

```css
[role='dialog'] .sc-plate.sc-plate,
[aria-modal='true'] .sc-plate.sc-plate {
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  background-image: none !important;
  color: inherit !important;
  box-shadow: none !important;
  transform: none !important;
}
```

Restate the **longhands**. A `background` shorthand at `0,2,1` will otherwise
repaint the plate face and clip the art.

---

## 4. The method

### Step 1 — Find the generic surfaces

```bash
# candidates: many border-radius rules, no master art, own colour scheme
for f in src/pages/*.tsx src/components/**/*Modal.tsx; do
  css=${f%.tsx}.css
  echo "$f radius:$(grep -c border-radius "$css" 2>/dev/null) master:$(grep -c club-buttons "$css" 2>/dev/null)"
done | grep 'master:0'
```

A surface is "still generic" when its CSS has rounded cards, its own gradients
and **zero** references to `club-buttons`. Prefer surfaces a player actually
meets: buy-in, rebuy, wait list, confirm, rules, announcements, waitlists.

### Step 1.5 — Is it already on another master?

Club Arena has more than one visual authority, and they are all Dan's:

| Authority                              | How you recognise it                                                                                      | Who guards it                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| #ClubArenaConsole (this one)           | `club-buttons/`, `SpadeConsole`                                                                           | this document                                                                                                                         |
| #SmarterCasinoRealism cinematic routes | `images/challenges/`, `images/stats/`, `--realism-*` tokens, `data-arena-surface`, `RewardsSurfaceHeader` | `tests/unit/cinematicRouteFamilies.test.ts`, `tests/stats-experience-contract.test.ts`, `tests/e2e/production-daily-missions.spec.ts` |
| The lobby's card art                   | `ArenaGameCard`, `game-cards/`                                                                            | the layered-card tests                                                                                                                |

### Resolved: the front door keeps its own dress (2026-09-09)

`src/pages/InvitePage.tsx` is generic by every measure the scanner has, and it
is NOT going on the console. Dan art-directed it against three reference cards
on 2026-08-28 ("CUSTOM SWAP, CUSTOM MAKE AND DESIGN THEM, BUT THEY SHOULD LOOK
AND FEEL LIKE THIS"), and it is the one surface a person who is **not a member**
ever sees - the front door, not a room inside the arena. This standard governs
the inside. Dan handed the call over on 2026-09-09 ("THAT RULING IS ON YOU TO
DECIDE") and this is it: black glass and gilt stay.

**A different dress is not an exemption from the house laws**, though. Its gold
was `#d4af37` over `#8a6d1f`, a ramp that reads brown at the dark end, and
"NO BROWNS OR PINKS" has no exceptions - it is the brand gold now. Title Case,
no em dashes, no `:hover` and the figure rules bind it exactly as they bind
everything else.

**A surface on any of them is finished work, not generic.** Daily Challenges
and Player Stats scored 193 and 200 on the inventory and are both already
mastered - their tests pin bevel frames, conic gradients, named animations and
a horizontal snap rail, which is the exact shape this standard forbids.
Rebuilding one would break a written contract, and CLAUDE.md 10.8 is explicit:
two written standards in conflict go to Dan, you never write a third law and
never delete the other side on your own authority. Leave them, and say so.

### Step 2 — Prove it is alive, then shoot the "before"

`git cat-file -e origin/main:<path>` and grep for importers before you spend a
round on a surface. A stale clone keeps components main has already deleted -
`FoldProtectionDialog` was rebuilt on the console before anyone noticed nothing
had imported it for weeks. The scanner prints an importer count and marks
`DEAD?`. Then shoot the before (§6): always, it is half the review.

### Step 3 — Read the logic before you touch the paint

Open the component and list every prop, guard, timer, ref and test-pinned
string. **You are re-rendering, not rewriting.** Preserve:

- recovery / in-flight refs and double-tap guards,
- focus traps and `returnFocus`,
- Escape / backdrop behaviour, countdowns, realtime subscriptions,
- literal strings tests pin — e.g. `id="buy-in-modal-title"`,
  `aria-label="Close Buy-In"`. Keep them as **literals in the JSX**, not values
  computed by a ternary (§7.6).

Then `git log -1 --stat <file>` and diff against `origin/main`: main moves under
you, and rebuilding on a stale copy silently reverts somebody's fix.

### Step 4 — Choose the chassis

| Surface shape                                     | Chassis                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A message and two actions                         | `SpadeConsole` + `plates`                                                                                                      |
| A page of content and two staff actions           | `SpadeConsole` + `plates`                                                                                                      |
| A page of content, no actions                     | `SpadeConsole` with `foot="foot"`                                                                                              |
| Sitting down or rebuying (the buy-in family ONLY) | the Buy-In deck: `BUY_IN_ZONES` + `BUY_IN_DECK_H`                                                                              |
| A list of tables/games                            | the lobby's own `ArenaGameCard` — never invent a row                                                                           |
| An established Marketplace or store page          | its existing layout plus the approved painted family for each real control; never wrap the whole page in a replacement console |

**One master per surface.** Never assemble a surface out of a rail from here, a
plate from there and a CSS pill. That single mistake is what produced three
rejected rounds.

**THE FOUR-BAY DECK IS THE BUY-IN FAMILY'S, AND NOBODY ELSE'S** (Dan
2026-09-09: "I'M NOT A BIG FAN OF THESE CARDS. I DON'T LIKE THE 4 BOXES, AND
THE WAY IT STICKS OUT ON THE SIDES ... I'D MUCH RATHER SEE THEM LOOK MORE LIKE
[the plain console]"). The bays are the sheets a player sits down and rebuys
through, and their frame stands proud of the body rails, which reads as a
second frame bolted on. Every other surface - however many figures it has -
prints them as rows on the glass, label in lit blue on the left, value in
silver on the right, an engraved rule between them.

### Step 5 — Print into the zones

- Head: eyebrow / title / pill via `ZoneText` at `SPADE_CONSOLE_ZONES`.
- Body: `.sc-copy` (Inter, 3.7cqw) for prose, `.sc-label` for small caps, an
  engraved rule between rows (`border-top: 1px solid #000` +
  `box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%)`) instead of a drawn divider.
- Foot: `PlateButton` per action — secondary on the steel plate, primary on the
  blue glass, red ink when destructive. **Two actions or none**: the foot paints
  BOTH plates, so a surface with one action leaves the other painted and empty,
  which reads as broken rather than spare. One way out uses `foot="foot"` (the
  flat cap) and prints that action as a lit word on the glass — the control
  Club Rules uses for Copy and Retry.
- Money: `compactChips()`. Countdowns: gold, red at ≤ 10 s.
- Anything the art does not paint (a slider) is the only thing you may draw, and
  it goes **up and down**, never side to side.

### Step 6 — Shoot the "after", then look at it honestly (§6)

Compare at 393 px on black, side by side with the before. Zoom the corners at
3–6×. Look specifically for: anything painting outside the frame, a two-tone
well, a label touching a rim, a seam where two slices meet.

### Step 7 — Gates

```bash
for s in check-ui-text check-title-case check-painted-text-case check-nav-title-case; do
  node scripts/ci/$s.mjs; done
npx tsc --noEmit -p tsconfig.app.json
npx vitest run tests/unit/classNamesResolve.test.ts \
  tests/unit/discardedErrorReadRatchet.test.ts tests/no-hover-effects.law.test.ts \
  tests/unit/metallicPopupSystem.test.ts tests/unit/popupSystem.test.tsx \
  <every test that names your files>
```

Run these in the owned checkout against the actual final candidate and verified private dependencies (§7.7).

### Step 8 — Present, then ship

Present the verified before/after evidence, then complete the assigned protected delivery under §8. No additional human approval is required within the authorized scope.

---

## 5. Art surgery — deriving new art from the master

You will need art the master does not contain: a plate with the baked-in word
removed, a head with no emblem, a foot with no chip. Derive it **from the master
itself**, never by drawing.

**The library ships with this skill**: `scripts/master_surgery.py` implements
every technique below (`median_bridge`, `synth_fill`, `synth_fill_matched`,
`axis_of_symmetry`, `mirror_close`, `flat_cap`, `splice`), plus `column_runs`
and `is_straight` for measuring the art before you cut it, and `preview` for
looking at the result. Import it rather than retyping it:

```python
import sys; sys.path.insert(0, '.claude/skills/club-arena-console/scripts')
from master_surgery import load, save, is_straight, median_bridge, flat_cap

a = load('public/assets/club-buttons/console/spade-console-v1/bottom-foot.png')
assert is_straight(a, 409, 423)            # prove it before you tile it
```

Work on the PNG at full resolution, always writing to a new file, always
re-derivable from `source/approved-reference.png`.

### 5.1 Pick the technique by what you are rebuilding

| What is behind the thing you are removing         | Technique                              |
| ------------------------------------------------- | -------------------------------------- |
| A dead-straight feature (a rail, a rule, a bevel) | **median cross-section**               |
| Flat texture (a glass well, a plate face)         | **random-column synthesis**            |
| Texture inside a vignette                         | **brightness-matched synthesis**       |
| A centred emblem the rails run into               | **synthesise the bridge, then mirror** |
| A whole closing edge                              | **flip the top cap**                   |

### 5.2 Median cross-section — for straight features

The rails are identical at every x over a stretch, so one column carries them.
Take the **median** across a clean band (it averages the film grain away; a
random sample leaves the rail speckled) and tile it:

```python
band = np.median(a[y0:y1, 409:424], axis=1)   # H x 4 (RGBA)
a[y0:y1, x0:x1] = band[:, None, :]
```

Prove the band is straight first — the alpha run-lengths per column must be
identical at three sampled x values:

```python
col = a[:, x, 3]; ys = np.where(col > 10)[0]   # group into runs, compare
```

### 5.3 Random-column synthesis — for texture

Every output pixel takes a random source column **on its own row**, so
horizontal features survive exactly and nothing tiles:

```python
rows = np.clip(np.round(np.linspace(0, sh-1, H)).astype(int), 0, sh-1)
cols = rng.integers(0, sw, size=(H, W))
patch = src[rows[:, None], cols]
patch = gaussian_blur(patch, 0.6)
```

### 5.4 Brightness-matched — texture inside a vignette

Interpolate the mean of a ring **left and right** of the hole across the patch
and shift the patch to it. Use the horizontal ring only when the thing above the
hole is the emblem you are removing — sampling its glow bakes the halo back in.

### 5.5 Feather rules (this is where ghosts come from)

A feathered edge blends the **original** back in. If the original still contains
the emblem's rim there, you get a curved ghost. So:

- start the fill **outside** the artefact's outer glow, not at its rim;
- feather left / right / bottom, and make the edge that faces the artefact
  **hard** (`top_feather=0`);
- kill anything above the reconstruction outright: `out[0:first, x0:x1] = 0`.

### 5.6 Mirror to close a centre

When rails run into a centred emblem from both sides and the art is symmetric,
bridge the left half from a clean band and mirror it:

```python
C = 996                       # the master's own axis: mirror(left rail) == right rail
a[y0:y1, 414:C//2+1] = band[:, None, :]
for x in range(C//2+1, C+1):  a[from_row:, x] = a[from_row:, C-x]
a[from_row:, C+1:] = 0
```

Find `C` by testing which offset minimises `|a[:,x] - a[:,C-x]|` on the **outer
rails**, not the interior — the outer rails are what must line up with `mid.png`.
Mirror only rows below anything asymmetric (a steel plate on the left and a blue
one on the right must not be mirrored).

### 5.7 The flat cap — the master's own top, turned over

The cleanest closing edge is the master's own top rails flipped. In
`top.png` rows 27–98 are the outer frame's horizontal rails and all four corner
chamfers, and nothing else (the header well starts at row 99):

```python
top = np.array(Image.open('top.png').convert('RGBA')).astype(np.float32)
band = np.median(top[0:99, 215:305], axis=1)   # rails behind the crest
top[0:99, 372:628] = band[:, None, :]          # remove the emblem
cap = top.astype(np.uint8)[27:99][::-1]        # 72 rows: flip it over
```

Splice it under any body: `out[:cut] = plates[:cut]; out[cut:] = cap`. Cut at a
row where the centre is empty (a gap between features) so nothing crosses the
seam; the side rails are continuous at every row, so they always join.

**After surgery, re-check the constants.** Changing a slice's height changes the
`aspect-ratio` in CSS _and_ the `canvasH` every `zonePct` call uses.

### 5.8 Verify the art before you wire it

Composite on black (and on a garish colour, to read the alpha) and zoom 3×:

```python
bg = Image.new('RGBA', im.size, (0,0,0,255))
Image.alpha_composite(bg, im).convert('RGB').resize((w*3, h*3), Image.NEAREST).save(out)
```

---

## 6. The render harness

Renders the real component with the real fonts and the real global CSS,
headless at 393 px. It is the only honest way to judge a redesign and the only
way to produce the before/after Dan reviews. **The templates ship with this
skill**. Use a clean, isolated task-owned fixture checkout without credential files; verify all destination filenames are absent before copying. Never overwrite or delete an existing environment file. The legacy runner below requires its documented Linux browser dependencies; use the actual supported browser route when that environment is unavailable:

```bash
cp .claude/skills/club-arena-console/harness/card-harness.html .
cp .claude/skills/club-arena-console/harness/card-harness.tsx .
cp .claude/skills/club-arena-console/harness/shot.mjs .shot.mjs
export VITE_SUPABASE_URL=https://dummy.supabase.co
export VITE_SUPABASE_ANON_KEY=dummy

# add your surface to the switch in card-harness.tsx, then:
bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/before "?surface=<key>"
#   ...redesign...
bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/after  "?surface=<key>"
python3 .claude/skills/club-arena-console/harness/sheet.py /tmp/sheet.jpg 760 \
  "Rebuy Popup:/tmp/before/rebuy.png:/tmp/after/rebuy.png"

rm -f card-harness.html card-harness.tsx .shot.mjs   # only these task-created files
```

`harness/README.md` carries the one-time sandbox provisioning (chromium plus the
shared libraries `apt` does not install by default) and the font requirement -
**without Roboto Condensed and Inter installed, every fitted label measures
wrong and the render lies to you.**

`?click=Label` clicks a button by its text 900 ms after mount, which gets you
the secondary states (a composer open, a confirm step) without a second harness.

**Shoot every state, not just the happy one**: empty, loading, error,
insufficient funds, the confirm step, the longest string a real user can
produce. Most review rounds are lost in a state nobody rendered.

## 6.5 Finding the work, and splitting it

```bash
node .claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs
```

Scores every page, modal, sheet, panel and card in `src/` by how far it is from
the standard - PAINTED corner radii and gradients count against it, references to
`club-buttons/` or the console kit zero it out, a `:hover` rule is weighted five
times because it is forbidden outright. A surface already on a master scores 0.
`--json` gives the machine-readable list.

**Painted, not merely present (2026-09-22).** `border-radius: 0` and
`box-shadow: none` do not draw a frame, they refuse one, and they are the exact
pair 3.5 tells you to write to switch the `metallic-popups` chassis off. The
scorer used to count them, so the more correctly a surface obeyed 3.5 the more
generic this said it was: `LeaderboardSettlementCard` prints as rows on
`LeaderboardPage`'s console glass and owns no frame at all, and it was nominated
for a rebuild on one zeroed corner and one refused shadow, its only two matching
lines. Values are read and judged now. If you ever re-touch that counter, judge
the DECLARATION - a negative lookahead behind `\s*` backtracks to zero width and
matches `border-radius:` inside `border-radius: 0;`.

**Two rows are ruled off by hand, and both maps say why.** `RULED` carries a
surface that is finished work without a test whose title says so; it also
carries `src/components/common/Card.tsx`, which is not a surface at all -
nothing in `src/` renders any of its six exports, its only importer is the
`components/common` barrel, and the barrel's only importer takes `ErrorBoundary`
alone. A primitive several surfaces compose is not a thing a player looks at:
move its callers onto `SpadeConsole` or retire it, never paint chrome onto a
generic box to take a count to zero. Both rulings are pinned by
`tests/unit/consoleInventoryIsHonest.test.ts`, so they re-open on their own if
the tree stops matching them.

Work the list in **traffic order, not score order**. What a seated player meets
every hand beats an admin page nobody opens twice a week:

1. the felt (action panel, the modals that open over a live table),
2. money (buy-in, cashier, wallets, settlement),
3. the club pages a player browses (stats, leaderboard, achievements, friends),
4. tournament and lobby,
5. operator and admin.

Keep each pull request within its assigned scope and a reviewable theme. The surface inventory does not authorize unrelated redesigns or hold a completed surface for a larger batch.

### Delegating to subagents

A sweep is parallel work, and this skill is what makes an agent interchangeable
on it. When you hand a batch to a subagent:

- give it **this entire document** (its description says so, and it is not
  optional - an agent that skims re-learns every trap at your expense);
- give it **one batch and one theme**, plus the exact surface list;
- tell it the master art it may use, and that inventing art is out of scope -
  if a surface needs a shape the master does not contain, it reports back
  rather than drawing;
- require it to return **rendered before/after PNGs**, the gate output, and a
  list of every handler and test-pinned literal it preserved;
- **it does not push.** Batches land as one pull request, from you, after Dan
  has seen the sheet.

Two subagents must never touch the same file. Split by surface, and keep shared
files (`SpadeConsole.*`, `metallic-popups.css`, `utils/format.ts`) for yourself.

## 7. Traps that have each cost hours

**7.1 The repeating strip tiles behind the whole card.** Three background layers
on one element (`top`, `bottom`, `mid repeat-y`) means the rails paint in the
transparent margin _above_ the crest and _below_ the closing rail — lines that
appear to run under the frame. Give each slice its own box. Still live on
`.glp--cash .glp__section` and `.dbs__panel` (shark-panel art, transparent for
its first 33 rows); the fix there is a pseudo-element inset to the caps —
`background-clip: content-box` does **not** work, it clips the side rails away
too.

**7.2 `metallic-popups.css` repaints your plates.** See §3.5.

**7.3 A feather pulls the emblem back in.** See §5.5.

**7.4 Random synthesis on a smooth rail speckles it.** Use the median (§5.2).

**7.5 An empty replacement needle corrupts the file.** Check the expected match count before replacement and inspect the resulting diff. If an edit is wrong, restore only this task's known preimage; never discard another task's uncommitted work.

**7.6 A computed `aria-label` breaks a pinned test.** Tests read the source text.
Two literal branches beat one clever ternary.

**7.7 Verify the checkout and execution environment.** Use an owned checkout with the expected revision and dependencies. Do not assume another agent's checkout, a shared cache or a mounted copy is isolated or writable. Inspect the actual failing input before attributing a compiler failure to the environment.

**7.8 Integrate protected main without losing work.** Preserve the owned state, merge through normal Git operations, review conflicts individually and verify the resulting candidate. Never use a blanket file replacement or reset to hide an integration problem.

**7.9 Push through the configured origin.** Read the hook's actual protected-base selection and current PR state. Do not change transports or use a stale base to evade checks.

**7.10 Missing dependencies are a precheck failure.** Follow the current owner policy for private locked dependencies in the owned SSD checkout. Inspect existing links and package locks; never install through or mutate a shared dependency symlink. Keep root and server dependency contracts distinct.

**7.11 Follow the current tool's execution contract.** Keep the returned operation/session identity for long commands and read its terminal result. Do not assume an obsolete host tool timeout behavior or launch detached repair services to finish a push.

**7.11b The harness must load the fonts.** The Mac has neither Roboto
Condensed nor Inter installed; `index.html` loads them from Google Fonts and
so does `harness/card-harness.html` (since 2026-09-13). Without them every
fitted label measures wrong and the render lies. `useFitText` measures on
mount, so shoot after `document.fonts.ready`.

**7.12 Merged is not landed.** Autopilot can squash-merge in under two minutes; check the current PR state before every follow-up push.
A follow-up push to a merged branch exits 0 and reaches nobody. If the PR has
merged, start a **new branch off current `main`**; the `guard-merged-branch.sh`
hook refuses that push and prints the recovery.

**7.13 A merge conflict between a console render and a main change is never
resolved by taking a side.** On 2026-09-13 "main wins on product logic" threw
away eleven approved renders (Buy-In among them) to keep deltas of 2 to 122
lines. Rebase the delta onto the render instead: `git checkout
<render-commit> -- <file>`, then `git diff <merge-base> origin/main -- <file>

> /tmp/d.patch && git apply -3 /tmp/d.patch`, resolve the few hunks by hand,
and prove it with `git diff -w origin/main -- <file>`(only chassis lines may
differ). Then re-pair the stylesheet: a TSX from one side with a CSS from the
other fails`check-css-modules`and grows the`classNamesResolve` baseline.

---

## 8. Shipping

Read root `AGENTS.md`, `AGENT-PLAYBOOK.md`, `docs/agent-policy/OPERATING-LAW.md` and `PUBLISHING.md`. Use the owned worktree and ordinary hooks. Inspect the actual environment and dependency contract; do not replace another task's directories or assume an old host tool or mismatched dependency symlink works.

The authorized agent owns the PR, required checks, protected merge, provider publication and actual behavior proof. Record the pending run and continue eligible authorized work during provider waits. Do not stop at the PR number or add a release watcher. Failed deployments enter immediate recovery under the operating law, with existing maintenance safeguards intact.

Write scoped evidence to the existing task checkpoint and a separate changelog when required. Preserve other tasks' records.

---

## 9. Working with Dan

- **Show, don't describe.** Every round is a rendered picture at 393 px, before
  beside after, plus the secondary states (empty, error, insufficient, confirm).
- Complete the authorized design and delivery without another approval checkpoint; preserve explicit scope boundaries and required verification.
- Apply received design corrections to the connected master and kit within scope. Finish when the assigned requirements and verification are satisfied; do not invent a fixed number of review or approval rounds.
- When he says something "feels cheap", the answer is almost never a CSS tweak —
  it is that the surface was assembled from parts instead of drawn from one
  master.
- He will ask you to vary the dress ("not every frame 100% the same"). Vary the
  **emblem**, never the structure, and always derive the variant from the master.
- Report defects you find on the way (a card that says JOIN TABLE when the action
  is Join Waitlist, a queue that prints "#0 In Line") and fix them in the same
  pass. The redesign is the audit.

---

## 10. Definition of done

- [ ] Every frame, plate, bay and pill comes from an approved master at native ratio.
- [ ] Nothing paints outside the frame — top, bottom or sides.
- [ ] One background inside a well and outside it. No frame on a frame.
- [ ] Every printed string is fitted and centred **in the face**, never touching a rim.
- [ ] Brand colours only. Silver is solid ink plus a bevel, never a clipped gradient.
- [ ] No decimals forward-facing; `compactChips` everywhere outside the felt.
- [ ] Title Case, no em dashes, no `:hover`, no unstyled class hooks, no unread errors.
- [ ] Every handler, guard, timer, focus trap and test-pinned literal survived.
- [ ] Established Marketplace layouts, routes, product art and purchase paths survived; the existing gold VIP artwork and layout remained intact.
- [ ] Marketplace navigation remained on the current surface; no `target="_blank"` or `window.open` path was introduced.
- [ ] Variable-height product, fulfillment and benefit cards use native-ratio top, middle and bottom slices, or retain a controlled existing frame with the art gap reported; no master was stretched.
- [ ] Commerce visuals preserved exact account/request/offer ownership, idempotency, durable-intent compare-and-swap, stale-async and unmount guards; verification followed the trigger through the authoritative receipt.
- [ ] No decorative selector object, connected display clone, empty replacement frame, floating glyph or generic icon overlay was introduced.
- [ ] Any throwable offer is one all-access product backed by actual in-game art and durable database guards against item-specific listings.
- [ ] Rendered at 393 px, every state, compared against the before.
- [ ] Requested after screenshots were captured from the exact published production build.
- [ ] `tsc` clean, all four copy gates OK, every covering test green **in the worktree**.
- [ ] Changelog written; PR number reported; nobody sat watching CI.
