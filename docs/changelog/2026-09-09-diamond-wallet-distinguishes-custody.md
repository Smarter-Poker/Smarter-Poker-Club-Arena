# Diamond Wallet Distinguishes Available Funds And Custody

Phase 4 reuses the authenticated Diamond custody balance component inside the existing Poker Arena wallet modal. Available Diamonds and Diamonds In Play are shown separately. Failed balance reads show an unavailable state with Retry Balance instead of a fabricated zero or stale number. History continues to read only diamond_transactions and is independent of balance-read failures. The existing modal remains mounted over the active table layer.

This is the balance presentation portion of Phase 4. Atomic player transfers and their full acceptance remain open. No new funding, conversion or transfer action is enabled by this change.
