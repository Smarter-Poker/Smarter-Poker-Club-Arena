# Retired board bootstrap keeps its original proof

Concurrent protected merges combined the specific supersession record from PR #7228 with a later relaxation of the obsolete bootstrap's `@live-proof` from `= 50` to `>= 50`. The existing immutable-source regression then failed on current protected main: one failed, fifteen passed.

Restore only the historical file's original proof and comments, SHA256 `eb04461506dfa6b47ad6294755a600a3c7e23e8c4e80f611622f3c5ae901c99b`. Keep the verified supersession registry entry naming installed replacement `20261016182049`. The trusted default-branch ledger already explicitly skips this superseded bootstrap, so its old 50-row assertion is not reinstated as the current board contract. Current canonical planning independently proved 52 rows and zero proposed mutations. No SQL is installed or replayed, no board row is changed, and no regression assertion is weakened.

The original file restoration is intentional: retirement belongs to the existing registry, and historical source bytes remain pinned. Qualification and protected delivery are recorded in the existing Diamond audit checkpoint; the engine/client runtime fixes remain independently delivered through PR #7226.
