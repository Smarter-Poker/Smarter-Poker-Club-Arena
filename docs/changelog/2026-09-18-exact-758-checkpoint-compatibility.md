# Exact 758 Checkpoint Compatibility

The serving `758610f3f844406bbbaee2f5100ced36d84fb943` engine can enter its pause
gate from the next-hand rest without writing the final parked time-bank snapshot.
The 2026-09-18 02:55 UTC break reported 17 unparked tables. Five sampled cash
tables had already settled before the announcement and retained only an
`:announced` presence row with a null time-bank snapshot. The runtime owner
repairs the missing native pause-entry calls separately; both changes must be
included in the replacement release.

The existing first-install checkpoint path now recognizes one additional closed
profile: that exact source and immutable image
`sha256:0190d49e394fd2b12b1462730bb22c4c4d1c4d49564e19b192bb07e3754c5561`.
It pins the observed Node 22.23.2 runtime, PID 1 command, and compiled source
hashes. The original 2f4 profile remains unchanged.

The 758 profile invokes the original table owner's checkpoint method only after
the native accounting registry is empty, its unconfirmed flag is false, and no
F06 permit or recovery remains. It preserves that registry's identity and the
maintenance checkpoint generation, alongside the existing physical pause,
settlement, fleet, actor, snapshot and persisted-readback fences. It never clears
readiness flags or manufactures a bank, receipt or original operation. Retained
F06 custody refuses the operation even on an otherwise empty stopped owner.

The original release transaction may request its existing bounded recovery
window for this capable predecessor. The same engine lock, immutable request,
single-use checkpoint intent, inspector cleanup, native restart certificate and
full 285-second cutover/rollback reserve still apply. Insufficient time or an
unknown result refuses replacement without a retry or extended freeze.

The new 758 positive fixture failed against the prior implementation. The
existing guard/admission tests cover both immutable profiles, mixed identities,
pending or unknown accounting, retained custody, changed generation/registry,
and false snapshot readback. The isolated native transport suite verifies the
unchanged inspector invocation and cleanup. These local checks do not certify
the production checkpoint or replacement; the owning release must verify them.
