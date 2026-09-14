# Spin Replays Survive The Actual Deal Hold

A slow Spin startup could extend the engine's first-deal hold while its early reveal expired at the original deadline. The admission pass now refreshes that reveal when the hold grows, preserving the same funded multiplier, prize and reveal instant. It also delivers a reveal when the early emitter failed. Quick starts keep one announcement.

The shared event hub now marks a replay delivered only after its socket send succeeds. A failed replay therefore remains available on the existing resync path instead of being suppressed permanently.

Three baseline failures were reproduced. Root and server TypeScript checks passed; 115 tests passed across eight server files. Full evidence, industry comparison, reproduction and remaining Phase 3 gates are in [the reveal delivery audit](../audits/2026-09-10-phase3-spin-reveal-delivery.md). No financial rules, database schema, production data or deployment changed in this lane.
