# Throwables phase 2, first landing: three reference objects, and cues we can make ourselves

2026-09-06. Dan: "PROCEED TO THE NEXT PHASE."

Phase 2 is the fourteen remaining reference objects (plan section 5). This is
the first of its landings: **fireworks, champagne and rose**, plus the piece of
the sound pipeline that unblocks the other eleven. The plan asks for batches;
this is the batch that also had to build the machinery, so it is three rather
than four.

## What shipped

| item        | reference                      | the performance                                                                                                                                                                                                                      |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fireworks` | video 1 THROW 3, launch f564   | NOTHING at the thrower; two waves burst AT the seat. Blue at 233, magenta at 567, yellow into embers 1033-1767, a nine-frame gap, then three rockets rise together and burst together at 2333 across 2.4 u; darken and clean at 3000 |
| `champagne` | video 1 THROW 9, launch f2020  | bottle stands; CORK POP 800; foam jet 933-1600 with side spray; the jet detaches into a rising thread; the bottle DISSOLVES into one flute at 2300; a second fades in left at 2700; V-tilt and CLINK 3167; flank the face; fade 4700 |
| `rose`      | video 2 THROW 13, launch f2511 | the rose vanishes for four frames; a bud appears behind the right ear at 500 and blooms by 667; a butterfly flutters above from 867 with its wings on a 67 ms step; a lipstick kiss at 1467 grows, then walks down to the chin       |

`fireworks` is the first item in the whole set with `spawn: 'none'` and
`flight.mode: 'none'`. `throwableLandingMs` returns 0 for it, so its landing IS
zero and every delay in its stylesheet is the catalogue's ms from launch with
nothing subtracted. The reference proves nothing leaves the thrower with a 3x
zoom on the hero seat, and the rig draws nothing there.

## The sound: a fourth licence, because three cues do not exist in any CC0 pack

Nine new cues, and six of them are Kenney CC0 layered to the reference's own
spacing - `fw_crackle` is six impacts at the measured 130-170 ms bang interval,
`fw_barrage` is eight with a rumble under the opening, `harp_sparkle` is a six
note run under the butterfly, `flute_clink` is brighter and shorter than the
beer mugs' six-rattle chime because a flute rings once and cleanly.

**Three of them are not in any sample library we can use**: a rising firework
whistle, a low rumble, and a champagne fizz bed. Freesound's CC0 filter needs
an API key nobody has supplied yet, and the Sonniss GDC bundles are multi-
gigabyte torrents. So the build script gained a `synth` source kind: a layer
may carry an ffmpeg `lavfi` expression instead of a file, and

- `fw_whistle` is a quadratic chirp 900 Hz to about 5.4 kHz with a breath of
  air noise under it, which is the measured 5.3-5.6 kHz centroid;
- `fw_rumble` is brown noise under 220 Hz;
- `fizz_loop` is white noise band-limited to 2.6-9.5 kHz with a slow tremolo.

They ship under a new licence string, **`Own-Synthesis`**, and it is a
different claim from `Own-Recording` on purpose: nothing was recorded, an
expression in the manifest generates the file, and **that expression is the
provenance**. A synth source therefore has no URL and must instead carry a
`recipe`; the licence test was updated in the same commit to demand exactly
that, and to refuse a synth layer that names a file or a file layer that names
an expression. The placeholder ratchet is untouched at four.

## The darkroom, and the three bugs it caught

`scripts/dev/preview-throwable.mjs` froze all three rigs at every beat their own
specs name, at all four seat rungs, before any of this was called finished. It
found three, and the first two are the same mistake one level apart:

1. **Fireworks rendered NOTHING at any of its eleven beats.** A blanket
   `.thr-fireworks--payload > g { opacity: 0 }` was hiding the children, on the
   theory that each would switch itself on. It cannot: every animated class in
   that rig sits on an INNER group inside a positioning `<g transform>`, so the
   blanket pinned the PARENT at zero and nothing could show through it.

2. **Removing it and switching to `both` moved the bug rather than fixing it.**
   `animation-fill-mode: both` fills the delay with the 0% frame, so an element
   whose 0% is hidden is correctly invisible while it waits AND still invisible
   on the very frame it is supposed to appear. The darkroom photographed exactly
   that: no burst at 233, no cork at 800, no jet at 933, no bloom at 567, no
   kiss at 1467. The reference opens burst 1 as a 4 px dot AT 233.

   The idiom is now written at the top of all three stylesheets: an element
   that APPEARS at a beat carries `opacity: 0` in its own rule, runs
   `forwards`, and its 0% frame is the VISIBLE open frame. `forwards` leaves it
   on its own style while it waits and plays a frame that is already on screen.

3. **The champagne flutes overlapped at the clink** - the same shape as phase
   1's beer mugs. Flute 2 stood at -0.30 u, which put it almost entirely behind
   flute 1; the clink frame photographed as one glass. It stands at -0.55 u
   now, and the V tilt went 15 to 18 degrees, so the rims meet and the bases
   are apart.

There is a fourth, and it is mine rather than the code's: a scripted regex
rewrite of all three stylesheets to apply fix 2 in bulk matched inside comments
and inside the reduced-motion blocks and left every file with unbalanced
braces. They were rewritten by hand. **Regex over CSS with comments in it is
the wrong tool, and a brace count is the cheapest way to find out.**

## Verification

`npx tsc --noEmit -p tsconfig.app.json` exits 0. The specs test, the cue
licence test, the grammar law, the class-name ratchet and the animation law all
pass, and the FULL `tests/` suite is green. The darkroom's 43 shots are the
visual record: fireworks opens as a dot and fills to a cloud, the champagne
bottle dissolves into two flutes that meet at the rim, the rose puts a bud
behind the ear and walks a kiss down to the chin.

## The verification pass, and the fourth source

Dan, before phase 3: "verify that everything you've built in the previous phase
is 100% fully built, coded, wired in and tested ... GO AHEAD AND FIND A 4TH
OPEN SOURCE OR FREE LICENSE TO FINISH UP THE SOUND EFFECTS."

**It was pushed and it was NOT published, and the reason is the one CLAUDE.md
10.82 is about.** Phase 2 was branched off the phase-1 BRANCH rather than off
`main`, because phase 1 had not merged yet. Phase 1 then landed as a SQUASH,
which is a new commit that is not an ancestor of anything phase 2 knows about,
so every phase-1 file came back as an add/add conflict: PR #3381 sat at
`mergeable_state: dirty` for four hours, CI never started, and autopilot could
not touch it. Resolved by merging `origin/main` in and taking ours on all ten
conflicts - proven safe first, by diffing each file both ways and confirming
that every line unique to `main` was the OLD version of a line this branch had
deliberately replaced. **Stacking on an unmerged branch buys nothing and costs
a merge conflict per file; the next landing branches off `main`.**

### Three defects in the audio, one of them shipped silent

1. **`flute_clink_soft` peaked at -36 dBFS** while every other cue sat between
   -1.8 and -19.2. Its source peaks at -0.8, so nothing was wrong with the
   sample: **`loudnorm` was the wrong tool for this whole library.** EBU R128
   integrated loudness is defined over 400 ms blocks with gating and needs
   SECONDS of programme; every cue here is a one-shot under three. With nothing
   to measure it runs in dynamic mode, rides the level as it goes, and ducked a
   short transient surrounded by silence by thirty decibels.

   Fixed at the root rather than nudged: the builder now measures the assembled
   mix and applies ONE static gain to the true-peak target, offset by the cue's
   own `levelDb`. The dynamics between cues are something the manifest STATES -
   the cork pop is the loudest thing in the library at 0, the drips sit 12-14 dB
   down - instead of whatever a gate happened to do.

2. **Nothing would have caught it.** Every check there was asked whether the
   FILE exists and is over 256 bytes, and a silent file is both. The builder now
   refuses to write a cue peaking below -30 dBFS, and refuses one whose level it
   cannot measure at all - "I could not tell" is not "fine" (10.86 rule 1). The
   floor is derived, not guessed: the good cues clear it by 11 dB and the defect
   missed it by 6.

3. **`alimiter` auto-levels to its own ceiling by default**, which dragged every
   cue back up and undid the offsets. It is `level=disabled` now: a ceiling,
   never a gain.

### The fourth source: OpenGameArt, and why it needs no fourth licence

Six CC0 packs by **rubberduck** on OpenGameArt, each verified on its own
submission page before anything was downloaded - water/splash/slime, mud,
wood+metal, SFX loops, sci-fi and RPG. Every page carries exactly one CC0 link
and zero CC-BY links.

**No new licence string was needed, and adding one would have been ceremony.**
OpenGameArt is a fourth SOURCE, not a fourth licence: these packs are CC0-1.0,
which the allowlist has permitted since phase 1. The one thing OGA does that
Kenney does not is host several licences side by side, so the fetcher re-reads
the submission page every time and **refuses to download a pack whose page has
stopped saying CC0 or has started also saying CC-BY** - an attribution
obligation is not something to take on by accident.

The immediate win: **the placeholder count is now ZERO.** `squirt_start`,
`squirt_loop`, `splat_wet` and `egg_crack` had been falling back to the legacy
procedural recipes since phase 1; they are real licensed files now, and the
ratchet in the test is lowered to 0 in the same commit, as its own rule
requires. Nothing in the library is a stand-in any more.

### And one more from the darkroom

**At the 4700 cut, champagne's second flute was still standing at full
opacity.** It had been given flute 1's 2.4 s duration on its own later 2.5 s
delay, so its timeline ran to 5100 while the player unmounts the payload at 4700. Its duration is 2.0 s now and both flutes are gone on the same frame. The
seat is clean at the cut, which is what the reference does.

### What the pass confirmed rather than changed

- All 17 cues contain real audio - every one measured, peaks -0.7 to -16.5 dBFS,
  none silent.
- All 17 ship both containers; no spec names a cue that does not exist.
- The three new rig ids resolve on the wire, and each has exactly one registry
  entry.
- No TODO, FIXME, `@ts-ignore` or `as any` anywhere in the phase-2 tree.
- Every new stylesheet carries its reduced-motion block.
- `tsc` exits 0 and the FULL suite is **1110 files, 0 failed**.

## Honest gaps

1. **Eleven of the fourteen are not built yet**: horseshoe (with the GOOD LUCK
   label and the one recorded voice line), trash_can, dice, snowman, trophy,
   cake, banana_peel, cash_stack, poop, bomb and rocket. Their cue names are
   fixed in `docs/throwables/PHASE2-RIG-CONTRACT.md` so the audio and the rigs
   can be built in either order.
2. **Still never seen on a real table.** Every judgement here came from the
   darkroom against a mock felt, as phase 1's did.
3. **The rose's ear bloom sits a little high** - the reference tucks it behind
   the ear and this reads as just above it at the smallest rung. It is drawn
   from the measured offset, so this is a drawing judgement rather than a
   timing error, and it is worth a second look with the item in front of you.
4. **The synthesised cues have not been listened to on a phone speaker.** They
   are correct by construction and normalised with everything else; phase 6's
   device pass is where they get judged by ear.

## Files

```
added    src/throwables/rigs/{fireworks,champagne,rose}.{tsx,css}
added    docs/throwables/PHASE2-RIG-CONTRACT.md (the contract every rig is built to)
added    public/sounds/throwables/{cork_pop,fizz_loop,flute_clink,flute_clink_soft,
         fw_whistle,fw_crackle,fw_rumble,fw_barrage,harp_sparkle}.{webm,m4a}
changed  scripts/audio/build-throwable-cues.mjs (the `synth` source kind)
changed  scripts/audio/throwable-cues.manifest.json (nine cues, one new source)
changed  src/throwables/registry.ts (three rigs wired in)
changed  tests/unit/throwableCuesAreLicensed.test.ts (Own-Synthesis, and a
         synth source must carry a recipe rather than a URL)
```
