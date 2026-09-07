# Landing 3, and a transform that quietly ate eight measured positions

2026-09-07. Items 8 to 11 of the fourteen reference objects - **trophy, cake,
banana_peel, cash_stack** - plus eleven new cues, plus one root-cause fix that
turned out to reach back into landing 2.

The registry is fifteen rigs now.

---

## The bug the darkroom found

The cake's build sheet says a strawberry sits at the crown of the head from the
plate frame (300) onward, and stays there through the slide, the fade and the
residue. The rig said so too:

```jsx
<g className="thr-cake__berry" transform="translate(2 -46)">
```

The darkroom photographed it in the middle of the face.

**A CSS `transform` in a keyframe REPLACES the SVG `transform` ATTRIBUTE on the
same element. It does not compose with it.** `thr-cake__berry` animates
`transform: scale(0.6)` to `scale(1)`, so the instant the animation starts the
`translate(2 -46)` is gone and the element renders at the SVG origin - which,
in a rig viewBox of `-150 -150 300 300`, is the centre of the target's face.

Nothing catches this by reading the code. The attribute is right there, the
class is right there, both are correct in isolation, and TypeScript, the
stylesheet and every existing law are all satisfied. It is only wrong when the
two meet on one element, and the only witness is a picture.

## It was never one rig

Grepping for the SHAPE rather than the symptom found **eight instances across
five rigs**, three of them shipped in landing 2:

| rig         | element                | measured position   | rendered at |
| ----------- | ---------------------- | ------------------- | ----------- |
| `cake`      | `thr-cake__berry`      | `translate(2 -46)`  | origin      |
| `dice`      | `thr-dice__hand`       | `translate(0 12)`   | origin      |
| `horseshoe` | `thr-horseshoe__bob`   | `translate(0 -10)`  | origin      |
| `horseshoe` | `thr-horseshoe__rays`  | `translate(0 -8)`   | origin      |
| `horseshoe` | `thr-horseshoe__label` | `translate(0 -8)`   | origin      |
| `snowman`   | `thr-snowman__plume`   | `translate(0 -46)`  | origin      |
| `trophy`    | `thr-trophy__sparkle`  | `translate(6 -34)`  | origin      |
| `trophy`    | `thr-trophy__sparkle`  | `translate(-9 -30)` | origin      |

The snowman's powder plume is the loudest of them - 46 units is nearly half an
avatar width, so a plume the reference puts ABOVE where the head was was
drawing across the face instead.

The two trophy sparkles are the most interesting, because the failure is not
"in the wrong place" but **"one glint instead of two"**: both collapsed onto
the same point and stacked. Two beats, 334 ms apart, measured at different
points on the cup, photographing as a single unchanging star. A wrong offset
looks like a mistake; this looks like a design.

## The fix

The pattern `rose.tsx` already used on purpose, applied to all eight: the
measured position goes on a **plain wrapper `<g>`**, the animation goes on the
child. A wrapper with no class has no keyframes, so nothing can discard its
transform.

```jsx
<g transform="translate(2 -46)">
  <g className="thr-cake__berry">
    <Strawberry />
  </g>
</g>
```

The cake's strawberry also moved AFTER the residue in document order. It was
drawn before the smear, so even once it was in the right place the smear
painted over it - and the build sheet is explicit that the strawberry is still
at the crown once the plate is gone.

## The pin

`tests/throwables-play-the-measured-grammar.law.test.ts` grew a case: **a
measured position is never on the same element as an animated transform.** It
reads every rig stylesheet, collects the classes whose keyframes write
`transform` at all, then fails on any JSX element carrying one of those classes
AND a `transform` attribute.

It was verified to fail, not merely to pass: reverting the snowman plume to the
old shape turns it red with the offender named in full -

```
snowman.tsx: thr-snowman__plume carries transform="translate(0 -46)",
which its own keyframes discard
```

- and green again when restored. A check that has never been seen to fail is
  not a check (10.86).

This is the third root cause in this programme closed at the cause rather than
at the instance, and the shape keeps repeating: **two things that are each
correct alone and destructive together.** The multi-class hole in
`classNamesResolve` (a name that matched no rule), the delayed `both` with a
hidden `0%` frame (an element invisible on its own beat), and now a keyframe
that eats a sibling attribute. In all three the compiler was happy, the tests
were green, and only a photograph disagreed.

## Landing 3 itself

**trophy** (video 1, throw 12) - lands, vanishes in one frame, a wisp rises, a
beam grows out of the shoulder with a dark silhouette forming inside it, the
silhouette hands off to solid gold at 733 on the frame the beam peaks, then two
glints at 2433 and 2767. Nine beats.

**cake** (video 2, throw 2) - contact intact at 133, a three-frame press, the
squash at 267, the plate turning face-on at 300 with splatter round its top
edge, a slide down the face 500 to 967, a fade, and a cream smear that holds to
the cut at 3500.

**banana_peel** - the flash and the draped peel, four beats, static from 200.

**cash_stack** - the burst at 700 and the money cloud at 900, settling to 3533.

The trophy agent caught, independently, that video 1's `L` is the SPAWN frame,
not the launch frame. Scanning both reference documents found **ten of twelve
tables in video 1 mislabelled the same way**. That correction is its own
changelog entry (`2026-09-07-throwables-a-beat-that-photographs-empty.md`);
what landed here is the doc warning above `## Throws` and the `land == flight.ms`
law that makes a rig measured from the wrong zero fail rather than merely look
slightly off.

### Cues

Eleven new, all built from the four licensed sources, all measured non-silent:

```
swell_low -10.9   chime_shimmer  -2.8   fanfare_short  -1.0   sparkle_bed -10.9
whoosh_low -13.4  splat_heavy    -0.8   splat_wet_small -6.0  boing_splat -2.9
thump_soft  -5.4  tick_settle   -14.8   cash_register_cascade -4.5   (dBFS)
```

37 cues, **zero placeholders**, every one above the -30 dBFS floor.

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run tests/` - **15,525 tests, 1,113 files, all passing.**
- Darkroom: 176 shots. Every beat of all fifteen rigs photographed at its own
  millisecond, animations paused and driven by `currentTime`, four seat rungs.
- The new law verified red on the old shape and green on the new one.

## What is left

Landing 4 is the last three: **poop, bomb, rocket** - the three-stage airstrike.
`bomb` is why `payloadMs.min` came down to 1600 earlier in this phase.
