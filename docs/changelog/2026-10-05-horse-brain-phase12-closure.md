# Horse Brain Phase 12 closed, Phase 11 re-measured (October 5, 2026)

Horse Brain only. No live decision changes: every Phase 11 and Phase 12 protected release selection stays `null`.

- The four Phase 12 packs (Short Deck, Crazy Pineapple, Fixed Limit Hold'em, Fixed Limit Omaha Eight-or-Better) were measured on their locked held-out matrices for source `27174382`. Every one returned `qualified: false`, losing to the reference on the primary cash cell at 99% and on every seed block. Evidence: `docs/evidence/phase12/strength-2026-10-05-<pack>/` and `phase12-qualification-2026-10-05-<pack>.json`.
- Phase 11 (PLO5, PLO6, PLO8) was re-measured on the same source after its audit fixed the legal form of the candidate's proposals. The verdict is unchanged (not promoted). The October 5 mixed-arm evidence moved to `docs/evidence/phase11/superseded-2026-10-05-mixed-arm/`.
- Natural completion records for all seven packs, read from the predeclared window on release `e187377e` (completion definitions v3 and v1), are below the floor; the equity load governor reduced the live sample on 31% to 43% of postflop decisions.
- `HorsePhase12Authority.test.ts`'s null proof pinned "no completion record exists", the state before the window was read. It now asserts what the hazard actually is, a selected pack: a completion record may exist only while its own variant is unpromoted (the same correction Phase 11's null proof received).

Records: [Phase 12 closure](../horse-brain-phase12-closure-2026-10-05.md), and the amendment at the end of the [Phase 11 closure](../horse-brain-phase11-closure-2026-10-05.md).
