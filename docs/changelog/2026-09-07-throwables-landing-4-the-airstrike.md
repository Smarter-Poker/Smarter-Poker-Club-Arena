# Landing 4: the airstrike, the bomb, the poop - and a field that was never read

2026-09-07. The last three of the fourteen reference objects: **poop, bomb,
rocket**. The registry is **eighteen rigs**, and every object in the PokerBros
reference now plays through the measured player.

Seven new cues, taking the library to **44, zero placeholders**.

---

## The three

**rocket** (video 2, Throw 3) is the most complex rig in the set - a
**three-stage** performance where the thing that flies is not the thing that
hits:

1. a red **crosshair reticle** is the projectile. It flies straight in 333 ms,
   lands on the face and **HUNTS** - a slow left-right sweep of about +-5 px,
   roughly one sweep per 833 ms, for 1.3 seconds;
2. it **locks** at 1633, scaling to 2x then 3.5x as it fades, gone at 1833.
   Then **400 ms of nothing at all** - the reference's own 13-frame pause, kept
   deliberately, with the missile whistle already playing under it;
3. the **missile** dives in from the top edge at 2267, tiny and nose-down,
   growing 4 -> 14 px with an exhaust flame trailing up from the tail. Hit at
   2567 with a dull red glow behind it, flame at 2633, **full fireball** at 2733
   (1.3x avatar, 50 px above the head, avatar hidden), orange with ember
   blotches at 2867, a khaki **mushroom cloud** 3033-3667, and a one-frame pop
   out to a clean seat at 3733.

**bomb** (Throw 12) is the only item that **lands and waits**. It sticks to the
forehead at 267 and burns a 1.2-second fuse - the spark flickering between 3 and
7 px every single frame, the fuse visibly shortening - then a pre-flash inside
the sphere at 1433, a jagged yellow-orange burst at 1467, and a khaki smoke puff
that thins and drifts up-left to a clean seat at 1833. No residue.

**poop** (Throw 7) is the classic splat: contact intact at 367, the swirl
replaced at 400 by a brown-orange splat with radial spikes plus one droplet
fired straight up 30 px above the head, three or four droplets flying out and
hanging by 867, and a static residue - the swirl inside a splash ring, 70% of
the face - to the cut.

### The seven cues

`lock_beep`, `lock_confirm`, `missile_whistle`, `explosion_boom`,
`fuse_ignite`, `fuse_sizzle`, `boom`. Every one is timed to the reference's own
measured audio frames, not to the visual beats: the lock beeps at 567 / 1100 /
1633 are f463 / f479 / f495, spaced exactly 16 frames; the confirm pair at
1700 / 1867 is f497 / f502; the whistle starts at 2100, **five frames before the
missile is visible**, which is the whole point of it.

`explosion_boom` is the loudest cue in the library (peak -1.1 dBFS, the
reference's own peak is rel 57%); `fuse_sizzle` is the quietest (-16.9), and it
**crescendos** rather than holding, because in the reference the sizzle is what
tells you the bomb is about to go.

## The bug the darkroom caught

The bomb's sphere ramped `opacity: 1 -> 0` across the **whole** fuse phase, so
by the pre-flash it was about 3% opaque: the 1433 frame photographed as a bare
avatar with a spark floating over it, when the reference is explicit that the
sphere is **static** for the full 1.2 s and only leaves when the burst replaces
it. Its own siblings - the fuse and the spark - already held correctly to
97.17% and cut in one frame; only the body was missing that stop.

Nothing else could have found it. Every law passed: the classes resolve, the
percentages match their comments, nothing outlives the payload, the appear idiom
is correct. A slow fade to nothing is not a rule violation - it is just the
wrong picture, and the only witness is a picture.

## The floor was derived from the wrong quantity, twice

`THROWABLE_GRAMMAR.payloadMs.min` was 1800, then 1600, and it is **1566** now.
Both previous values were read off the plan's life table - which measures
**SPAWN TO CLEAN** - while the bound governs **LANDING TO CLEAN**. The two
differ by spawn plus flight, and for the shortest items that is most of the
number.

The bomb is the worked example. The life table says 2.0 s. Its payload is 1566,
because 167 ms of spawn and 267 ms of flight happen before the payload exists at
all: 2000 - 434 = 1566, exactly.

The subagent that built the rig hit the 1600 floor and clamped the SPEC up to
it. That is the wrong side to move: **the spec is measured and the bound is
not.** So the floor came down instead, and it is no longer a judgement - a new
law asserts it EQUALS the smallest `payload.ms` in the registry, so it cannot
drift from the data again. A shorter item turns the law red and the bound has to
be re-derived deliberately rather than nudged until the newest rig fits.

## `sizeU` was never read by anything

Every one of the eighteen rigs declares `payload.sizeU`, carefully, from the
reference. Its doc comment said "width of the payload's own box in avatar
widths".

**Nothing reads it.** `ThrowablePlayer.css` gives every payload the same box,
`calc(var(--thr-u) * 3)`, and every rig draws into the same
`-150 -150 300 300` viewBox - so 100 units is one avatar width in every rig
whatever `sizeU` says, and changing it changes nothing on screen.

That is worse than a dead field, because the comment made it read as
configuration: an author sizing artwork "to sizeU" would be sizing against a
number that does nothing. The comment now says what is true, and a law pins the
two halves that ARE real - the box's `* 3` and the viewBox - so that wiring
`sizeU` up, which would silently rescale all eighteen rigs at once, has to be a
deliberate act that moves the law with it.

## ffmpeg, for whoever hits it next

The Mac's ffmpeg is broken - `Library not loaded: libx265.215.dylib`, because
Homebrew's x265 moved to 4.2 (`libx265.216`) while ffmpeg 8.0.1 is linked
against 215. The Linux sandbox that was used as the workaround last time is
wedged (`useradd: input/output error`).

**x265 4.1 is still in the Cellar**, so the cue build runs against it with no
change to anything installed:

```sh
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/Cellar/x265/4.1/lib \
  /opt/homebrew/Cellar/ffmpeg/8.0.1_1/bin/ffmpeg ...
```

macOS strips `DYLD_*` through `nohup` and other protected binaries, so that has
to be set by a shim on PATH rather than exported in the shell. Nothing on the
machine was modified.

## One more thing the tests caught

Building only the new cues (`--only`) regenerates `CREDITS.md` from just those
cues, silently dropping the other 37. `throwableCuesAreLicensed.test.ts` failed
on `boing_splat is not credited` within seconds. The full build was re-run. The
lesson is small but real: **`--only` is a build flag, not a publish flag.**

## Verified

- `npx tsc --noEmit` clean.
- `npx vitest run tests/` - **15,658 tests, all passing.**
- Production build green.
- Darkroom: all eighteen rigs, every beat photographed at its own millisecond.
  The rocket's ten beats, the bomb's six and the poop's seven were reviewed by
  eye; the bomb was re-shot after its fix and now shows the solid sphere with
  the cracks glowing inside it at 1433.
- 44 cues, 0 placeholders, every one above the -30 dBFS floor.

## What is left in the programme

Phase 2 is DONE - all fourteen reference objects. Remaining: the character and
emoticon rigs (phase 3, 21 items), our own seventeen items with no reference
twin plus deleting the legacy engine (phase 4), entitlement / store / 12 new
items (phase 5), and the full sound library and device verification (phase 6).

Two things only Dan can supply, neither blocking: a ten-second voice reference
clip for `voice_good_luck` (the horseshoe's spoken line, currently not in the
set) and a Freesound API key.
