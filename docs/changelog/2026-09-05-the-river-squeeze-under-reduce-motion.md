# The river squeeze did nothing, and Reduce Motion is why

2026-09-05. Dan: **"NOTHING WORKS FOR THE SQUEEZE ON THE RIVER. DO NOT CLAIM
SUCCESS AGAIN UNTIL YOU'VE VERIFIED IT WORKS."**

He was right, and the reason nothing caught it is as important as the bug.

## How it was found

Nothing in the repo rendered the real board in a real browser. The component
tests run in happy-dom - no cascade, no media queries, no pointer - so they
proved the ATTRIBUTES were set. `tests/e2e/card-squeeze-mobile.spec.ts` runs
in chromium but mounts HAND-WRITTEN markup, so it proved the STYLESHEET was
sane against a div the component never produces. Between the two there was no
test that could see this.

So the `/sim` route (public, no auth, already renders the real
`CommunityCards`) gained a `?squeeze=1` knob alongside its existing `?slide=1`
and `?cards=` dev knobs, and `tests/e2e/river-squeeze-interactive.spec.ts`
drives it with a real mouse.

## The bug

**With `prefers-reduced-motion: reduce`, the river resolved the `reduced`
profile**, which has `holdMs: 0`. Measured on an emulated iPhone 13:

|                      | `data-rs-profile` | `data-rs-hold` | the card            |
| -------------------- | ----------------- | -------------- | ------------------- |
| Reduce Motion off    | `all-in`          | `drag`         | face down, waiting  |
| **Reduce Motion on** | **`reduced`**     | **absent**     | **already face up** |

There was no hold, no interactive host and nothing to squeeze - the perk
simply did not exist. Reduce Motion is a switch a great many phones carry, and
95% of this platform's players are on phones.

It was also wrong on its own terms. CLAUDE.md 10.6 says reduced motion
"collapses motion but never meaning". The squeeze is not decoration: it is a
VIP perk the player OPERATES, on a beat the SERVER is pacing. Collapsing it
removed the feature, not the movement.

### The fix

A new profile, `allInReduced` - the same beats, the same server-paced ceiling,
`interactive: true`, `threeD: false`, no overshoot, no sweep. The resolver
hands it to a viewer who is owed the squeeze and prefers reduced motion.

The stylesheet's reduced-motion block no longer flattens an interactive card.
It keeps the hold and drives the two faces' OPACITY from the same `--rs-drag`
the pointer writes, so the card still waits face down and still opens under
the player's hand - it fades instead of turning. Direct manipulation, no
autonomous motion, opacity only.

Verified in chromium on an emulated iPhone, Reduce Motion on:

```
at hold        front 0     back 1      (face down)
mid-drag 0.556 front 0.37  back 0.63   (opening under the finger)
after release  front 1     back 0      (face up)
```

Reduce Motion off is unchanged: `all-in`, the 3D turn, exactly as before.

## A second, separate defect found on the way

`squeezeVars` clamped a server-paced reveal by writing
`--animation-speed: min(1, var(--animation-speed, 1))` - **a custom property
defined in terms of itself.** That is a cycle, and a cyclic custom property is
invalid at computed-value time. Measured in chromium: it computed to the empty
string on the host and every descendant, so every `var(--animation-speed, 1)`
in the stylesheet fell back to 1 and **the clamp never ran at all**. A player
on Fast got speed 1 on the all-in card and the mechanism the comment described
was fiction.

It writes `--rs-speed` now, which reads `--animation-speed` without being it,
and the stylesheet reads `var(--rs-speed, var(--animation-speed, 1))` so an
unclamped profile still follows the player's own setting. Pinned both ways.

## The gesture is more robust, and one window is documented rather than hidden

The drag used to depend on `setPointerCapture` plus React handlers on the card
itself. The move/up listeners now live on the WINDOW for the life of the
gesture. The card is 58px wide on a desktop and smaller on a phone, and a full
squeeze needs most of that in travel: a thumb WILL leave the card, and a
capture that did not take used to freeze the squeeze halfway with no way to
finish it. The pointerdown also measures the card's UNSCALED width, so a
squeeze begun while the card is still materialising needs the same travel as
one begun a second later.

**Known and deliberately not papered over:** a press dispatched inside the
card's first ~100ms, while `ccCardMaterialize` runs, lands about one time in
three (measured, ten runs; from 150ms on it was 7 for 7). That window is not
one a player can act in - the card then holds for 2.25 SECONDS and a human
reaction is ~200ms - so it is a robot-only race. The e2e waits 200ms before
touching the card, which is the test behaving like a person; the window is
recorded here rather than swept up.

## What is now covered

`tests/e2e/river-squeeze-interactive.spec.ts`, in chromium, against the real
component: the river holds face down under an interactive host; a pointer at
the card's centre actually reaches the card; a drag turns it; releasing past
the threshold opens it; a short drag springs it back; left alone it opens
itself before the next street could land; and both Reduce Motion cases - the
perk survives, and the motion is genuinely collapsed (it never rotates).

## What is still NOT verified, and I am not claiming it

This is verified against the real component in a real browser. It is **not**
verified on a live table with a live all-in, because I cannot deal myself a
hand. What the live table adds on top is the eligibility gate, and every term
of that gate was read from production and is sound for Dan (`kingfish`):
`is_vip` true / `vip_tier` lifetime, `all_in_squeeze` true, `animation_speed`
1, `skip_animations` false; the shipped bundle carries `squeezeEligible`,
`onSqueezeHold`, `all_in_squeeze:!0` and the full stylesheet. If it still does
nothing on a real table after this ships, the next thing to instrument is
`useVIPStatus`, which starts false and answers false on any read error.
