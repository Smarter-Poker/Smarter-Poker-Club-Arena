# 2026-08-29 — The edge-to-edge felt that never shipped

Dan, from his phone: "the table width and length has shrunk and need to be put
back to how it was."

## What actually happened

PR #950 (2026-08-26 06:26) removed the `padding-left: 4px; padding-right: 4px`
longhands from the `<=768px` `.table-container` block, with a comment saying
"gutters removed per Dan — edge-to-edge felt at 375px measures 375x619.8".

Deleting an override does not produce zero. It resurrects the base rule, and
the base `.table-container` shorthand is `padding: var(--sp-table-top) 12px
var(--sp-table-bottom)`. So the "widening" gave every width-bound phone 12px
gutters instead of 4px, and the felt NARROWED:

| state                      | felt at 390x844 | felt at 375 |
| -------------------------- | --------------- | ----------- |
| before #950 (4px gutters)  | 374 x 618       | 367 x 606.6 |
| #950's comment claimed     | —               | 375 x 619.8 |
| what #950 actually shipped | 364 x 602       | 351 x 580   |

The 375x619.8 in that comment was never rendered by any shipped build. The
length followed the width through the locked 605/1000 aspect. It survived
three days because the felt harness agreed with the CSS at every commit — the
bug was not a drift between commits, it was a comment asserting a measurement
no spec pinned.

## How it was found

The synthetic felt harness showed the budget byte-stable for three days
(366px at 390x844 at every commit since #950), while Dan's screenshot showed
a shrink — so the regression had to be either older or outside the harness's
five stylesheets. Two real-DOM measurements settled it:

- live production at 390x844 (authenticated Playwright, iPhone 12 profile):
  scaler 364 x 601.6;
- the Aug-25 build (the pre-#950 bundle still sitting in the World Hub's
  `public/hub/club-arena/`, served locally): scaler 374 x 618.2.

Production had been 10px narrower and 17px shorter than the last build Dan
had approved, since the commit whose stated purpose was making it wider.

## The fix

`padding-left: 0; padding-right: 0;` stated as longhands in the `<=768px`
block of TablePage.css — what the removal actually meant. Measured after:

| device                     | before               | after       |
| -------------------------- | -------------------- | ----------- |
| iPhone 12/13/14            | 366 x 605            | 390 x 644.6 |
| iPhone 14 Pro Max          | 406 x 671            | 430 x 710.7 |
| iPhone SE                  | 286.7 (height-bound) | unchanged   |
| iPads, landscapes, desktop | height-bound         | unchanged   |

Every proportion beat stays flat (cards 13.9%, avatars 15.8%, PLO4 row 31.3%)
— everything on the felt grows with it.

## The guard

New beat in `tests/e2e/table-proportions.spec.ts`: "the felt is edge-to-edge
on portrait phones". The two width-bound devices in DEVICES must render a
felt exactly as wide as their screen. If a gutter comes back — including by
someone deleting the new longhands, which is how this shipped the first
time — the beat names the device and the pixels lost. It runs in
css-beats-e2e, which is a required check.

## Left alone, deliberately

- The desktop/base 12px side padding: desktop is height-bound everywhere, so
  the gutters cost the oval nothing there.
- The `--sp-table-top`/`--sp-hero-clear` budget: untouched, still the numbers
  Dan tuned on 2026-08-25/26.
- Stale comments in the `<=480px` and `<=380px` blocks still say the foot
  block "overrides padding-left and padding-right" — true again as of this
  fix, so they are correct once more.
