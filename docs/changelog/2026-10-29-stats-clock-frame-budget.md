# Stats proof shares the animation clock

Framer captures requestAnimationFrame when its module loads and reads
performance.now when a frame runs. Installing a clock after loading Framer can
therefore mix native animation frames with a paused synthetic timestamp. The
second exact proof warmed the ledger successfully but never completed the fresh
tab exit under that mixed clock.

Install the clock before reloading the document, keep it running for warmup and
initial reads, then pause for the fresh mount. Drive the real exit with DOM-driven
16ms frames, stop as soon as the pane mounts, and cap total advancement at299ms.
No reduced motion, animation disable, extra debounce time, retry or assertion
removal is involved. Existing expansion, initial-reset and299+1search assertions
remain required.

The isolated browser fixture bundles the real React, Framer, Stats transition
and Downline ledger with a synthetic service. Its negative control reproduces
no pane under the old late-clock/eager299protocol; the corrected protocol mounts
and passes expansion, initial debounce and changed-search checks. Run it with
`playwright test --config=playwright.stats-clock.config.ts`. The ordinary Vitest
contracts pin install-before-reload and exercise the299ms cap/early stop; the
production proof invokes the same helper through the existing fixed workflow.
