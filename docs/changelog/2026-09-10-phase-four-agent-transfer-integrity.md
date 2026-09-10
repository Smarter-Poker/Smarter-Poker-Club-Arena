# Phase Four Agent Transfer Integrity

Agent portal responses could restore an obsolete club wallet after a club switch, and older reads could replace newer balances. Bind reads and mutation completion to the render identity, sequence wallet and commission reads, and scope commissions by club. Transfer and settlement actions require wallet data for the current identity.

Dashboard sends and prepaid funding created a new operation ID on each attempt, while modal IDs disappeared on remount. Reuse the shared durable intent reservation across retries, including agent and bank sources and player or agent destinations. Preserve compatibility with existing player-wallet reservation keys. Clear reservations only after a strictly confirmed receipt; validate finite whole-cent amounts and both receipt balances.

The dashboard transfer form selects an agent, so its send explicitly targets that agent wallet. Existing player-recipient routes retain player-wallet destinations.

The portal regressions failed on the original source and pass with the fixes. Focused component and intent tests cover lost responses, remounts, malformed receipts, repeated clicks, cross-club completions and out-of-order reads. The final integrated run passed 92 tests across six files, including two additional pending-request remount cases that failed before the confirmation fix. Full client TypeScript passes.

This begins Phase Four under the user instruction to proceed in parallel. It does not close the remaining Phase Three terminal acceptance or the separate expected-actor RPC contract gap. No SQL change is part of this patch.

The required source-contract checks now pin the shared durable reservation, complete transfer identity, recipient-derived wallet route, and strict receipt validation. The discarded-error baseline was reduced because the financial portal now handles its lookup error. Seventy-two affected source-contract and behavioral tests passed.
