# Throwables phase 1: the player, the pipeline, and the first four rigs

2026-09-06. Dan: "BUILD ALL OF THESE FULL ANIMATIONS OUT IN PHASES. BREAK IT
DOWN INTO 5-7 PHASES... START PHASE 1 NOW."

The plan is `docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md`; its section
5 is now six build phases, re-cut because the animator the earlier draft
assumed does not exist. Every rig is authored the way the knockout was:
hand-drawn SVG parts, keyframes in `calc(<n>s * var(--animation-speed, 1))`,
timed to the frame against the measured reference, and photographed in a
darkroom before anyone calls it done.

## What a throwable is now

Three files instead of one 3D still and a physics profile:

- a **spec** (`src/throwables/spec.ts`): the beats, in milliseconds from
  LAUNCH, exactly as the reference catalogues record them, so a beat can be
  checked against a frame number without arithmetic;
- a **rig** (`src/throwables/rigs/<id>.tsx` + `.css`): `Projectile` and
  `Payload`, drawn in avatar units in one fixed viewBox, knowing nothing about
  seats;
- the **player** (`src/components/table/ThrowablePlayer.tsx`), which knows
  about seats and nothing about the item.

The player plays the grammar measured over thirty-one PokerBros throws: spawn
on the thrower's face, a STRAIGHT constant-speed flight of a third of a
second, a blink-and-pop landing, then a performance on the target's chair for
about four seconds, drawn over the avatar, cut in one frame. The seven physics
profiles and nine impact profiles are not reimplemented; per ruling 6 there is
no seat flinch and no table shake, so a throw never moves the target's cards,
stack or action badge while a hand is live.

`ThrowAnimationContainer` routes an item with a rig to the player and
everything else to the legacy `ThrowAnimation`, unchanged. The wire format,
the events, the seat map and the completion callback are the same for both, so
a table can show one of each side by side and the 44 unrigged items keep
working until their rigs ship.

## The four rigs, to the measured beats

| item          | reference                     | the performance                                                                                                                                                                                                  |
| ------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beer`        | video 1 THROW 2, launch f349  | mug 1 lands and slides right; MUG 2 pops in on the left at 900; both swing in and CLINK over the forehead at 1567 with a foam plume and ten droplets; ease apart; rest flanking the face; cut 4533               |
| `water_gun`   | video 1 THROW 1, launch f174  | lands aimed at the face, PULLS BACK below-left at 767, SQUIRTS at 933: a cyan stream and a 2 u blob with two white eyes covering the avatar, pulsing every 278 ms for 2.5 s, cut at 3467, gun scales out by 3567 |
| `tomato`      | video 2 THROW 8, launch f1498 | squashes flat at 267, BURSTS at 300 into a 0.85 u splat with chunks thrown 6-10 px, settles by 467, residue to the cut                                                                                           |
| `cracked_egg` | video 2 THROW 1, launch f130  | cracks in ONE frame at 400 into a yolk cap on the crown with whites running to the chin; static residue                                                                                                          |

## The sound: an open-source library, with provenance

`scripts/audio/throwable-cues.manifest.json` is the one place that says where
every shipped cue came from and under what licence;
`scripts/audio/build-throwable-cues.mjs` layers the sources with ffmpeg,
loudness-normalises to -16 LUFS / -1 dBTP, writes Opus (`.webm`) and AAC
(`.m4a`), and generates both `public/sounds/throwables/CREDITS.md` and the
client's `cueManifest.generated.ts`.

Four real cues ship, all **CC0** from Kenney's packs (`pop_soft`,
`glass_clink_rattle` - seven layers rebuilt to the reference's six rattles and
1.3 s ring-down - `drip_tick`, `drip`). Four are declared **placeholders**
that need a Freesound CC0 take in phase 6 and fall back to the legacy
procedural recipe meanwhile. There is no third state: a cue is a licensed file
or a declared placeholder, and `tests/unit/throwableCuesAreLicensed.test.ts`
refuses anything else, refuses a licence not on the allowlist, and ratchets the
placeholder count so it can only fall.

`ThrowableSoundService` gained a sample loader and an AudioContext scheduler
beside its procedural recipes: decode once, cache the buffer, `start()` on the
audio clock at the beat the spec names. Not a `setTimeout` - a main thread
laying out a table drifts a timer by tens of milliseconds, which is the lesson
the knockout's flurry already carries.

## The darkroom, and the bug it caught

`scripts/dev/preview-throwable.mjs` bundles the real rigs with the repo's own
esbuild, renders them with `react-dom/server`, and writes a self-contained
`harness.html` that freezes every animation at the beat its own spec names, on
a mock seat drawn to SeatSlot.css's proportions, at all four
`--seat-avatar-base` rungs. Animations are PAUSED and driven by `currentTime`,
never by sleeping: a sleep-and-shoot harness photographs a different frame on
a loaded machine. If Playwright is available it also screenshots every beat;
41 shots on the first run.

It immediately earned itself twice:

1. **`water_gun` fired every beat 100 ms early.** Its rig counted delays from
   "landing = flight + the 100 ms blink-pop", while the player mounts the
   payload at `flight.ms`. The splat was already gone at its own `loop-end`
   beat. Fixed by shifting the rig's timeline, and pinned two ways: the law
   test requires ONE definition of landing used by both sides, and the specs
   test requires every beat to be reachable before the payload unmounts.
2. **The beer mugs overlapped at the clink** instead of forming the V the
   reference shows. 60 units between two 74-unit mugs is one mug on top of
   another; 76 units, with the 15 degree tilt bringing each rim inward, is
   rims touching and bases apart.

## Verification

`npx tsc --noEmit -p tsconfig.app.json` exits 0. `npx vitest run` over the
seven relevant files - the two new tests, the new law, the law registry, the
existing animation law, the legacy `throwTimeline` and `throwablesIntegrity` -
is **332 passed, 0 failed**, so the migration seam did not disturb a single
existing pin. The darkroom sheet is the visual record and is what the next
review looks at.

## The verification pass, and the two things a seven-file run could not see

Dan, before phase 2: "verify that everything you've built in the previous phase
is 100% fully built, coded, wired in and tested ... make sure that everything
has been fully pushed and published."

It was pushed. **It was not published**, and the seven-file test run above is
exactly why nobody knew: it proved the files I touched were consistent with
each other, which is a different claim from "the repo is green". PR #3347 went
red on `Client Unit Tests` shard 1 four minutes after the push, autopilot
correctly refused to merge it, and the branch sat unmerged with production
still serving `d1ba30dae`. A seven-file subset cannot fail on a repo-wide
ratchet, so **the full `tests/` suite is what the next phase runs before it
claims anything.**

**1. Eight class names that named nothing.** `tests/unit/classNamesResolve.test.ts`
holds a ratchet at 41 unresolved BEM class names and my rigs took it to 47.
`thr-beer__mug`, `thr-beer__plume-core`, `thr-cracked_egg__egg-shape`,
`thr-cracked_egg__whites`, `thr-tomato__calyx`, `thr-tomato__fruit`,
`thr-water_gun__gun` and `thr-water_gun__stream` were on structural `<g>`
elements, referenced once each - in their own file - and defined in no
stylesheet at all. Nothing selected them, nothing styled them, and every one of
those groups is animated by a WRAPPER (`__track`, `__aim`, `__jitter`,
`__live`, `__splat`, `__pulse`) that does have a rule. So no animation was
missing; the names were decoration that read like a contract. Deleted, all
eight. The baseline stays at 41, where it can only fall.

The bidirectional check is worth recording because it is the one that would
have found a real bug: there is no CSS rule in any of the four rigs that no
element carries. A dead RULE would have meant an animation nobody plays.

**2. A cue that made no sound said nothing about it.** `scheduleCues` had three
bare `return`s - the buffer failed to load, a one-shot decoded more than a beat
late, a loop's window was already behind the clock - and none of them throws.
The 404 case is the one that matters: had `public/sounds/throwables/` failed to
reach the origin, every throw would have played in silence and the only
symptom would have been a quiet table. "The audio pipeline is fine" and "every
file is missing" were the same observation, which is CLAUDE.md 10.86 rule 1
almost word for word. Each drop now increments `droppedCues` by reason and
reports `AnimationLaw.throw_cue_silent` **once per reason per cue per session**,
so eight simultaneous throws cannot spam the same broken URL. Pinned by a new
case in the law.

**What the pass confirmed rather than changed**, each read rather than assumed:

- `tomato` and `cracked_egg` (the two rigs a subagent drew) hold the same
  landing contract `water_gun` had violated: tomato's delays count from 233 and
  cracked_egg's from 367, and both equal their own `flight.ms`.
- The four catalogue ids the rigs claim - `beer`, `water_gun`, `tomato`,
  `cracked_egg` - are the ids `ThrowableService` resolves to, `LEGACY_ID_MAP`
  included (`egg`, `water-balloon`, `tsunami` all bridge onto rigged items), so
  no throw silently falls through the seam to the legacy renderer.
- The audio survives the build **byte for byte**: `RASTER_RE` is
  `/\.(png|jpe?g|webp)$/i`, and `.webm` is not `.webp`, so
  `optimize-dist-media.mjs` never opens them. A real `npm run build` put all
  nine files in `dist/sounds/throwables/` with matching sha256.
- Reduced motion is handled and not merely survived: the player starts at the
  payload phase, offsets the cues to 0, and marks the payload
  `data-motion="keep"` so `reducedMotion.css` does not collapse the beats that
  ARE the throw.
- No TODO, FIXME, `@ts-ignore`, `as any` or empty catch anywhere in the phase 1
  tree; every catch that exists has a stated reason.

One local-environment finding worth writing down so the next agent does not
chase it: `tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts`
fails in a fresh WORKTREE with `Failed to resolve import "sharp"`. `sharp` is a
declared devDependency (CLAUDE.md 1.1.6) and CI's `npm ci` has it; a worktree
whose `node_modules` predates that entry does not. It is not a code defect, and
CI never showed it because that file was in the shard autopilot cancelled.

## Honest gaps

1. **Never seen on a real table.** Every judgement here came from the darkroom
   against a mock felt, exactly as the knockout's first pass did.
2. **Four cues are placeholders**, so those beats currently play the old
   procedural recipe. Counted, tested and ratcheted; phase 6 replaces them.
3. **No performance measurement yet.** The knockout was measured at eight
   simultaneous animations; phase 6 does the same for eight throws on a 375 px
   device.
4. **The tomato's burst has a 4 ms handover** where the squash has faded and
   the splat has not yet appeared. Invisible at 30 fps, visible if you freeze
   exactly on 300 ms, which the darkroom does. Left as is and recorded here.

## Files

```
added    src/throwables/spec.ts, rig.ts, registry.ts, cues.ts
added    src/throwables/cueManifest.generated.ts (generated)
added    src/throwables/rigs/{beer,water_gun,tomato,cracked_egg}.{tsx,css}
added    src/components/table/ThrowablePlayer.tsx + .css
added    scripts/audio/throwable-cues.manifest.json, build-throwable-cues.mjs
added    scripts/dev/preview-throwable.mjs
added    public/sounds/throwables/*.webm + *.m4a + CREDITS.md
added    tests/unit/throwableSpecs.test.ts, tests/unit/throwableCuesAreLicensed.test.ts
added    tests/throwables-play-the-measured-grammar.law.test.ts + docs/laws.d entry
changed  src/services/ThrowableSoundService.ts (sample loader + scheduler;
         then the verification pass added droppedCues + dropCue reporting)
changed  src/components/table/ThrowAnimation.tsx (the migration seam)
changed  docs/throwables/THROWABLES-PREMIUM-ANIMATION-PLAN.md (section 5 re-cut)

verification pass (same branch, PR #3347):
changed  src/throwables/rigs/{beer,water_gun,tomato,cracked_egg}.tsx
         (eight class names that resolved to no stylesheet, deleted)
changed  tests/throwables-play-the-measured-grammar.law.test.ts
         (a cue that produces no sound must name a reason)
```
