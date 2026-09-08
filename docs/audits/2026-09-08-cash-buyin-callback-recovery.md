# Cash Buy-In Callback Recovery

The iPad Home Screen report remains open: about 30 seconds before table action,
then a silent cash buy-in. This patch addresses confirmed callback defects,
not a proven reproduction of the device's full incident.

## Changes

- TablePage uses the shared UUID compatibility helper inside its complete
  try/finally boundary. UUID or optimistic-paint exceptions release the latch.
- Removed the unbounded cosmetic duplicate-seat read before atomic_table_buyin.
  The RPC remains the authoritative seat and purchase validator.
- A committed purchase cannot be reverted by post-commit UI exceptions.
  Hydra and engine notifications report independently; a stalled notification
  cannot hold the buy-in latch or delay the post/wait prompt.
- BuyInModal isolates decorative sound failures, prevents duplicate callback
  dispatch, and displays callback rejection inline. Its dialog and errors are
  no longer hidden by an aria-hidden ancestor. Close paths respect processing.

## Verification

The tests execute TablePage's actual callback extracted from its JSX with
external dependencies replaced. They cover missing native UUID support,
throwing UUID generation and a subsequent attempt, throwing/hung notifications,
post-commit listener failure, and explicit purchase rejection. Modal tests
render the real component and exercise sound and callback failures.

Initial focused run: 32 tests passed across five files; tsc --noEmit passed.
No production purchases, seats, wagers, refunds or migrations were performed.

## Still Open

The purchase HTTP request itself still needs a bounded unknown-outcome and
receipt reconciliation path. A transport failure is not proof of rollback.
The existing optimistic sheet close and transient TablePage errors also need
persistent pending/outcome presentation. Retained request keys must remain
bound to the original payload across cancellation, retries and route changes.
These are not solved by removing the cosmetic read.

The physical iPad's 30-second table connection delay and fleet hand-delay tail
remain unverified and unresolved. Green unit tests do not close those incidents.
