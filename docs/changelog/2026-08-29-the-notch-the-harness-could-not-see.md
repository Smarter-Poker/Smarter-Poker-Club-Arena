# 2026-08-29 — The notch the harness could not see

Dan, after the edge-to-edge fix was "verified live": "NO, I'VE HARD REFRESHED
MULTIPLE TIMES AND THE TABLE IS STILL TOO SMALL AND NOT WIDE ENOUGH!"

He was right. Twice in one day a felt fix went green everywhere and changed
nothing in his hand, and the second failure is the instructive one.

## Why the first fix did nothing on his phone

Every measurement in this repo — the felt harness, the geometry baseline, the
Playwright device emulations, the live-production DOM probe — runs with
`env(safe-area-inset-*) = 0`. No iPhone Dan has ever held works that way. On
real hardware the notch (~47px, Dynamic Island 59px) is paid through the tab
bar and the home indicator (34px) through the action reserve, all of it out
of `--sp-table-h`. And because `.table-scaler` derived its WIDTH from that
height through the locked 605/1000 aspect, the real felt at 390x844 was
**344 x 569 — height-bound**. Removing 12px side gutters, a width-side fix,
was `min(390, 344)` versus `min(366, 344)`: the same table.

"Verify on real hardware" (working rule 4) is not about effort — emulation
was measuring a device that does not exist.

## The fix, part 1: the harness models the insets

`feltHarness.mjs` now carries two real-hardware rows — `iPhone 12/13/14
(real)` (insets 47/34) and `iPhone 14 Pro Max (real)` (59/34) — and
`applyInsets()` substitutes the `env()` tokens in the CSS text, since no
browser API emulates them. Every beat, the baseline, and the dev table now
see the phone Dan actually holds. If an emulated row and a (real) row
disagree, believe the (real) row.

## The fix, part 2: the aspect lock was no longer load-bearing

The 605/1000 lock dates from when the skin was an oversized composite
cropped by `object-fit: cover`, where the box's shape decided WHICH pixels
of art were visible. Since 2026-08-18 the art is pre-cropped and drawn with
`object-fit: fill` — it stretches to the scaler's box, and the seat ring,
felt window, and every %-positioned element stretch with it by the same
linear map. Internal consistency is free at any aspect. The lock's only
remaining effect was starving the width on height-bound devices.

At <=768px the scaler now fills the budget on both axes: full height, full
width up to a 0.7 roundness cap (so an iPad's huge height budget cannot
balloon the oval toward a circle; desktop keeps the classic 605/1000).

Measured, harness with insets:

| device                     | before      | after       |
| -------------------------- | ----------- | ----------- |
| iPhone 12/13/14 (real)     | 344 x 569   | 390 x 569   |
| iPhone 14 Pro Max (real)   | 369 x 610   | 430 x 644   |
| iPhone SE                  | 287 x 474   | 332 x 474   |
| iPad portrait              | 491 x 811   | 568 x 811   |
| iPad mini portrait         | 558 x 921   | 645 x 921   |
| desktop / landscapes       | unchanged   | unchanged   |

Width is what this buys. LENGTH is budget-bound: every remaining pixel of
length sits inside `--sp-table-top`, `--sp-hero-clear`, the tab bar and the
action bar — those are Dan's tuning knobs, and shrinking them is a separate,
stated decision, not a side effect.

## Guards updated in the same commit

- The edge-to-edge beat now includes both (real) rows — a width-starved
  real phone goes red even when the emulated rows stay green.
- `geometry-baseline.json` regenerated: 15 devices, every changed number an
  increase, stated here per the ritual.

## The lesson for every future measurement

An emulated device with zero insets is a device that does not exist. Any
new visual guard for a mobile surface must include an inset-bearing row, or
it certifies a phone nobody owns.
