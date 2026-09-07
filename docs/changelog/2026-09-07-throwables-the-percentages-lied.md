# The gate before landing 4: four keyframe tables that lied about their own timing

2026-09-07. Landing 3 was merged and published before this pass started, and
verified so: `build-info.json` served `ca_sha` `bb72615b1`, that tree carried
all four rigs with the transform fix, all 37 cues came back byte-identical from
the origin, and all fifteen rig ids and seventy `thr-` keyframe blocks were
present in the shipped `TablePage` chunk.

Then the audit went looking anyway, and found **six player-visible defects, four
of them in rigs that shipped in phase 1 and landing 2.** None was in landing 3.

---

## 1. Four clovers stacked on one point

`horseshoe.tsx` builds the "GOOD LUCK" clovers from a `CLOVERS` table of four
corner offsets:

```jsx
<g className="thr-horseshoe__clover" transform={`translate(${dx} ${dy})`}>
```

That is the bug the previous commit closed in eight places, in the fifth rig,
**walking straight through the law written to catch it.** The check read
`transform="..."` - the literal-string spelling - and this one is a template
literal, so the guard saw nothing and said clean.

All four clovers rendered at the origin, on top of each other, in the middle of
the label instead of framing its corners.

CLAUDE.md 10.86 rule 4 names this exactly: _a fix that leaves the same trap one
level up has not landed._ The check now recognises both spellings. Re-breaking
the clovers turns it red; that was verified, not assumed.

## 2 and 3. Two keyframe tables computed against the wrong zero

**beer, `thr-beer-m2`.** Mug 2's percentages were `(ms - delay) / duration` -
the landing left out. The delay is measured FROM landing, so the elapsed time at
a beat is `(ms - landing - delay)`, and every stop after the pop-in ran **333 ms
late, exactly one flight**:

| stop   | comment says | actually played |
| ------ | ------------ | --------------- |
| 22.93% | 1400 swing   | 1733            |
| 27.52% | 1567 clink   | 1900            |
| 49.55% | 2367 apart   | 2700            |
| 67.88% | 3033 rest    | 3366            |

Mug 1, the foam plume and `glass_clink_rattle` were all correctly timed, so the
clink **sounded a third of a second before the glasses met.** `thr-beer-m2-tilt`
carried the same four percentages and had to move with it - a tilt that drifts
from its own translate tips a glass that has not arrived.

**water_gun.** The four long rules start at landing + their own 67 ms delay =
367, but their percentages were computed against 267. Every stop but the first
ran **100 ms late**: the squirt appeared at 900 while `squirt_start` fired at
800, and the splat cut at 3434 instead of 3334.

The reference settles it. THROW 1's `L` is the spawn frame, the flight row
starts at f178, and `at = raw - 133` gives land 300, pull-back 634, squirt 800,
loop-end 3300, cut 3334, gun-out 3434 - **which is exactly what the spec already
said.** The spec was right the whole time; only the keyframe table disagreed
with it.

## 4 and 5. Two animations that outlived the element they were drawn on

An element removed mid-animation never plays its own ending.

**snowman** ran 167 ms past the unmount, and this one is mine. The plume's fade
was stretched to +1800 to clear a `payloadMs` floor of 1800 - and earlier in
this same phase I LOWERED that floor to 1600, because the clown/snowman gag is
genuinely 1633 ms long. The bound got fixed; the thing the bound had distorted
did not. The payload now unmounts at +1633 while the fade was still scheduled to
run to +1800, so the plume was yanked off screen about a third visible instead of
fading to nothing. It ends at +1600 now - the reference's own tail, one frame
before the cut.

**water_gun** ran 103 ms past it, so the gun's scripted scale-out - four frames
of shrinking in place, in the reference - **never rendered at all.** The four
rules now run 3067 ms from 367 to 3434, which is the payload's own end.

## 6. A scale with no pivot

`.thr-beer__m2` animates `scale(0.1 -> 1.12 -> 1)` with no `transform-box:
fill-box`. Without it the pivot is the SVG **viewport corner**, not the mug, so
mug 2 swam in from the middle of the felt rather than growing where it stands.
Its own siblings already declared it. Four particle classes had the same
omission at smaller magnitude (beer's droplets, champagne's specks and drops,
snowman's specks).

---

## The two new laws

**`a keyframe stop lands on the millisecond its own comment names`.** Every stop
in every rig is a percentage with the millisecond it MEANS written beside it,
and nothing had ever compared the two. It recomputes `landing + delay + pct x
duration` and fails on any stop more than one frame (34 ms) from its own
comment. It finds beer and water_gun at once, and it found a **third** the
moment it ran: a comment I had just written into water_gun myself, off by 133 ms.
That is the check working before the ink was dry.

It reads BOTH the `animation:` shorthand and the `animation-duration` /
`animation-delay` longhand, because water_gun writes its delay on its own line -
and my first throwaway version of this same arithmetic read only the shorthand,
reported water_gun's overrun as 36 ms instead of 103, and I nearly acted on it.
The checker made the identical mistake the rigs made. That is why it is in the
suite now instead of in my scrollback.

**`no animation outlives the payload it is drawn on`.** `delay + duration x
iterations` against `payload.ms`, per rule, per rig. Both overruns above, caught
by arithmetic rather than by someone happening to look at the last frame.

Both were verified RED on the re-introduced defect and green after, along with
the widened transform check.

## The shape, again

Every one of these is the same thing in a different costume: **two things each
correct alone and destructive together.** The spec and the keyframe table, each
internally consistent, disagreeing about zero. A bound and the animation that
had been bent around it, fixed one at a time. A guard and the attribute spelling
it did not know. In every case TypeScript was happy, the classes resolved, the
suite was green, and the only witness was arithmetic nobody had done.

Four of the six shipped in earlier phases and were live in production while
passing 15,000 tests.

## Verified

- `npx tsc --noEmit` clean.
- Full suite green.
- Production build green.
- Darkroom: the clovers now frame the label's four corners, both beer mugs meet
  at the clink, the squirt is on at 800, the gun scales out before the cut, and
  the snowman's seat is clean at 2000.
- Landing 3 confirmed merged AND published before any of this: `ca_sha` ==
  `main`, 37/37 cues byte-identical live, 15/15 rigs and 70 keyframe blocks in
  the shipped bundle.

## Still open, deliberately

`water_gun`'s stop-to-beat mapping was re-derived from the reference and is now
consistent with its spec. `trophy` anchors to frame 2602 where the doc's own
correction rule gives 2603 - one frame, 33 ms, every beat consistent with the
choice. Re-deriving it would put `flight.ms` at 100, below the grammar's 133
floor, so it is left as it is and written down here rather than changed
silently.
