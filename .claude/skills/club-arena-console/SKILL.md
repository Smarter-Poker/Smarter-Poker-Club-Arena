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
version: 1.1.0
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

---

## 1. Dan's law

Quoted verbatim, with what each one means at the keyboard. These were paid for
one review round at a time. Do not relitigate them.

| Dan                                                                                                                                                                                                     | In practice                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "CLEAN FRAMES"                                                                                                                                                                                          | One frame per surface. Nothing partial, nothing cut off, nothing incomplete at any edge.                                                                                                                                                                                  |
| "CLEAN CONSISTENT BACKGROUNDS (INSIDE THE CARD, BUTTON OR ICON AND OUTSIDE IT)"                                                                                                                         | One tone inside a well and outside it. An inpaint band that is lighter than the glass beside it is a defect.                                                                                                                                                              |
| "NOTHING CAN BE COPY PASTED OR OVERLAPPED"                                                                                                                                                              | Never repeat a plate PNG twice on one surface, never overlay art on art.                                                                                                                                                                                                  |
| "ALL FONTS AND BUTTONS MUST BE CENTERED INSIDE THEIR FRAMES"                                                                                                                                            | Text is centred in the painted **face**, not in the zone box.                                                                                                                                                                                                             |
| "FRAMES SHOULD NEVER SIT ON TOP OF FRAMES"                                                                                                                                                              | No CSS card around a painted card. The art is the frame.                                                                                                                                                                                                                  |
| "EVERYTHING MUST BE CLEAN AND CRISP"                                                                                                                                                                    | Native resolution, native ratio. Never stretch, never 9-slice across a feature.                                                                                                                                                                                           |
| "ALL ICONS SHOULD FEEL ORGANIC, AND BUILT INTO THE FRAMES"                                                                                                                                              | An emblem is part of the render or it is not there. Never a glyph stuck on top.                                                                                                                                                                                           |
| "ALL BACKGROUNDS ON EVERYTHING MUST ALWAYS BE REMOVED"                                                                                                                                                  | Transparent PNGs on black. No panel fills.                                                                                                                                                                                                                                |
| "ALL FONTS MUST FEEL ORGANIC AND NATURAL AND MATCH THE LOOK AND FEEL OF THE DYNAMIC IMAGE THEY ARE INSIDE OF"                                                                                           | Use the master's own inks (see §3.4), Roboto Condensed for chrome type, Inter for copy.                                                                                                                                                                                   |
| "YOU CAN NEVER JUST COPY AND PASTE A BUTTON, CARD OR ANYTHING EVER, YOU MUST CREATE IT"                                                                                                                 | Derive new art from the master by surgery (§5), never by duplicating a component.                                                                                                                                                                                         |
| "NEVER USE DECIMAL POINTS ON ANY FORWARD FACING PAGE"                                                                                                                                                   | `compactChips()`. Whole numbers under 1,000.                                                                                                                                                                                                                              |
| "ONCE SOMETHING HITS OVER 1,000 USE 1K, IF ITS 1200 USE 1.2K, IF ITS 10,000 USE 10K"                                                                                                                    | One decimal above 1K, **always rounded down**, `.0` stripped. Never overstate.                                                                                                                                                                                            |
| "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS"                                                                                                                                      | §3.4 only.                                                                                                                                                                                                                                                                |
| "MAKE SURE FONT SIZES NEVER GO OVER THE EDGES OF THE FRAME"                                                                                                                                             | Every printed string is fitted (§3.3), and fits the face, not the rim.                                                                                                                                                                                                    |
| "THE SLIDER NEEDS TO GO UP AND DOWN, NOT SIDE TO SIDE (SIDE TO SIDE SWIPES THE PAGE)"                                                                                                                   | Vertical range inputs at the felt; a horizontal drag is the table-switch gesture.                                                                                                                                                                                         |
| "THEY SHOULD JUST BE STAND ALONE IMAGES WITH FRAMES AROUND THEM"                                                                                                                                        | Nothing paints outside the frame. See the tiling trap, §7.1.                                                                                                                                                                                                              |
| "I PREFER IT WITH ONLY AN ICON AT THE TOP ... IT SHOULD BE A FLAT BOTTOM"                                                                                                                               | Crest at the top, flat closing cap at the bottom, no chip.                                                                                                                                                                                                                |
| "I DON'T WANT EVERY SINGLE FRAME AND BUTTON TO BE 100% EXACTLY THE SAME, JUST THE SAME STYLE"                                                                                                           | Dress may vary (emblem / no emblem). Structure may not.                                                                                                                                                                                                                   |
| "I DO NOT WANT EVERY SINGLE CARD TO LOOK EXACTLY THE SAME, THEY SHOULD NOT ALL HAVE THE SAME FRAME, WITH THE SAME SPADE AT THE TOP MIDDLE ... NOT ALL THE SAME BORING COOKIE CUTTER STYLE" (2026-09-13) | One chassis with five badges is not variety. Frame FAMILIES are cut from the master by surgery (§5) and assigned by section; each family has its own crests and ink. This supersedes "structure may not vary" above: structure varies BETWEEN families, never within one. |
| "THE 'SPADE' ICON IS PERFECT, HIGH DEFINITION DYNAMIC ICON WITH DEPTH AND THE 3D LOOK AND FEEL ... THE REST ARE ALL CHEAP LOOKING, FLAT AND BORING" (2026-09-13)                                        | Every crest matches the spade: a polished-chrome catch on the emblem, a quilted body, a blue LED at its base, and the rails MITRED INTO the housing. The club, diamond and crown crests fail all four and are to be repainted (§3.6).                                     |
| "YOU MUST STICK TO THE SMARTER.POKER COLOR SCHEMA" (2026-09-13)                                                                                                                                         | Every colour on a surface is a token the schema already owns. Never a derived tone, not even a darkened one: 24 "shadow" stops computed from the browns they replaced were rejected on sight. See §3.4.                                                                   |
| Rates keep one decimal (2026-09-13)                                                                                                                                                                     | The no-decimals rule is for chip counts. A percentage RATE (rakeback, commission, VPIP) keeps one decimal, because rounding 32.5% to 33% misstates a number a club owner is paid on, and the same law says never overstate.                                               |
| The desktop ceiling (2026-09-13)                                                                                                                                                                        | A console stops growing at the master's own width (1000px) and centres. The art is never asked for more pixels than it has; a wide screen gets black margin, not a bigger phone. `--sc-max` may narrow it, never raise it.                                                |

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

| Surface shape                                     | Chassis                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| A message and two actions                         | `SpadeConsole` + `plates`                            |
| A page of content and two staff actions           | `SpadeConsole` + `plates`                            |
| A page of content, no actions                     | `SpadeConsole` with `foot="foot"`                    |
| Sitting down or rebuying (the buy-in family ONLY) | the Buy-In deck: `BUY_IN_ZONES` + `BUY_IN_DECK_H`    |
| A list of tables/games                            | the lobby's own `ArenaGameCard` — never invent a row |

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

Run these **in the Mac worktree**, not in a sandbox clone (§7.7).

### Step 8 — Present, then ship

Present before/after and **do not push until Dan approves** unless he has
already given a green light. Then §8.

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
skill** - do not rebuild them from memory:

```bash
cp .claude/skills/club-arena-console/harness/card-harness.html .
cp .claude/skills/club-arena-console/harness/card-harness.tsx .
cp .claude/skills/club-arena-console/harness/shot.mjs .shot.mjs
printf 'VITE_SUPABASE_URL=https://dummy.supabase.co\nVITE_SUPABASE_ANON_KEY=dummy\n' > .env.local

# add your surface to the switch in card-harness.tsx, then:
bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/before "?surface=<key>"
#   ...redesign...
bash .claude/skills/club-arena-console/harness/run-shots.sh /tmp/after  "?surface=<key>"
python3 .claude/skills/club-arena-console/harness/sheet.py /tmp/sheet.jpg 760 \
  "Rebuy Popup:/tmp/before/rebuy.png:/tmp/after/rebuy.png"

rm -f card-harness.html card-harness.tsx .shot.mjs .env.local   # never commit these
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
the standard - CSS corner radii and gradients count against it, references to
`club-buttons/` or the console kit zero it out, a `:hover` rule is weighted five
times because it is forbidden outright. A surface already on a master scores 0.
`--json` gives the machine-readable list.

Work the list in **traffic order, not score order**. What a seated player meets
every hand beats an admin page nobody opens twice a week:

1. the felt (action panel, the modals that open over a live table),
2. money (buy-in, cashier, wallets, settlement),
3. the club pages a player browses (stats, leaderboard, achievements, friends),
4. tournament and lobby,
5. operator and admin.

**Batch six to ten surfaces per pull request**, one theme per batch. Smaller and
the review is all overhead; larger and Dan cannot hold it in his head, the
render sheet stops being legible, and one rejected surface blocks nine good
ones.

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

**7.5 `s.replace('', new)` with an empty needle** inserts between every character
and turns a 500-line file into 232,000 lines. Always
`assert s.count(old) == 1` before every replace, and `git checkout` the file the
moment output looks wrong.

**7.6 A computed `aria-label` breaks a pinned test.** Tests read the source text.
Two literal branches beat one clever ternary.

**7.7 A sandbox clone lies.** It sits on another agent's branch with other
agents' uncommitted files; `tsc` fails on modules that do not exist there and
test baselines are stale. **Typecheck and test in the Mac worktree.** Also never
run git _write_ commands against a mounted worktree from a sandbox — the mount
cannot unlink, and the `.git/index.lock` it strands then blocks git on the host.

**7.8 Syncing main into the clone silently reverts your edits** for any file
where main and the clone's base are identical. Re-apply from your own notes and
diff before committing.

**7.9 The pre-push hook diffed 2,558 files** because the push named the raw SSH
URL, so the hook fell back to the stale local `main`. **Push via `origin`** (set
its push URL to SSH) and it diffs against `origin/main` — your files only.

**7.10 A worktree with no `server/node_modules`** fails the hook with
`Failed to resolve import "uuid"`. Symlink it from the main clone; same for the
root `node_modules` (the sandbox's Linux rollup binary is useless on the Mac).

**7.11 `host_terminal` kills the process group when a call times out.** Long jobs
(worktree creation, pushes) go in `tmux new-session -d -s job "script"`, then
poll the log in later calls. `nohup … & disown` is not enough. `setsid` does not
exist on macOS, and a `launchctl submit` job cannot read the working directory.

**7.11b The harness must load the fonts.** The Mac has neither Roboto
Condensed nor Inter installed; `index.html` loads them from Google Fonts and
so does `harness/card-harness.html` (since 2026-09-13). Without them every
fitted label measures wrong and the render lies. `useFitText` measures on
mount, so shoot after `document.fonts.ready`.

**7.12 Merged is not landed.** Autopilot can squash-merge in under two minutes.
A follow-up push to a merged branch exits 0 and reaches nobody. If the PR has
merged, start a **new branch off current `main`**; the `guard-merged-branch.sh`
hook refuses that push and prints the recovery.

---

## 8. Shipping

```bash
# on the Mac (you have host_terminal), node is not on the default PATH:
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"

git fetch git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git main
nohup git worktree add -b feat/<slug> ~/Documents/.agent-trees/club-arena/<name> FETCH_HEAD &
cd ~/Documents/.agent-trees/club-arena/<name>
ln -sfn ~/Documents/club-arena/node_modules node_modules
ln -sfn ~/Documents/club-arena/server/node_modules server/node_modules

git -c user.name="Smarter-Poker" \
    -c user.email="254329056+Smarter-Poker@users.noreply.github.com" commit -m "…"

# the hook runs guards + tsc + every test covering your diff, ~3 minutes:
tmux new-session -d -s push "git push origin HEAD:refs/heads/feat/<slug> > /tmp/push.log 2>&1"
```

Never `--no-verify`. `agent-open-pr.yml` opens the PR, `agent-autopilot.yml`
arms squash auto-merge, `publish-club-arena.yml` ships it. **Report the PR
number and stop** — never sit in a loop watching CI. Verify later, once:

```bash
curl -s https://smarter.poker/hub/club-arena/build-info.json    # ca_sha == the squash commit
```

Write your own changelog at `docs/changelog/YYYY-MM-DD-<slug>.md` — never append
to a shared file, that is the repo's biggest source of merge conflicts.

---

## 9. Working with Dan

- **Show, don't describe.** Every round is a rendered picture at 393 px, before
  beside after, plus the secondary states (empty, error, insufficient, confirm).
- **Do not push until he approves**, unless he has already said go.
- Expect **three to five rounds**. Each one is specific and each one generalises:
  apply it to the master and the kit so every surface inherits it.
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
- [ ] Rendered at 393 px, every state, compared against the before.
- [ ] `tsc` clean, all four copy gates OK, every covering test green **in the worktree**.
- [ ] Changelog written; PR number reported; nobody sat watching CI.
