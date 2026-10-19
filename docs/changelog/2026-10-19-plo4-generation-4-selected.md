# PLO4 generation 4 is selected on the VPIP-floor source (2026-10-19)

The VPIP floor call-down (#7323) moved every hashed Horse policy digest, so the
PLO4 pack (Phase 10) returned to shadow until it requalified.

- Strength: the locked P10.2 matrix (run 39132884688, every shard complete) on source
  da94e437 qualified with no reasons: cash after rake against the horse population
  +6.93 [+6.25, +7.62] bb/100 over 2,557,440 pairs, policy digest 4c52572f...
  Evidence: `docs/evidence/phase10/da94e437/`, shipped byte-identically under
  `server/release-evidence/`.
- Phase 10 has no completion stage of its own (generation 2 precedent, #6901).
- Selection: `PHASE10_PROTECTED_RELEASE_SELECTION`, approval generation 4, cash only.
- Tests: the Phase 10 authority suite pins the committed generation and the shipped
  bytes; exact replay now records a selected PLO4 decision, replays it in a fresh
  process, and refuses a forged receipt from another generation by name
  (`identity_approvalGeneration`).
