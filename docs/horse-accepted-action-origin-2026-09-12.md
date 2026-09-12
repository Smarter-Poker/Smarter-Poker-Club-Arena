# Accepted action origin prerequisite

A public fold by a horse can be a strategy choice, a declined-worker fallback, a disconnect expiry, or a watchdog recovery. Those events have the same actor and action but must not be pooled as evidence of voluntary strategy.

The final executors now label accepted ordinary actions as player, pre_action, horse_policy, horse_fallback, forced or unknown. The controller attaches a validated origin to its internal PLAYER_ACTION event after the action is accepted; the delayed consumer carries it into the existing atomic hand history. Missing or invalid origin remains unknown. The controller/UI action history and public player-action event still omit internal learning metadata.

Direct player origin requires the validated displayed action context. Both immediate and delayed pre-action paths supply their own literal source. The HTTP handler does not consume caller-supplied provenance. Horse worker expiry/failure and rejected-action recovery are explicitly horse_fallback; departure, disconnect and watchdog paths are forced. In particular the worker's existing requestId=-1 safe-action path must not be labelled horse_policy.

This change records provenance and preserves existing gameplay. It does not activate a learner or change legacy HorseMind/tuner behavior. Full Phase14 still requires immutable hand UUID/original action ordinal, precise hand-bound session and context binding, durable idempotent observations/models, sample and uncertainty floors, isolated holdouts, proposal lineage, shadow controls and activation/rollback gates.

Initial focused verification passed124 tests across7 files. Three older horse-call expectations failed on the new argument; one also exposed and corrected misclassification of the worker-expiry safe action. An additional HTTP spoof/retry test verifies one accepted player origin despite caller-supplied provenance. Final build passed. The integrated full server suite on a9f02301adae980ced73dac07f465066eea031cc passed 11,040 tests with 145 existing skips (758 passing files and one skipped file). The final focused turn/timing/context checks passed 46 tests across four files. Earlier full-run failures were three assertions tied to the old call shape; their updates preserve turn cancellation and timing/counter ordering.

A frozen native comparison on a1f9be55eb8310f98c042422a2907f157474c65e matched 162 complete offline hands across nine variants, three seat populations, ordinary/bomb hands and three action policies. Removing only origin metadata preserved all compared gameplay facts; 2,205 public nodes and 70 private-discard exclusions were retained. Seven runtime source hashes match the final tested source. This is software equivalence evidence, not fleet timing or natural learner certification.

Protected CI, merge, engine publication and natural release proof remain pending. No tuning policy is activated.
