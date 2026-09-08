# Thinking Face Throwable

Adds the planned Thinking Face item with original transparent artwork, three expressions, an independently rising chin hand, the reference landing bounce, eyebrow changes, animation-speed scaling and a meaningful reduced-motion pose. The picker and network ID both use thinking.

The source atlas, composed picker source, lossless runtime atlas and three content-addressed thumbnail sizes are included. Coverage is now 52 of 80 enabled IDs, with 28 still missing. The existing licensed pop plays at landing; the dedicated recorded hmm and full multiplayer/device acceptance remain pending.

Reference timing: flight 333 ms, pop 433 ms, hand rise 600-900 ms, brows knit 900-1200 ms, thinking loop through 4000 ms, then clean removal.

Validation: 61 focused tests pass; 12 browser frames reviewed at the reference beats and four seat sizes; identical normalized poses at 0.5x, 1x and 2x; reduced motion has no active animations and retains the chin-hand pose. Lossless visible-pixel comparison and TypeScript/production compilation pass.
