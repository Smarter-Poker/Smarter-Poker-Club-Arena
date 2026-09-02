# The End-of-Hand Cadence, Completed (2026-08-28)

Dan (verbatim): "IDENTIFY WINNING HAND(S), DISPLAY THE NAME OF THE WINNING
HAND(S), PUSH POT ANIMATION PLUS THE +XXX TOTAL ANIMATION, PAUSE 1 SECOND,
MOVE THE BUTTON ANIMATION... START DEALING NEXT HAND."

The first three beats already existed (showdown read with the hand named on
the board and on each winning seat; the pot push with each winner's riding
"+N" float). The last two did not:

- **PAUSE 1 SECOND** — `POST_PUSH_PAUSE_MS: 1000` added to
  `handCompletionSpec` (client + engine mirror, byte-identical). It is part of
  the engine's post-hand hold, so the next hand physically cannot start inside
  the rest. Every hold formula (fold win, showdown, capped multiway, RIT)
  carries it; the law test pins the arithmetic.
- **MOVE THE BUTTON, THEN DEAL** — the dealer puck's new seat arrives WITH
  HAND_STARTED, and until today the deal animation began in the same frame:
  the puck glided underneath the flying cards instead of being its own beat.
  TablePage now holds the deal start (and its shuffle/deal sounds) for
  `BUTTON_MOVE_MS: 700` x animation speed — the puck slides alone, lands with
  its tock, and only then do the cards fly. The action panel is held from the
  first instant, so nobody acts into the beat. The beat is deliberately NOT in
  the engine hold: no client can know the new button seat before HAND_STARTED,
  so putting it there would just double-count dead time.
- The puck's glide + its landing tock now honour the player's Animation Speed
  (the glide was the last hardcoded mover on the felt).

## Also closed in this pass (deferred from the 2026-08-27 audit)

- Background multi-table canvases no longer burn a rAF loop per hidden table —
  a canvas with no client rects skips the draw loop; the wall-clock backstop
  still completes the burst so latched state clears.
- The master volume slider finally reaches the UI sound tier: PremiumSFX
  primitives scale by the shared master volume (normalised to its 0.7 default,
  clamped, so untouched setups sound identical).
- A chip-flight whose id carries no epoch token gets its clock started at
  first sighting instead of living forever in the sweep.
- `.seat--winner-pop`, `.seat--stack-glow` and the stack-delta float honour
  --animation-speed on both the CSS and JS side (the last speed-blind pairs).
- Tournament winner sparkles are statically visible under Reduce Motion
  (base rule was opacity 0 + animation: none — permanently invisible).
- SoundService's constructor failure reaches telemetry via reportError.
