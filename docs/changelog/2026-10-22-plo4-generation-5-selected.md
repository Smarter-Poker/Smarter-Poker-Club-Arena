# PLO4 Generation 5 Is Selected On The Maniac-Pressure Source (2026-10-22)

Maniac pressure (#7683, docs/changelog/2026-10-22-horses-adjust-to-maniacs.md) moved every hashed Horse policy digest, so the PLO4 pack (Phase 10) returned to shadow until it requalified.

- Strength: the locked P10.2 matrix (run 39757485267, 111 of 111 shards complete) on source 8ea7564b qualified with no reasons: cash after rake against the horse population +6.93 [+6.25, +7.62] bb/100 over 2,557,440 pairs, policy digest 42ee2bf5..., equal to the digest of current main. Evidence: `docs/evidence/phase10/8ea7564b/`, shipped byte-identically under `server/release-evidence/`.
- Phase 10 has no completion stage of its own (generation 2 precedent, #6901).
- Selection: `PHASE10_PROTECTED_RELEASE_SELECTION`, approval generation 5, cash only. Generation 4 (da94e437) stays retained as `RETIRED_2026_10_22_PHASE10_SELECTION` and is refused by policy digest.
- Tests: the Phase 10 authority suite pins generation 5 and its shipped bytes; exact replay again records a selected PLO4 decision and refuses a forged receipt from another generation by name.
