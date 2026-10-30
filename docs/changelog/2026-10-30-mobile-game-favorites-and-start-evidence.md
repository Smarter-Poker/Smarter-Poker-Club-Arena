# Mobile Game Favorites And Actual Start Evidence

The compact mobile lobby now exposes the same favorite control as desktop for cash games, MTTs, Spins and SNGs. Tapping the star never opens details or spends money. Cash favorites retain their existing table persistence; tournament favorites use the existing account-scoped durable page-preference store, with refresh and pending-write recovery. The Favorites filter includes tournament entries and shared game links remain visible.

An actual started_at now takes precedence over an older registration status in the lobby projection. The board labels late-registration play Running while retaining its late-registration admission and countdown rules. Completed and canceled events remain terminal.

Regression coverage exercises all four mobile controls, add/remove state, no accidental detail/purchase action and started/terminal precedence. Existing preference persistence and lobby suites remain applicable.

The owner separately authorized closing and refunding held overnight events. Operations use installed atomic cancellation and exact immutable receipts after rollback qualification, retain chip/Diamond denomination and reject started events or unverifiable refund evidence. Source publication does not itself prove those operations completed.
