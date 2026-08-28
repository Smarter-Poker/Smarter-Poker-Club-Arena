# The table is portrait only

**Dan, 2026-08-28:** "lock it, portrait mode only."

This closes the item left open by `2026-08-28-cards-are-a-fraction-of-the-felt.md`.

---

## Why

Measured with `scripts/dev/measure-felt.mjs`: an **844x390 phone in landscape
renders a 96px felt**, with a PLO4 hole-card row at **103% of it** — the row is
wider than the table it sits on.

That is not a sizing bug and the proportional card work could not fix it.
`.table-scaler` is `aspect-ratio: 605/1000` and derives its width from leftover
HEIGHT, so a 390px-tall viewport cannot produce a table wider than ~175px however
the reserves are tuned (I checked: reclaiming the 36px of header reserve the
landscape block already wastes gets 96px to about 125px, and no further).

The only real fix is a landscape oval, and `TablePage.css:869` says what that
costs:

> the canonical 896x1200 skin composites ... **the seat ring percentages in
> TablePage.tsx are derived from THIS box; changing the aspect moves every seat
> off the painted rail**

New artwork at a landscape aspect plus a second seat ring. Until that exists,
landscape is not a smaller table, it is a broken one — and there was no
orientation lock and no prompt, so a player could reach that 96px table today by
turning their phone mid-hand.

## What shipped

`PortraitLock`, mounted from `PersistentTableLayer`.

**It is a prompt, not a lock, because a lock is not available.**
`screen.orientation.lock()` rejects outside fullscreen, does not exist on iOS
Safari at all, and rejects rather than throws where it does exist. It is still
attempted — where it works the screen simply does not turn, which is strictly
better — and every failure path is swallowed, because rejection is the expected
case rather than an error. The overlay is the mechanism that actually holds.

### Where it lives, and why nowhere else

`PersistentTableLayer` is mounted once beside `<Routes>` and already knows
whether a table is on screen. Both properties are required:

- MultiTablePage keeps **up to four TablePages mounted at once** (an inactive
  slot is only `pointer-events: none`), so anything rendered inside a table would
  paint four stacked full-screen overlays and fire four orientation-lock
  requests.
- Gating on `onTableRoute` keeps it off the lobby, which works fine sideways.

It sits **outside** that layer's `ErrorBoundary` on purpose: if the table layer
crashes while the phone is sideways, the instruction to turn it back is the last
thing that should disappear.

### Visibility is pure CSS, and that is a player-money decision

No resize listener, no `orientationchange` handler, no `matchMedia` state. The
overlay is always rendered on a table route and a media query decides whether it
displays. Three reasons, and the third is the one that matters:

1. No flash — a JS-driven version paints the table for a frame mid-rotation.
2. No re-render burst above four mounted tables during the one gesture that has
   to stay smooth.
3. **It uncovers the felt the instant the phone is upright.** A player who
   rotates mid-hand is on a clock: the server is authoritative, the other players
   are waiting, and nothing here can pause their turn timer. The cost of covering
   the felt is measured in folded hands, so the uncovering has to be a style
   recalculation rather than a React commit.

That same clock is why the copy reads **"Your Hands Are Still Live."** It is
stated unconditionally rather than only on the hero's turn: turn state lives in
MultiTablePage, _below_ this layer, and lifting it up through the component whose
entire job is to never unmount is a worse trade than a sentence true in every
case.

## The one regression that would be catastrophic, and the test for it

**Every desktop is landscape too.** `@media (orientation: landscape)` on its own
would cover every desktop player's screen with an un-dismissable instruction to
turn a phone they are not holding, on a viewport where the table works fine.
There is no dismiss button by design, so that is not a cosmetic regression — it
locks every desktop player out of the product until a deploy reverses it.

The query is therefore:

```css
@media (orientation: landscape) and (hover: none) and (pointer: coarse);
```

`(hover: none) and (pointer: coarse)` is the interaction-media test for a
touch-primary device. A desktop reports `fine`/`hover`. **A touchscreen laptop
also reports `fine`/`hover`**, because its primary pointer is the trackpad —
which is exactly why this is the right test and a `max-width` breakpoint is not,
and why it needs no device list to maintain.

`tests/unit/portraitLock.test.ts` pins it, along with the base rule being
`display: none` (so any environment matching no query renders nothing rather than
the lock), the single mount point, the swallowed orientation-lock rejection, and
the absence of a JS visibility path.

Verified by rendering the real markup and stylesheet under Playwright with touch
emulation, because jsdom evaluates no media queries and a render test would pass
against a rule that catches every desktop on Earth:

| Viewport                | Touch | `.portrait-lock` display |
| ----------------------- | ----- | ------------------------ |
| 844x390 phone landscape | yes   | **flex** (locked)        |
| 390x844 phone portrait  | yes   | none                     |
| 1440x900 desktop        | no    | **none**                 |

## One judgement call, and it is reversible in a line

**This catches an iPad in landscape.** That is a deliberate reading of "portrait
mode only". An iPad in landscape is not as broken as a phone — a 308px felt
against a phone's 96px, measured — but it is still a portrait oval squeezed by
height.

If iPads should keep landscape, add `and (max-height: 600px)` to the query:
phones are 390-430px tall sideways and would still lock, iPads are 768px+ and
would not. The note is in `PortraitLock.css` beside the rule.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/` — full suite green.
- Rendered and screenshotted at all three viewports above.

Not verified: the overlay over a live table under a real hand, which needs a
login an agent does not perform.
