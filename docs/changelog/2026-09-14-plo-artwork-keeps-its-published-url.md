# Console artwork keeps its published URLs

Two console assets attempted to reuse permanent URLs with different bytes. The static origin correctly rejected publication because existing tabs can still depend on the previous bytes.

The corrected PLO artwork now uses `chassis-b0b05b302c99.png`. Both the rendered card and the mobile registry request it. The original `chassis.png` is restored from the last served source; the production media optimizer reproduces that URL's live bytes exactly.

The buy-in reference now uses `source/approved-reference-37716019dbbf.png`, and `BUY_IN_ASSETS.reference` points there. The old reference remains available in the origin's append-only pool and is no longer emitted by this source tree. The displayed buy-in deck is unchanged and matches the origin.

Both replacement images retain their source bytes exactly. Card geometry, labels, actions, and displayed artwork are unchanged. Regression cases verify the source identities and the actual exported, rendered, and registered URLs. The origin's immutable-pool check remains unchanged.
