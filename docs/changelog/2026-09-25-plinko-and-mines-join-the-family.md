# 2026-09-25: Plinko and Diamond Mines join the family

Owner, on the bonus games: "the graphics are very crude, basic and boring,
instead of dynamic, and high def." Crash and Donkey Cross were rebuilt this week
in the house style: black glass, chrome hairlines, blue LEDs, gold for money,
lit sign plates. This change (mobile spins programme, phase 4 of 7) brings
Diamond Plinko and Diamond Mines into the same family, so the four bonus games
read as one set. No rule, payout, prize, timing contract or player-facing copy
changes.

## Diamond Plinko

- **The cabinet.** A black-glass back panel on an obsidian casing, framed by a
  chrome bevel, with a blue LED strip down each side and a blue LED in each
  corner. A sign plate across the top reads DIAMOND PLINKO in chrome lettering
  on black glass. A glass sill runs under the buckets with its own blue LED
  line, and a soft blue underglow sits under the whole machine (in the scene
  and, as a box shadow, on the page below the canvas).
- **Chrome studs.** Every peg is a machined chrome stud (a lathe-turned dome on
  a stem) with a specular highlight, still drawn as one instanced mesh for the
  field and one for the lit pegs.
- **The light chase.** While the board waits for a drop, a band of blue light
  runs down the peg rows and the side LEDs breathe. A peg a diamond strikes
  flares and fades. Under reduced motion the pegs and LEDs rest lit.
- **Lit sign plates for the buckets.** Each bucket is a plate of black glass in
  a chrome bezel with its multiplier engraved in its own tint (`bucketTint` and
  `bucketInk`, navy through blue to chrome and gold). The 5x-or-better buckets
  keep a warm gold pool on the sill. The hit squash, the flash, the big-win
  ring, every `data-*` attribute and the legend copy are unchanged.
- **A sparkle trail.** Every falling diamond carries a light-blue glow and
  leaves a short trail of twinkling sparkles. The scatter is a seeded hash, not
  `Math.random`.
- **Cheaper, not dearer.** The point light that followed the diamond was a
  fourth real-time light; it is now a sprite glow. Every glow on the machine is
  one instanced additive draw and every sparkle one more, nothing is allocated
  per frame, and the two canvas textures are painted once (the title once more
  when the web font arrives). The scene uses the Phase 1 quality governor and
  compile warm-up in `sceneKit.ts` as they are.

## Diamond Mines

- **The board.** The diamond is now a plate of black glass with a faint diamond
  lattice in it, a chrome hairline and a two-step chrome bevel, a blue LED in
  each of its four corners and a soft blue underglow under it. The tiles sit a
  little inside the rim so the chrome and the LEDs show round them; every tile
  is still well over the 44px floor at 320px.
- **The tiles.** Each tile is a machined block of black glass: a chrome
  hairline, a lit top bevel, a dark lower cavity and two steps of machined side.
  A tile the finger is on, or the keyboard has reached, lights a blue LED edge.
  A found gem glows light blue and twinkles. The mine that ends a round flashes
  bust red once and rests with a red edge and halo; the other mines rest with a
  red edge. The flip and the cascade are kept.
- **The art.** The gem is cut from the house blues (light blue, royal blue and
  chrome white). The mine is a gunmetal body on chrome spikes, and its only
  colour is a bust-red fuse tip.
- **The attract.** Before the first pick a slow band of light sweeps across the
  board, column by column, and the corner LEDs breathe.
- **The readouts** are black-glass plates with a chrome hairline; money reads
  in gold and a loss in bust red, every ink at 4.5:1 or better.

## Motion and access

Every animation is opacity or transform (or emissive, in the scene) only and is
scaled by Animation Speed. Reduced motion drops the motion and keeps the
meaning: the lit pegs, the found gems and their sparkle, the red edge of the
mine that ended the round, and every multiplier and colour. Diamond Mines has no
hover state (the stylesheet contract forbids one); its LED edge answers touch
and keyboard focus.

## Files

- `src/components/plinko/PlinkoBoard.tsx`, `PlinkoBoard.module.css`,
  `plinkoPegField.ts`, and the new `plinkoCabinet.ts` (the frame, LEDs, sign
  plate, sill, glows and sparkle trail).
- `src/components/games/MinesGrid.tsx` (the `GemArt` palette and a
  `data-attract` flag on the board) and `MinesGrid.module.css`.
- `scripts/dev/diamond-test-shots.mjs`: frames the scene before each shot,
  saves a scene-only close-up, turns Mines tiles over (`MINE_TILES`) and can
  capture reduced motion (`REDUCED=1`).
