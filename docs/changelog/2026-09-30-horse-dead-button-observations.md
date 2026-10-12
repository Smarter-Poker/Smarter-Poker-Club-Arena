# Horse observations preserve a valid empty dealer button

The final Phase 6 route audit on serving engine f92ef579 found 43 tournament preflop actions with unavailable observation identity. Same-window read-only database aggregates find 43 matching refusals, all NLH hands with a legitimate empty dealer-button seat. Journal record time and database creation time differ; this count agreement is not an individual-ID join. The accepted action and completed hand existed; Horse public-state capture required an occupied button and discarded the valid metadata.

The producer and adaptive consumer now accept physical dealer seats 1–10 in hands with at least three dealt players. Heads-up still requires an occupied button. Adaptive structural keys preserve the existing occupied-button encoding; dead-button positions count clockwise from the physical empty seat and assign no player position zero. Invalid seats and missing hero positions still fail closed.

The preflop atlas remains bounded to its maintained coordinates. An empty physical button must retain an explicit unsupported-state context, rather than mislabeling a real cutoff as the button. This correction changes neither gameplay nor financial state and introduces no promotion authority.

Seven connected controller/capture/identity/binding/consumer regressions failed before the repair; all 137 focused tests pass afterward. The [Phase 6 qualification record](../horse-brain-phase6-completion-2026-09-30.md) retains the aggregate production diagnosis, frozen population, replay and capture evidence, together with the exact baseline identities and limits. The repair requires normal protected engine publication and fresh affected-behavior verification; the historical baseline certificate does not certify new source.
