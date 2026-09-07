# The verification pass before phase 2's third landing: a beat that photographs empty, and 22 names that drew nothing

2026-09-07. Dan, before the next items: "verify that everything you've built in
the previous phase is 100% fully built, coded, wired in and tested ... make sure
that everything has been fully pushed and published."

**Landings 1 and 2 are merged AND published.** PR #3381 merged as `766e9342a5`;
production's `build-info.json` reports `ca_sha` `766e9342a5`, byte-identical to
`main`'s HEAD. Every one of the seven rig files is on `main`, and fifteen cue
URLs were fetched from `smarter.poker` and checked: all 200, all
**byte-identical to the repo**, none silent. That is the whole audio path -
source pack, build, merge, publish, CDN, bytes on the wire - verified rather
than assumed.

Then the audit found three things, and two of them were in code that has been
live since yesterday.

## 1. A beat that photographs as an empty seat

The darkroom froze `tomato` at 300, its own `burst` beat, and got a bare
avatar. The splat is the entire item.

The cause is one line of CSS semantics. **`animation-fill-mode: both` fills the
DELAY with the 0% keyframe.** So a delayed animation whose 0% is hidden is
invisible while it waits - correct - and then still invisible on the very frame
it is meant to appear. Phase 1 shipped seven of these across `beer` and
`tomato`: splat, stem, drip, chunk, mug 2, plume, droplet.

In playback it is four milliseconds late and nobody will ever see it. That is
not why it matters. **The darkroom freezes exactly on the beat, so every one of
those beats photographed empty** - and the darkroom is the instrument this
programme uses to verify itself. Two genuine bugs (fireworks drawing nothing at
all eleven of its beats; champagne's cork and jet missing) were nearly lost in
exactly that noise, and I had already talked myself out of one of them once.

Fixed to the idiom the seven newer rigs use: a delayed animation is `forwards`
with a VISIBLE 0% frame, so the element sits on its own `opacity: 0` while it
waits and opens on the beat. `both` is now only for elements already on screen
when their animation starts.

## 2. Twenty-two class names that drew nothing

Every rig carried `thr-<id>--proj` / `thr-<id>--payload` on its `<svg>` root,
and eleven carried a bare `thr-<id>` as well. No stylesheet defined the
modifiers, nothing selected them, and the player already does both jobs: it
sizes every child `svg` through `.thr__proj svg, .thr__payload svg`, and it
stamps `data-throwable` on its own wrapper for identification. Twenty-two dead
names, plus seven per-rig sizing rules that duplicated the player's.

Phase 1 found eight names like this by hand. **The reason a second crop grew is
that `classNamesResolve` only reads SINGLE-class attributes** - its regex is
`className="one-name"`, so `className="thr-beer thr-beer--proj"` was invisible
to it. All of them are gone now, and the root cause is closed rather than the
instance: the throwables law now checks every class a rig writes, multi-class
included, **and the reverse** - a CSS rule nothing wears, which is the more
dangerous direction, because that is an animation nobody plays.

## 3. What the audit confirmed rather than changed

Written down because "we checked" is worth nothing without the list:

- **No rig schedules anything after its own payload unmounts.** All eleven
  checked mechanically: last beat equals its life exactly, and no CSS delay or
  `loopUntil` runs past it. This is the champagne-flute bug from the last pass,
  now proven absent everywhere.
- **All 26 cues reach `dist` byte-identical** - 52 files, both containers.
- **All eleven rig ids are real catalogue ids**, so no throw falls through the
  seam to the legacy renderer.
- Every SVG def id is uid-scoped; no cue fires after its payload is gone; no
  TODO, FIXME, `@ts-ignore` or `as any` anywhere in the tree.
- `tsc` exits 0, `npm run build` succeeds, and the FULL suite is green.

## A note on method

Two things in the last pass LOOKED like defects at contact-sheet size and were
not - the horseshoe's label really is on screen at 1467, at `scale(0.12)`, and
the snowman's nose is behind the plume at 534 and at the chin by 767. Both were
settled by zooming. **A 260 px tile is enough to notice something, never enough
to conclude it.** The three findings above were all confirmed in code before
anything was changed.

## Files

```
changed  src/throwables/rigs/{beer,tomato}.css (7 delayed animations: both -> forwards, visible 0%)
changed  src/throwables/rigs/*.tsx (22 dead class names removed, all 11 rigs)
changed  src/throwables/rigs/*.css (7 redundant root sizing rules removed)
changed  tests/throwables-play-the-measured-grammar.law.test.ts
         (+3 cases: every class has a rule, every rule is worn, nothing is
          invisible on its own beat)
```
