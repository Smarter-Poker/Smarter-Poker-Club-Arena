# Phase 2 rig contract (throwables) - READ ALL OF THIS BEFORE WRITING A LINE

Worktree: `/Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-throwables-2`
Everything below is relative to that directory. Do NOT touch any other worktree.

## What you are building

One `src/throwables/rigs/<id>.tsx` + `<id>.css` per item, exactly the way the
four phase-1 rigs are built. **Read all four first** - they are the pattern and
they are correct:

- `src/throwables/rigs/beer.tsx` / `.css` (two-object choreography, droplets)
- `src/throwables/rigs/water_gun.tsx` / `.css` (a loop, a stream, a pulse)
- `src/throwables/rigs/tomato.tsx` / `.css` (squash -> burst -> residue)
- `src/throwables/rigs/cracked_egg.tsx` / `.css` (a one-frame hard cut)

Also read, in this order:

1. `src/throwables/spec.ts` - the ThrowableSpec type and THROWABLE_GRAMMAR bounds.
2. `src/throwables/rig.ts` - RIG_VIEWBOX, RigProps, ThrowableRig.
3. `src/components/table/ThrowablePlayer.tsx` - what the player does for you.
4. `tests/unit/throwableSpecs.test.ts` - every rule your spec must satisfy.
5. `tests/throwables-play-the-measured-grammar.law.test.ts` - the law.

## THE RULES. Each one is a bug that already happened.

1. **LANDING IS `flight.ms`.** Every `animation-delay` in your CSS counts from
   LANDING, and landing == `spec.flight.ms` == the catalogue's "ms from launch"
   minus nothing else. The player mounts the Payload at `flight.ms`. water_gun
   shipped counting from "flight + the 100 ms blink-pop" and every beat fired
   100 ms early. Put the catalogue ms AND the delay in the comment on each rule,
   as the phase-1 CSS files do.

2. **EVERY duration and delay is `calc(<n>s * var(--animation-speed, 1))`.**
   No bare `0.3s` anywhere, including inline `animationDelay` styles. CLAUDE.md
   10.6 is the law; `animations-always-play.law.test.ts` and the specs test
   both check it.

3. **Every beat in `spec.beats` must be REACHABLE** - i.e. `<= flight.ms +
payload.ms` (the specs test enforces this). If your last beat is a "cut",
   `payload.ms` must reach it.

4. **SVG defs are scoped by `uid`.** Every gradient/clip/filter id is
   `` `thr-<id>-<name>-${uid}` `` (add a `k` discriminator when one sub-component
   is rendered more than once, as `Mug` does). Four of these mount at once in a
   multi-table view; a bare `id="grad"` makes them fight.

5. **Approved premium raster artwork is permitted**, per Dan's subsequent
   explicit art-direction request. Use local versioned atlases via AtlasSprite
   with reviewed source rectangles. No remote/data URLs for effect art or emoji
   substitutes. The specified anvil/ghost/UFO/lightning avatar-copy gags may reuse
   only the target's already-visible avatar (including a safe canvas snapshot),
   scoped to that table; they never mutate the seat or introduce a substitute identity.
   The timing, reduced-motion, instance isolation and overlay rules still apply.

6. **No `will-change`.** No `filter: blur()` on anything that animates every
   frame (a blurred 2 u box on eight simultaneous throws is the phase-6
   performance budget). A static `feGaussianBlur` on a small glow is fine.

7. **The rig never moves the seat.** No transform on anything outside your own
   SVG; no class named `*flinch*` or `*shake*`. Ruling 6.

8. **A `@media (prefers-reduced-motion: reduce)` block at the bottom of every
   CSS file** that leaves the item in its MEANINGFUL final state - the splat
   present, the residue drawn, the caption readable - with `animation: none
!important` and the final transform/opacity applied. Copy tomato.css's
   block for the shape. Motion goes; meaning never does.

9. **Fixed values, never random.** Droplet/chunk/particle arrays are literal
   tables in the .tsx (see beer's `DROPLETS`), so the darkroom photographs the
   same frame twice.

10. **`preloadThrowableCues(<spec>.audio.map((c) => c.sample));`** immediately
    after the spec, exactly as the phase-1 rigs do.

11. **Every className you write must have a CSS rule.** A class that resolves to
    no stylesheet fails `tests/unit/classNamesResolve.test.ts`, which holds a
    repo-wide ratchet at 41 and went red on phase 1 for exactly this. If a group
    needs no styling, give it no class and use an SVG comment instead.

## Units

`RIG_VIEWBOX` is `-150 -150 300 300` and **100 units = 1 avatar width (1 u)**.
The reference measurements are in pixels on a 30 px avatar (video 1) or a 40 px
avatar (video 2); the reference doc says which. Convert: video 1 `units = px *
100/30 = px * 3.333`; video 2 `units = px * 100/40 = px * 2.5`. Put the
conversion in the file header like the phase-1 rigs do.

## The spec shape

Copy `beerSpec` and change the values. `tier` and `category` come from the plan's
build sheet line for your item. `reference: { video, launchFrame, throw }` is
required and must match the reference doc.

## Registering

Add your rig to `src/throwables/registry.ts` following the existing four
(import, then one entry). Keep the list alphabetical.

## Cue names - USE EXACTLY THESE, do not invent new ones

The cue files are being built in parallel by another agent from
`scripts/audio/throwable-cues.manifest.json`. Your spec's `audio[].sample` must
be one of the names in the table for your item below. If you believe your item
needs a cue that is not listed, STOP and say so in your final message rather
than inventing a name - a spec naming an unknown cue fails
`throwableCuesAreLicensed.test.ts`.

| item        | cues (in the order the build sheet gives them)                 |
| ----------- | -------------------------------------------------------------- |
| fireworks   | fw_whistle, fw_crackle, fw_rumble, fw_barrage                  |
| horseshoe   | tick_land, horseshoe_clank (NO voice cue - see below)          |
| trash_can   | card_slap, bubble_tick, can_rattle_rise, lid_clank, flies_buzz |
| dice        | dice_rattle                                                    |
| champagne   | cork_pop, fizz_loop, flute_clink, flute_clink_soft             |
| snowman     | poof_soft                                                      |
| trophy      | swell_low, chime_shimmer, fanfare_short, sparkle_bed           |
| cake        | whoosh_low, splat_heavy, splat_wet_small                       |
| banana_peel | boing_splat                                                    |
| cash_stack  | thump_soft, tick_settle, cash_register_cascade                 |
| poop        | splat_wet                                                      |
| bomb        | fuse_ignite, fuse_sizzle, boom                                 |
| rose        | harp_sparkle                                                   |
| rocket      | lock_beep, lock_confirm, missile_whistle, explosion_boom       |

**The airstrike's item id is `rocket`, not `missile`.** `missile` is what the
reference video calls it and what the plan's prose calls it; the catalogue id
the wire actually carries is `rocket` (`ThrowableService.ts`, tier premium).
The rig file is `rocket.tsx`. Getting this wrong means the rig never fires and
nothing says so.

A cue that runs for a span (a loop, a bed, a sizzle) uses `loopUntil`.

**`voice_good_luck` does not exist and must not be named.** The build sheet
wants a recorded male "Good luck" about 300 ms after the horseshoe's label
settles, and it is one of only two spoken lines in the whole set. No CC0 pack
has that phrase, and the placeholder ratchet is now at ZERO - every cue in the
library is a real licensed file, and a rig may not put it back to one. So the
horseshoe ships with `tick_land` and `horseshoe_clank` only; the CAPTION
carries the meaning until Dan supplies the voice clip (plan 3.3.1, phase 6).
Do not invent a cue name for it and do not declare a placeholder.

## Sound timing note from the reference

The captured audio is 170-370 ms LATER than the visual beat it belongs to. That
is recording latency, not design. **Schedule every cue on the VISUAL beat.**

## When you are done

- `npx tsc --noEmit -p tsconfig.app.json` must exit 0.
- `npx vitest run tests/unit/throwableSpecs.test.ts tests/unit/classNamesResolve.test.ts tests/throwables-play-the-measured-grammar.law.test.ts`
  must pass (the cue test will fail until the audio agent lands the manifest -
  that is expected and not yours).
- Report, per item: the beats you implemented, anything in the reference you
  could NOT represent and why, and any number you had to choose rather than read.

Node is not on the default PATH. Prefix commands with:
`export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`
