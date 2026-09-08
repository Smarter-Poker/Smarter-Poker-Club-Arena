# BBJ payout outcome confirmation

## Corrected

The engine treated an empty object or missing applied field as a definitive empty Main pool and closed its pending claim. Truthy string fields could instead confirm a paid/replayed outcome, and multiple result rows silently used the first. The existing payout path now requires exactly one result with explicit boolean applied/already_paid fields and refuses contradictory true/true outcomes. An unknown outcome stays on the existing pending/re-drive path without settling the claim.

Read-only live inspection confirmed bbj_atomic_payout_v2 returns boolean fields. Six actual-module regression cases failed before the change; all six pass afterward alongside the prior 23 payout cases. Server TypeScript passed. Full server suite on this branch: 6,811 tests in 480 files passed. No live financial mutation was performed.

## Still open

This is outcome-shape validation, not complete amount/identity receipt validation. Applied share amounts and payout identity still need independent validation before notification. The existing queue claim is best-effort and its interface cannot prove persistence; queued must not be interpreted as a new durability guarantee from this patch.

Payout pool selection still reads current club/union membership rather than the hand's original private/union destination. Contribution routing was fixed separately, so parity and replay after membership changes remain an explicit audit item. Combined hand stack/rake/BBJ atomicity, the older direct repair writer, liability-aware gross bank displays, parked-recipient notifications, and cross-repository privileged writers remain open.

The full 216-requirement audit and the expanded Backup BBJ, promo and cashier audit are not complete. Source tests are not deployment proof.
