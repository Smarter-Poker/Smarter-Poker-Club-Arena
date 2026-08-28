# Cards, avatars and seats are a fraction of the felt, not a rung on a ladder

**Dan, 2026-08-28:** "WHY DOESN'T THE LIVE TABLE SCALE DIFFERENTLY PER DEVICE?
MY BUTTONS AND CARDS LOOK THE SAME NO MATTER IF I'M ON A PHONE, OR A TABLET."

The buttons were fixed in `2026-08-28-action-bar-scales-continuously.md`. This is
the cards.

---

## The number that made the case

`scripts/dev/measure-felt.mjs` is new here and everything below rests on it. It
loads the real stylesheets into the real element nesting at real device
viewports and reads back what the cascade actually produces — no dev server, no
login, no arithmetic done in a comment.

It calibrates against the one production measurement this repo has written down
(TablePage.css: Chromium at 1204px, `--sp-action-h` 97px, scaler 606.2 x 1002)
and reproduces it exactly, which is what makes the rest of its output worth
quoting. **Its first version did not** — it came out 49px short in
`--sp-table-h`, exactly the tab bar, which is how we learned that recorded
figure was taken on the standalone route rather than the embedded one.

The card as a percentage of the felt, before:

| Device                   | Felt | Card | **Card / felt** |
| ------------------------ | ---- | ---- | --------------- |
| iPhone SE 375x667        | 287  | 45   | 15.7%           |
| iPhone 12/13/14 390x844  | 366  | 51   | 13.9%           |
| iPhone landscape 844x390 | 96   | 60   | **62.5%**       |
| iPad portrait 768x1024   | 491  | 60   | 12.2%           |
| iPad Pro 12.9 portrait   | 670  | 60   | **9.0%**        |
| laptop 1280x800          | 324  | 60   | 18.5%           |
| desktop 1440x900         | 381  | 60   | 15.7%           |

A card that is 9% of the table on one device and 62% of it on another is the bug,
stated as a number. The cause was a px ladder — 60 / 57 / 51 / 45 at
base / 640 / 480 / 380 — that **stopped at 640px**, so a 768px tablet, a 1024px
iPad and a 1920px desktop all drew the identical 60px card.

## What it is now

One fraction, everywhere: **13.9% of the felt's measured width** for the card,
**15.8%** for the avatar slot, **9.8%** for the tabled showdown card. Those are
the iPhone 12/13/14 values — the tier with the most review behind it, and the one
Dan chose as canonical.

Height and step are **derived** (`x1.4` and `x0.72`, which were already the
ratios at all four old rungs, to the pixel) rather than typed alongside, so the
trio cannot drift. The PLO4/5/6 `:has()` guards became ratios of the same token,
which retired three of their four copies: twelve rules holding nine numbers are
three rules holding three ratios.

After:

| Device                  | Felt | Card | Card / felt   | Avatar / felt | PLO4 row / felt |
| ----------------------- | ---- | ---- | ------------- | ------------- | --------------- |
| iPhone SE 375x667       | 287  | 44   | 15.3% (floor) | 17.4%         | 34.5%           |
| iPhone 12/13/14         | 366  | 50.9 | 13.9%         | 15.8%         | 31.3%           |
| iPad portrait           | 491  | 68.3 | 13.9%         | 15.8%         | 31.3%           |
| iPad Pro 12.9 portrait  | 670  | 93.1 | 13.9%         | 15.8%         | 31.3%           |
| laptop 1280x800         | 324  | 45   | 13.9%         | 15.8%         | 31.3%           |
| desktop 1440x900        | 381  | 53   | 13.9%         | 15.8%         | 31.3%           |
| large desktop 1920x1080 | 490  | 68.1 | 13.9%         | 15.8%         | 31.3%           |

Flat, which is the whole point. The floors bind only where they are supposed to:
an iPhone SE, whose 287px felt would otherwise ask for a 40px card.

**Desktop gets smaller elements, and that is the intended result, chosen
explicitly.** A 1440x900 desktop has a 381px felt — smaller than an iPhone 14's
366px is far off, and smaller than an iPad's 491px outright — because the felt is
derived from leftover HEIGHT. Its old 84px avatar was 22% of its table against a
phone's 15.8%. It was oversized; it is now the same proportion as everywhere
else.

### The fit guarantees stopped being sums and became structure

This is the part worth keeping. Every worked example in `SeatSlot.css` — the
two-card row inside the PLO4 row inside the felt, the PLO6 tabled hand against
its strip of backdrop — was a hand-checked sum at four fixed widths, re-derived
by hand whenever anything moved. Both sides are fractions of the same
`--table-w` now, so a ratio that holds at one size holds at all of them. The
`PLO4 row / felt` column above is the evidence: 31.3% at every viewport.

### Two bugs found on the way

- **`.table-page--tournament .seat-wrapper--top .seat` read
  `--seat-avatar-base: var(--seat-avatar-base, 84px)`** — a custom property
  referencing _itself_, which is invalid at computed-value time and was
  resolving through the inheritance chain to the 84px fallback. It gave the
  right answer for the wrong reason, and only while the full size happened to be
  a literal 84. With a proportional slot it would have frozen every tournament
  top seat at 84px while the rest of the ring scaled. It names
  `--seat-avatar-full` now.
- **The `--table-w` fallbacks in `TableVisualHotfix.css` were guesses at a number
  CSS can compute exactly** — `min(100vw - 28px, 360px)` with 600px and 720px
  rungs, against a real felt of 324px on a laptop. An overstatement of 122%.
  Harmless while only the chip and puck read it (both tightly clamped); not
  harmless once cards do, because the frame before the ResizeObserver publishes
  would have drawn a 100px card and snapped it to 45px. It is
  `clamp(200px, calc(var(--sp-table-h) * 0.605), 720px)` now — not an
  approximation of the scaler's width but the _same expression the scaler uses_,
  so first paint is already right and the observer only confirms it.

## Six tests changed, none weakened

All six pinned the ladder itself ("must be tuned at all four breakpoints"), which
is the correct guard for four independent copies and the wrong one for a
continuous expression. Per the house rule, they are updated in the same commit —
and each got **stronger**, because the new mechanism can be pinned structurally
where the old one could only be counted:

- `HeroCardRowGeometry`: "tuned at 4 breakpoints" -> "declared exactly once, and
  every value derived from `--sp-card2-w`, never a literal". Catches a rung
  somebody adds back, which the old test could not.
- "hold'em card equals PLO4 at every breakpoint" -> asserts PLO4's width **is**
  `var(--sp-card2-w)`. The old test compared eight literals at four widths and
  could say nothing about a fifth — a tablet, which is where Dan noticed this.
  Equality now holds by identity at every viewport.
- The tabled row's separate budget: was "declared 4 times", now "its coefficient
  is strictly smaller than the private row's" — the actual invariant.
- `table-seat-ring-integrity`: `SEAT_BOX_W_PX = 96` became `seatBoxWPx(feltW)`,
  because the box is `max(96px, --seat-avatar-full * 1.143)` now. The collision
  maths survives and the file says why: separations are percentages of the felt
  and the box's proportional term is 18.06% of it, so both scale linearly and
  keep their ratio. The floor case is the tight one and is already what the
  phone assertions measure.

## The E2E spec caught two things the unit tests could not

`tests/e2e/hero-card-row.spec.ts` renders real pixels, and it went red on the
first push with 38 failures. Both causes were in the test, and both were worth
finding.

**1. It read a custom property as text.** `parseFloat(getComputedStyle(row)
.getPropertyValue('--sp-hero-card-step'))` worked only while the token was a px
literal. An unregistered custom property computes to its token stream with
`var()`s substituted, not to a length — so the moment step became
`calc(var(--sp-card2-w) * 0.72)` that returned **NaN**, and `toBeCloseTo(NaN)`
fails against every real number. The row itself measured perfectly the whole
time. (My own harness hit this too, and printed a confident `0` for every card
before I noticed.) It resolves the token through a real property now.

**2. The fixture faked a felt without publishing `--table-w`.** The harness
pinned `.table-scaler` to a flat 320px at every breakpoint, which was fine while
cards were viewport-keyed and meaningless once they are felt-keyed: the cards
sized themselves from a number with no relationship to the box they had to fit
inside. It now sets a felt width per breakpoint — **measured** with
`measure-felt.mjs` at each of the spec's own viewports (383 / 419 / 426 / 351;
note tablet and phone come out wider than desktop, because the mobile blocks
reserve far less height) — and publishes it as `--table-w` exactly as
TablePage.tsx does.

**And then my fix for (1) introduced a third, which is the good part.** Appending
the measurement probe to the row made it one more direct child, so
`:has(> *:nth-child(4|5|6))` shifted by one: a 4-card row resolved PLO5's tokens
and a 5-card row PLO6's. It failed the 4- and 5-card beats at every breakpoint
while 2 and 6 passed — 2 is below the first guard and 6 above the last, so
neither has a rule an extra child can reach. That signature is what identified
it. The probe goes inside the first card now, where it inherits every token and
is invisible to `> *:nth-child()`.

It is the same `:nth-child` trap this spec's own header was written about (the
`.seat__card-pick` wrapper), arriving in the test instead of the stylesheet.

## Two things that harden this rather than extend it

**`--table-w` is a registered `<length>` now** (`@property`, `TableVisualHotfix.css`).
An unregistered custom property computes to its token stream, not a value, and
that cost real time twice in one day: `getPropertyValue` returned the literal
string `"clamp(44px, calc(...), 100px)"`, so `parseFloat` gave **NaN** in both
`measure-felt.mjs` (which printed a confident 0px card for every device) and in
38 beats of `hero-card-row.spec.ts`. Registering the source is that fix one level
up, and it makes the felt width interpolable — which matters now that every card,
avatar and chip is a fraction of it.

The trap is `initial-value`, and it is load-bearing: a registered property
_always_ has a value, so the fallback in `var(--table-w, 360px)` becomes
unreachable. `initial-value: 360px` carries that number instead, so a `.seat`
rendered outside a scaler lands exactly where it did before. Verified
behaviour-neutral: every measurement below is identical to the run before
registration, and the calibration still reproduces 606.2 x 1002 exactly.

**The measurements are a CI guard now, not a script I ran once.**
`tests/e2e/table-proportions.spec.ts` measures all thirteen devices on every pull
request and asserts the property that was actually broken — **the fraction is
flat** — rather than any particular pixel count, which would make it a chore
rather than a guard. It also pins the ordering directly: two devices whose felts
differ by more than 40px may not draw the same card, which is the original bug
stated as an assertion.

Both it and `measure-felt.mjs` drive the same
`tests/e2e/support/feltHarness.mjs`. One harness, because this whole pass was
about deleting duplicated numbers and a second copy of the thing that _measures_
them would be a poor joke.

**Mutation-tested, because a guard that cannot fail is a claim.** Appending
`@media (min-width: 768px) { .seat { --sp-card2-w: 60px } }` turns 3 of the 6
beats red, and the message names the devices and the percentages:

```
iPad portrait (768x1024): card is 60px on a 491.1px felt = 12.2%, expected 13.9%
iPad Pro 12.9 portrait (1024x1366): card is 60px on a 669.9px felt = 9.0%, expected 13.9%
```

Those are the exact numbers this document opens with. The guard reproduces the
original bug on demand.

It is named explicitly in `ci.yml`'s `css-beats-e2e` command — see the note there
about `hero-card-row.spec.ts`, which sat in **no job at all** for 39 commits. A
spec that is not listed cannot fail anything.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run tests/` — **538 files, 8332 tests, 0 failures.**
- `npx playwright test hero-card-row multi-table` — **52 passed.**
- `node scripts/dev/measure-felt.mjs --calibrate` — reproduces the recorded
  production figure exactly.
- Every number in this document is harness output, not arithmetic.

Not verified: a rendered table under a live hand, which needs a login an agent
does not perform.

## STILL BROKEN, AND IT IS NOT THE CARDS

`iPhone landscape 844x390` is the one row above that is still wrong: a **96px
felt**, with the PLO4 row at 103% of it. The cards improved it (62.5% -> 45.8%)
and cannot fix it, because the felt itself has collapsed.

**This cannot be fixed by scaling anything.** `.table-scaler` is
`aspect-ratio: 605/1000` — a portrait oval — and its width comes from leftover
height. A 390px-tall viewport has ~290px of height after chrome, which is a
175px-wide table however the reserves are tuned. The same cause gives a 1280x800
laptop a 324px felt.

The fix is a landscape oval, and `TablePage.css:869` says exactly what that
costs:

> the canonical 896x1200 skin composites ... **the seat ring percentages in
> TablePage.tsx are derived from THIS box; changing the aspect moves every seat
> off the painted rail**

So it needs new artwork at a landscape aspect _and_ a second set of seat-ring
percentages. That is a design project, not a CSS change, and shipping the ratio
change alone would put every seat off the rail. Dan asked for it in this pass;
it is not refused, it is blocked on a decision only he can make — landscape
artwork, or an orientation prompt (there is currently neither, and no lock, so
players can reach that 96px table today).
