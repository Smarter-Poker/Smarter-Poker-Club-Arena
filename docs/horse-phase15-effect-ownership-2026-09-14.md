# Horse decision effect ownership

A malformed later plan record could leave earlier HorseMind writes applied. A valid plan could also survive a later policy choosing a different wager: the existing executor compared the final selected action with the accepted action, but the plan had been authored for the earlier reference action.

The complete batch is now validated before its first mutation. Plan records are bounded and typed, and the client binds every nonempty batch to its original horse, hand and street. The worker retains reference plans only when that exact bet or raise survives final policy selection. The client independently checks this origin before completing a decision. A malformed explicit commit returns an error without applying any effect; the next FIFO request remains usable.

`HorseDecisionEffects` is called by `HorseMind.applyDecisionEffects`, the worker's commit envelope and fast-decision paths, and the client's fast-result admission path. The shared hand-key helper preserves the actual HorseMind reader's existing identity. `phase15_reference_plans_retired` counts captured intent discarded after a later policy changes its wager. Effect validation and retirement are included in the measured decision time.

Validation on September 14:

- Initial batch regressions: 7 failed and 67 passed. Additional worker and client origin regressions failed before their repairs.
- Final focused checks: 342 passed across 7 files.
- Full server suite: 12,754 passed and 157 skipped; 841 files passed and 1 skipped. The earlier full run failed only the source guard asserting the replaced implementation; that guard now checks the actual retention helper.
- Server TypeScript build and whitespace checks passed.

This is source and test evidence. It does not establish deployment, natural execution, poker strength, complete source coverage, a durable decision ledger, or deterministic restart replay. The legacy hand key is not a complete ledger state identifier. No database changes or learned-policy activation are included.
