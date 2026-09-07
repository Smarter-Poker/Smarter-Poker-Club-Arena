# Throwables phase 2, second landing: horseshoe, trash can, dice, snowman

2026-09-06. Dan: "MOVE ONTO THE NEXT PHASE 3 OF 14."

Items 4 to 7 of phase 2's fourteen. Seven of fourteen are now rigged, and with
phase 1's four that is **eleven items playing the measured grammar**.

## What shipped

| item        | reference                      | the performance                                                                                                                                                                                                        |
| ----------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `horseshoe` | video 1 THROW 5, launch f975   | lands and takes one soft 12 px bob; the shading is lost and the shoe blooms into a flat glowing silhouette at 1167; "GOOD LUCK" grows out of that glow at 1467 with a ray burst; four clovers from the corners at 1867 |
| `trash_can` | video 1 THROW 6, launch f849   | the 2-7 gag. Can lands and VANISHES; a 2 pops out upper-left, a 7 upper-right; a grawlix bubble; the cards shift; the can rises with a lid that opens, takes both cards back, and closes; flies until the cut at 4500  |
| `dice`      | video 1 THROW 8, launch f1683  | the ONLY tumbling projectile in the set. A pair of dice spin in flight, then a hand cups them and works a 1.4 s shake cycle to the cut at 5600                                                                         |
| `snowman`   | video 1 THROW 10, launch f2187 | the shortest item in the set. Lands, VANISHES in one frame leaving only the red nose, a powder plume grows above the head, specks spray, the nose falls to the chin, the cloud lingers and fades by 2000               |

`horseshoe` carries the set's **one sanctioned on-felt caption**, drawn as SVG
`<text>` inside the rig rather than as a DOM node over the felt, Title Cased,
no em dash. `dice` is the only spec in the whole programme with
`flight.tumble: true`; the rotation belongs to the player's own
`thr__proj--tumble` class and the rig does not spin anything itself.

## Ten new cues, and the voice line that is still owed

`tick_land`, `horseshoe_clank`, `card_slap`, `bubble_tick`, `can_rattle_rise`,
`lid_clank`, `dice_rattle` from the CC0 packs; `flies_buzz` and `poof_soft`
synthesised, because a clean loopable fly buzz and an airy powder poof are not
in any of them. Twenty-six cues now, **still zero placeholders**.

**The horseshoe ships without its voice line, deliberately.** The build sheet
wants a recorded male "Good luck" about 300 ms after the label settles - one of
only two spoken lines in the set. No CC0 pack has that phrase, and the
placeholder ratchet is at zero, so declaring one would put the library back to
having a stand-in in it. The CAPTION carries the meaning until Dan supplies the
clip. That is written into the rig contract so the next agent does not invent a
cue name for it.

## What the verification caught

**1. The snowman's reference measures from a different zero, and the rig had
been built on the wrong one.** Video 1's other throws set `L` at the LAUNCH
frame, so their catalogue ms drop straight into `beats`. THROW 10 sets
`L = f2187`, the frame the figure first appears **on the thrower**, and the
flight does not start until f2194 = 233. The rig had been built by shifting
everything 200 ms and calling the flight 400; the true mapping is catalogue
minus 233, with a flight of 367 (f2194 to f2205 is eleven intervals at 30 fps,
not the twelve frames the table counts). Every beat was one frame out. The CSS
needed no change - its delays are landing-relative, and both `flight.ms` and
every `beat.at` moved by the same amount - but the recorded numbers are the
record, and they are the reference's now.

**2. `THROWABLE_GRAMMAR.payloadMs.min` was wrong, not the snowman.** The floor
was 1800 and the snowman is on target for 1633. The instinct is to stretch the
fade until it fits; the bound is what fails. It was derived from a sample that
did not include the shortest items, and the plan's own life table lists the
clown at 2.23 s, the glove at 2.07 and the bomb at 2.0 - three measured items
the floor excludes. It is 1600 now, with the measurement written beside it, and
`bomb` will need that same room in the next landing.

**3. The horseshoe's glow faded to nothing behind the settled label.** The
reference is explicit: "Text hold 1667-3767+ ... with a faint yellow glow." The
darkroom's 1867 frame photographed the label sitting on a bare avatar. The glow
holds at 0.22 now.

Two things that LOOKED like defects at contact-sheet size and were not, both
settled by zooming rather than guessing: the horseshoe label is genuinely on
screen at 1467 but at `scale(0.12)`, which is the reference's "tiny at 1019";
and the snowman's red nose is behind the plume at 534 and clearly at the chin
by 767, which is the fall the reference describes. **A 260 px tile is not
enough to call a bug.**

## Verification

`npx tsc --noEmit -p tsconfig.app.json` exits 0. The specs test, the cue licence
test, the class-name ratchet, the grammar law and the animation law all pass,
and the FULL `tests/` suite is green. Every one of the four was frozen at every
beat of its own spec, at all four seat rungs, before any of it was called done.

## Honest gaps

1. **Seven of fourteen remain**: trophy, cake, banana_peel, cash_stack, poop,
   bomb, rocket. Their cue names are fixed in the rig contract.
2. **The horseshoe's voice line** waits on Dan's clip, as above.
3. **Still never seen on a real table** - every judgement is darkroom-against-
   mock-felt, as in phase 1 and the first landing.
4. **The trash can's card flight paths are chosen, not read.** The reference
   gives "upper-left", "lower-left" and the can's own return position, but no
   pixel coordinates for the cards' arcs. They are symmetric and they converge
   on the can's measured mouth, which is the most the capture supports.
5. **The dice hand's shake amplitudes are interpolated.** The reference names
   the phases (dip, palm-down jiggle, low hold, shake) and their frame ranges
   but not the pose deltas.
6. **One measured dice click is dropped**: burst 3's fifth, at 5700, falls 100 ms
   after the build sheet's own stated cut at 5600. The cut wins.

## Files

```
added    src/throwables/rigs/{horseshoe,trash_can,dice,snowman}.{tsx,css}
added    docs/changelog/2026-09-06-throwables-phase-2-landing-2.md
changed  src/throwables/spec.ts (payloadMs floor 1800 -> 1600, measured)
changed  src/throwables/registry.ts (four rigs wired in; eleven now)
changed  scripts/audio/throwable-cues.manifest.json (ten cues; 26 total, 0 placeholders)
changed  docs/throwables/PHASE2-RIG-CONTRACT.md (no voice cue exists; do not name one)
```
