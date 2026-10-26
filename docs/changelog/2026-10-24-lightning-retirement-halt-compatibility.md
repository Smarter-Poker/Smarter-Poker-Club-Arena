# Preserve The Existing Lightning Halt Contract

The first canonical-pool installation was refused by the existing `tables_dealing_halt_is_explained` constraint. The entire second migration rolled back and its ledger version remains absent. The five-ready migration was already installed and is not changed or replayed.

Correct the uninstalled canonical migration to use the existing `lightning` halt reason. Preserve the disabled-source predicate, existing holds, dealer observation, active-hand settlement and original per-occupancy cashout. No production constraint, wallet, seat or public API is changed by this correction.

The native Pineapple transition fixture now carries the exact production halt constraint. The previous migration reproduces SQLSTATE 23514; the correction completes canonical routing and custody assertions under that constraint. Install only the corrected protected-main bytes after required checks pass, then verify the ledger, conversion state and published client.
