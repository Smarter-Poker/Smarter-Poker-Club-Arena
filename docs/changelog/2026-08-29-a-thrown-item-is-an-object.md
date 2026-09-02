# A thrown item is an object, not a sticker

**2026-08-29** — Club Arena, throwable framework, pass 3.

Dan, on the two PokerBros captures:

> THE WAY THIS IS NOW AN ANIMATION, THE DESIGN GRAPHICS ETC NEEDS TO BE
> REPLICATED INSIDE OF EVERY SINGLE THROWABLE ANIMATION. CURRENTLY ANIMATIONS
> ARE JUST AN FLAT BASIC EMOJI THAT FLOATS AND LANDS, NOT DYNAMIC GRAPHIC
> ANIMATIONS LIKE THIS.

The approved plan for that was **framework first, then the top items**. This is
the framework. Four pieces, each of which lifts all ~40 throwables at once
rather than one item at a time, and each of which shipped because it was simply
**missing** — not because it was tuned badly.

I went looking for why our items read as flat when the reference's read as
solid, and it was not the artwork. Our trajectories are already richer than
theirs: seven physics profiles, per-item duration overrides, velocity tilt,
tumble spin, staggered trail ghosts. The difference was everything the item
does **with the table around it**, and we had none of it.

---

## 1. The contact shadow — the big one

**Nothing was drawn underneath a flying item.** That is the single reason a
thrown object reads as a sticker: a shadow on the felt is the only cue the eye
gets for how HIGH something is. Without one, a 170px lob and an 18px fastball
differ only in speed, and both look like a decal sliding across a photograph.

`.throw-animation__shadow` rides the travelling element so it tracks the throw
horizontally, and is deliberately a **sibling of `.throw-animation__spinner`,
never a child**. A shadow inside the spinner would inherit the arc's vertical
offset and the tumble spin — it would climb with the item and rotate, which
tells the eye there is no ground at all. That is worse than no shadow.

High reads as wide and faint; low as tight and dark. Each physics profile has
its own keyframes **at the same percentage stops as its arc**, because that is
the only way the shadow and the item can agree where the ground is. `lob` shares
`arc`'s curve, so it shares `arc`'s shadow rather than inventing a second one
that could drift from it.

`drop` is the profile where this earns its keep: it hovers high and then slams,
so its shadow starts big and faint and arrives **smaller and darker than any
other profile's**. That contrast is the whole weight cue, and it costs nothing.

Nothing here animates `filter`. The softness is baked into the gradient, and
scaling a soft gradient up softens it further for free — a great deal cheaper
than interpolating a blur under four concurrent throws on a phone.

## 2. The smear is proportional to the actual speed

The two trail ghosts were pinned at `opacity: 0.3` and `0.14` for every throw on
the table. So a 420ms fastball crossing the felt and an 1100ms feather bobbing
the same distance smeared **identically** — and the smear is the main thing the
eye uses to tell them apart.

`--trail-strength` is now computed in `ThrowAnimation.tsx` from the throw's real
px/ms against a reference of 0.55px/ms (roughly a mid-table arc), clamped to
0.35–1.6 so a very short throw never loses its trail entirely and a
corner-to-corner fastball never turns into a solid bar. Opacity and blur both
multiply by it.

## 3. The landing touches the table

Two additions, doing two different jobs, because the reference has both:

- **`.throw-animation__ground`** — the landed item's own shadow, flattening hard
  on contact and recovering with it. That is what makes the squash read as
  weight arriving on a surface rather than a sprite changing shape in mid-air.
  It lives INSIDE `__impact-life` so it shares the landing's opacity envelope
  and needs only its own squash timer; a second life animation on a second
  element is two things that can drift apart. `splat` gets a variant that stays
  spread and never recovers (it has stuck to what it hit); `explode` has no item
  left to cast one.
- **`.throw-animation__dust`** — six particles kicked out **along the felt**.
  The existing shockwave ring is drawn in the screen plane and reads as an
  energy pulse; this reads as the table itself reacting to a weight. The vectors
  are squashed vertically — a circle of offsets would read as a flat
  screen-plane ring, the exact mistake the knockout star made and documented in
  `SeatKnockout.css` — and every particle rises a little before it falls, so it
  is a puff rather than a starburst.

## 4. The settle

A dropped object rocks to rest. Ours stopped dead the instant its squash
resolved, which is the difference between an object and a sticker being
revealed.

`.throw-animation__settle` is its own wrapper on purpose: **one** keyframe then
covers every impact profile, instead of a rotation being threaded through four
sets of squash keyframes that each already own `transform` and would stomp it.
It uses the individual `rotate` property, so nothing it does can ever collide
with a descendant's `transform` — the lesson `skoSeatFlinch` cost us on
2026-08-29 and that CLAUDE.md now records. And it pivots **below** centre,
because a thing rocks on the felt it is touching, not around its middle.

`splat` and `explode` do not rock: one has stuck, the other has been consumed.

### The double-settle guard

Eleven items already have rotational character of their own — a banana peel
slips, dice and a football tumble, a trash can tips over, sunglasses and a
magnet already wobble to rest. `fx-icon-wobble-settle` is **literally this same
animation**. Stacking the house settle on top of a bespoke one is the "two
mechanisms for one job" trap: at best it muddies a hand-tuned curve, at worst it
plays the same rock twice.

They opt out through a single `--settle: 0` list in one place, rather than an
`animation: none` scattered through 11 signature blocks. `--settle` is a
**multiplier, not a switch**, so a signature that wants a half rock can say
`0.5`.

The list is not trusted. The law test **re-derives** it from
`ThrowableSignatures.css` — parse every `@keyframes`, keep the ones containing a
rotation, find every `data-throwable` whose `impact-icon` rule uses one — and
fails if any of them is missing from the opt-out. An item whose signature gains
a rotation later cannot quietly start double-rocking.

---

## Reduced motion

CLAUDE.md §10.6: reduced motion collapses motion, never meaning. The flight
shadow and the dust are theatrics and go. **The ground shadow stays** — it is
not drama, it is the cue that says the item is ON the felt. It simply stops
moving. Pinned both ways: the test asserts the ground shadow is never given
`display: none` in that block.

## Verified, not assumed

- 29 pins across seven new law tests, all green, run against the real files
  before the ship script was touched.
- Both stylesheets re-parsed with PostCSS: `ThrowAnimation.css` 243 rules / 39
  keyframes, `ThrowableSignatures.css` unchanged at 381 / 52 (this pass does not
  edit it — it only reads it, in the guard above).
- `ThrowableSignatures.css` has **32** selectors targeting
  `.throw-animation__impact-icon` and **not one** of them is a direct-child
  selector, which is why the new `__settle` wrapper can be inserted between
  `__impact-life` and `__impact-icon` without breaking a single item signature.
  Checked before writing the wrapper, not after.
- Every new duration either scales by `--animation-speed` or defers to a
  pre-scaled `--flight-dur` / `--impact-dur`, so the existing "every duration
  scales" law still passes with zero unscaled declarations.

## What is still honest to say

This has not been seen on a real table. The framework is measured and pinned,
but the tuning numbers — shadow opacities, dust vectors, the settle amplitude —
are judgement, and judgement about animation is worth exactly what it looks like
at 375px on a phone. The next pass is the bespoke work on the most-thrown items,
and the first thing that should happen before it is Dan looking at this one.
