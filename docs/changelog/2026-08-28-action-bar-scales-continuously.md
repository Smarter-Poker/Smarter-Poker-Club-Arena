# The action bar scales with the device instead of stepping at 640px

**Dan, 2026-08-28:** "WHY DOESN'T THE LIVE TABLE SCALE DIFFERENTLY PER DEVICE?
MY BUTTONS AND CARDS LOOK THE SAME NO MATTER IF I'M ON A PHONE, OR A TABLET."

They did, and the buttons are fixed here. Cards are the second half and are not
in this change — see "What is not done" at the end.

---

## What was actually wrong

The felt itself does scale per device: `.table-scaler` takes its width from the
vertical space left over and holds `aspect-ratio: 605/1000`, so the oval and the
whole seat ring ride the viewport. That part worked.

Everything inside and under it sized itself from a hard-coded px ladder instead,
and **the ladder stopped at 640px**. `ActionPanel.css` had overrides at 640 /
380, `SeatSlot.css` at 640 / 480 / 380, and nothing above either. So every
viewport wider than 640px — a 768px tablet, a 1024px iPad, a 1920px desktop —
resolved to the identical base values. That is the complaint, exactly: a ladder
has steps, so every device inside a step is the same size by construction.

Three separate defects came out of the same pass.

### 1. The tablet rules existed and had never once applied

`TablePage.css` carried `.action-btn { height: 56px }` under
`@media (min-width: 768px) and (orientation: portrait)`, and
`.action-btn { height: 48px; min-height: 44px }` under the landscape block. Both
are `(0,1,0)`. The base rule is `.action-panel .action-btn` at `(0,2,0)` — the
compound scoping added on 2026-08-24 and pinned since by
`tests/shipped-invariants.test.ts`. Specificity beats source order, so **a tablet
rendered the 72px desktop button every time, and had since the day that scoping
landed.**

`ActionPanel.css:1507` documents this precise trap for the phone rules, which
were fixed for it on 2026-08-25. The two copies in `TablePage.css` were never
fixed. Both are deleted rather than re-scoped: `--sp-action-btn-h` now resolves
to 56px at exactly 768px wide, so the rule has nothing left to say.

### 2. The row still changed height on the hero's turn above 640px

`.action-panel--active .action-btn` went 72px -> 84px. The phone had pinned that
away on 2026-08-25 with the reason written out — "`--sp-bottom-row-h` has to be
ONE number: a bar that is a different height on your turn makes the felt's bottom
reserve breathe every time the action passes" — but the pin was inside
`@media (max-width: 640px)`, so it protected phones only.

Above 640px the bar therefore grew 12px every time the action came round, and at
84 + 12 + 1 = **97px it stood 1px past the 96px reserve that was meant to be its
ceiling**. That is the same class of defect as the 2026-08-27
"screen is moving in and out constantly" report, surviving at the widths nobody
re-checked. The height change is gone at every width; the lift, saturation,
border glow and rise animation all still fire.

### 3. A phone in landscape took the desktop padding

The padding override was keyed on `max-width: 640px`. A phone held sideways is
812px wide and 375px tall, so it took the 12px desktop padding — on the axis it
has least of.

---

## What replaced it

One token, one continuous curve, no breakpoint:

```css
--sp-action-btn-h: clamp(46px, min(calc(36.5px + 2.545vw), calc(20px + 6vh)), 72px);
--sp-action-pad-top: clamp(5px, min(calc(2px + 0.8vw), calc(1px + 1.2vh)), 12px);
--sp-bottom-row-h: calc(1px + var(--sp-action-pad-top) + var(--sp-action-btn-h));
```

The floor is the phone value the `<=640px` block used to state, and a clamp
reaches its floor at 373px and stays there below it — so **a phone renders
exactly the numbers it rendered before**. The ceiling is the desktop value the
base rule used to state, so a desktop is unchanged too. Everything between them
was unreachable before and is now interpolated.

`min()` of a width-driven and a height-driven term is what makes a landscape
phone behave: on width alone 812px reads as a small desktop and would take a 57px
bar out of 375px of screen. The scarce axis wins.

Measured in the browser, via an iframe per viewport so `vw`/`vh` resolve honestly:

| Viewport                 | Button | Pad  | Row  | Was                      |
| ------------------------ | ------ | ---- | ---- | ------------------------ |
| 375x812 phone portrait   | 46.0   | 5.0  | 52.0 | 46 / 5 / 52 (unchanged)  |
| 812x375 phone landscape  | 46.0   | 5.5  | 52.5 | 72 / 12 / 85             |
| 768x1024 tablet portrait | 56.0   | 8.1  | 65.2 | 72 / 12 / 85             |
| 1024x768 iPad landscape  | 62.5   | 10.2 | 73.7 | 72 / 12 / 85             |
| 1280x800 laptop          | 68.0   | 10.6 | 79.6 | 72 / 12 / 85             |
| 1440x900 desktop         | 72.0   | 11.8 | 84.8 | 72 / 12 / 85 (unchanged) |
| 1920x1080                | 72.0   | 12.0 | 85.0 | 72 / 12 / 85 (unchanged) |

Every value is at or above the 44px minimum touch target. That is the whole
reason the floors are px and not a proportion — a thumb is the same size on every
device, and a button that scaled purely proportionally would go under it on a
small phone.

### The reserve is derived now, not restated

`--sp-bottom-row-h` used to be two literals, and the comment above them had to
end "change this and re-do that sum, nothing else in the codebase can catch the
drift for you." It is derived from the three terms the bar is actually built
from, so a button that changes size changes the reserve in the same step.

The old literals were exactly the drift that predicts. At `<=640px` the sum was
right (1 + 5 + 46 = 52). On desktop it was not: 1 + 12 + 72 = **85 against a
declared 96**. Eleven pixels of reserve stood for a bar that was never that tall,
and since `--sp-action-reserve` feeds `--sp-table-bottom`, which is the felt's
SIZE and not a padding, that was about 6.7px of table width nobody was getting.

---

## THE ONE THING THAT MAY NOT BE DONE HERE

**The buttons may not size themselves from `--table-w`,** and the first draft of
this work was going to.

`--table-w` is written from JavaScript — the `ResizeObserver` in `TablePage.tsx`
that measures `.table-scaler`. The bar's height feeds `--sp-action-reserve`, which
feeds `--sp-table-bottom`, which feeds `--sp-table-h`, from which the scaler
derives its width. A button sized from `--table-w` closes that ring through a live
measurement:

    bar resizes -> felt resizes -> observer fires -> bar resizes -> ...

That is the 2026-08-27 "screen moving in and out constantly" bug rebuilt from the
other end. `tests/unit/feltReserveIsStatic.test.ts` fails if it is ever tried,
because its dependency walk finds `--table-w` in the graph under
`--sp-table-bottom` and intersects it with every property JS writes. The guard is
right and it should stay.

The viewport is the correct reference here anyway: this bar is `position: fixed`
to the viewport and spans its full width. **It is not part of the table and must
not size itself from the table.**

Felt-internal elements are the opposite case and DO belong on `--table-w` —
nothing in the height budget reads them, so there is no ring to close. Chips and
the dealer puck already work this way (`TableVisualHotfix.css`), and cards and
avatars are next.

---

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/` — **532 files, 8277 tests, 0 failures.**
- `feltReserveIsStatic`, `bottomBarReserve`, `shipped-invariants` re-run after the
  final edit — 49 passed.
- Sizes measured in Chrome against the worktree's own dev server, per the table
  above, rather than reasoned about.

Not verified: the rendered table under a live hand. That needs a login, which an
agent does not perform. The numbers above are computed-style readings, and the
felt's own geometry is covered by the guard tests.

## What is not done

- **Cards, avatars and hole-card rows** still ride the 640 / 480 / 380 ladder in
  `SeatSlot.css`. This is the other half of Dan's report. They belong on
  `--table-w` proportions with clamp legibility floors; the geometry there is
  tuned with exact ratios, `:has()` guards for PLO4/5/6 and a separate showdown
  row, so it is a change that deserves its own pass and its own verification.
- **The 641-768px zone** still takes the mobile felt reserve with desktop seat
  internals. That resolves when the seats come off the ladder.
- `.pre-action-btn` keeps a flat `min-height: 52px` and `PreActionBar.css` never
  reads `--sp-bottom-row-h`, though `ActionPanel.css` claims it does. Harmless
  today (that row is `position: fixed` and overlays), but the comment is wrong
  and one of the two should change.
