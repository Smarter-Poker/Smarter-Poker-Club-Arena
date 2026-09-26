# 2026-09-26: Every Game Ends In Its Own Reveal, And Fits A Phone On Its Side

Mobile spins programme, phase 6 of 7. Two things the four Diamond bonus games
still did badly: every one of them ended on the same blue chip stack, and none
of them fit a phone held sideways.

## Shipped

### Part 1: the receipt wears its game

- **`BonusCompletion` takes the game that produced it.** Two new optional
  props: `game` (`'crash' | 'plinko' | 'crossing' | 'mines'`) and `figure`, the
  one number that game is about. With a game, the receipt's picture is that
  game's own; without one, the chip stack stays exactly as it was. Every other
  prop, the title, the copy line, the eyebrow, the silence rule, Back To The
  Wheel, Play Next Bonus Game and the rule that the receipt never leaves by
  itself (Dan 2026-09-21, R1) are unchanged, and pinned again with the art on.
- **The art is new, original and drawn in SVG** (`BonusReceiptArt.tsx`), with
  no raster asset:
  - **Crash:** the chrome jet at the top of a gold ribbon, the multiplier it
    booked printed in gold ("Booked At 2.35x"). A round booked at the 25.00x
    max gets the crown: a gold crown over the jet, a gold halo and a hotter
    glow on the figure.
  - **Donkey Cross:** the donkey standing on a lit street sign that reads the
    street it reached ("Made It To Street 7").
  - **Plinko:** the best bucket the batch landed in, its plate lit in that
    bucket's own tint, a diamond landing in it and the multiplier engraved in
    gold ("Best Bucket 7.5x"). The tint is `receiptBucketTint`
    (`bonusReceiptFigure.ts`), a mirror of the board's `bucketTint` kept apart
    so the receipt never loads the WebGL board; a unit test holds the two
    equal for every multiplier from 0x to 30x. On a small receipt (a phone on
    its side) the plate prints the figure alone, without its caption.
  - **Mines:** a fan of the gems found, with the count in gold beneath
    ("Gems Found 4").
- **Each page passes values it already held:** Crash the settled round's
  cash-out (or crash) multiplier, Plinko the best `multiplier_cents` among the
  drops, Donkey Cross the streets crossed, Mines the gems found (a lost
  round's last pick was the mine). The offline test page shows the same art
  through a new optional `art` slot on `WheelWinReveal`, and its lost rounds
  now wear the live receipt's loss dress ("Guarantee Paid", silent).
- **Motion in the reveal's language.** The ribbon draws and the jet flies it on
  one clock, the donkey hops onto the sign as its LED flickers on, the diamond
  drops and bounces into the bucket, the gems fan out one after another, and
  the figure pops in last. Every duration and delay is `calc(... *
var(--animation-speed, 1))`, the component writes the player's Animation
  Speed onto the art, and under reduced motion the art and figure are simply
  there in their final state.
- **A loss stays restrained.** A receipt with an eyebrow (a crash, a hit, a
  mine) shows the same art at half opacity and low saturation, and its figure
  in silver `#e4e7ec` instead of gold. No crown on a lost round.
- Inks are gold `#ffd700`, lit blue `#45adff` and silver `#e4e7ec` on the
  console's black glass, all well over 4.5:1.

### Part 2: a phone on its side

Before, at 812 x 375 the wide layout put the board beside the controls at the
full height the board wanted: the scene ran off the bottom of the screen, both
plates sat below the fold of a controls column that scrolled on its own, and
on Donkey Cross the wide layout's route plate landed on the readout. Nothing
honoured the notch or the home indicator.

- **The console is one screen** (`GameConsole.module.css`, query
  `(orientation: landscape) and (max-height: 500px)`, also exported as
  `SHORT_LANDSCAPE_QUERY` from `src/hooks/useSceneBudget.ts`): a 44px header,
  the scene beside the controls, and `--scene-budget`, the height left for the
  scene after the header, the playfield padding and the bottom safe area.
- **Both plates are always on screen.** They sit side by side, pinned to the
  foot of the controls column (`position: sticky`), padded by
  `env(safe-area-inset-bottom)` so neither is under the home indicator. The
  setup and the bays scroll inside the column when they need to; the plates
  never do.
- **The notch.** The console pads itself by `env(safe-area-inset-left/right)`.
  `diamond-test.html` now declares `viewport-fit=cover`, as `index.html`
  already did, so the test page sees the same insets the app does.
- **Every scene fits the budget.** Crash reads it through `useSceneBudget()`
  (the page less its day line and crash-points strip); Plinko's cabinet is held
  to the width whose height fits (`.sceneFit[data-scene='plinko']`); Donkey
  Cross's scene takes the budget as its height and its plates take their phone
  places; Diamond Mines becomes a row, readouts and caption on the left and the
  square board on the right, every tile still wider than 44px.
- **The console brings itself to the top** of the screen when a page opens
  sideways or the phone turns onto its side, so the back link above it does
  not push the plates under the fold. Upright, nothing moves.
- **Reveals fit too.** Sideways, the reveal card (the wheel's and every
  receipt) is held to the width whose height fits the screen, with the prize
  art smaller, so the title, picture, copy and plates are one view. The Double
  Down offer keeps its own width rule.
- Every rule is inside the short-landscape query, so the portrait phone and
  desktop layouts and every e2e size assertion are unchanged.

### The screenshot harness

`scripts/dev/diamond-test-shots.mjs` takes `VIEWS` (`phone`, `desktop`,
`landscape` for 812 x 375, `safe` for 844 x 390 with an iPhone safe area). The
safe area is Chromium's own `Emulation.setSafeAreaInsetsOverride` (47px left
and right, 21px bottom), so the pages read real `env(safe-area-inset-*)`
values; no fixture switch was needed. The sideways views frame the console and
log a `LAYOUT` line per shot: horizontal overflow, and whether the scene and
both plates are inside the viewport and clear of the insets. Every run also
shoots the finished game's `receipt`.

## Files

- `src/components/games/BonusReceiptArt.tsx`, `BonusReceiptArt.module.css`, `bonusReceiptFigure.ts` (new)
- `src/components/games/BonusCompletion.tsx`
- `src/components/wheel/WheelWinReveal.tsx`, `WheelWinReveal.module.css`
- `src/components/games/GameConsole.tsx`, `GameConsole.module.css`
- `src/components/games/ChoiceScene.module.css`, `MinesGrid.module.css`
- `src/hooks/useSceneBudget.ts` (new)
- `src/pages/DiamondCrashPage.tsx`, `DiamondPlinkoPage.tsx`,
  `DiamondChoicePage.tsx`, `DiamondTestPage.tsx`, `diamondGames.module.css`
- `diamond-test.html`, `scripts/dev/diamond-test-shots.mjs`
- `tests/components/BonusCompletionArt.test.tsx` (new)

No scene frame loop, money path, RPC, migration or fairness code was touched.
