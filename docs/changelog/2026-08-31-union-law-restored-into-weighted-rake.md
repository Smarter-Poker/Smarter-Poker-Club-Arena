# 2026-08-31 — Union law restored into the weighted rake router (Phase 1)

fn_union_law_selftest had been critical since 2026-08-29: the
weighted-contributed-rake rework replaced atomic_distribute_rake and lost
both the PRIVATE-GAME ISOLATION law (private club game rake must never touch
union numbers) and the TRUST-HELD TREASURY law (rake lands in rake_wallet
only; the Union Bank is credited at the weekly 90/10 close, not per hand).

Restored both INTO the weighted router (per-player rake_attributions,
rake_method, returned_uncalled and mismatch alerting all kept), at the live
signature. Reversed 136,458.18+ chips of wrongful Union Bank credits with an
audit adjustment row. Selftest asserted healthy inside the migration; rake
verified flowing after the swap; standing alert resolved.

Exposure notes: private-game leak = 0.00 in the clobbered window (no private
tables raked). The Union Bank correction is arithmetic reversal of exactly
the double-credited rake rows since 2026-08-29 13:38:16Z — nothing else was
touched, rake_wallet (1.78M held in trust) untouched.

Applied migration: union*law_restored_into_weighted_rake (repo copy
20260831001500*\*.sql).
