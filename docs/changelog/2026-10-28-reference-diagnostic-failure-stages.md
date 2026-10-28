# Reference inspection failure stages

The original-hand inspector returned the same top-level unknown for module loading, child transport, JSON parsing and result validation. Run 40612165192 therefore cannot establish missing journal records or a particular loader defect.

The existing finite diagnostic now reports closed stage and failure codes, drains stderr separately from its single JSON report, and suppresses startup console methods only inside that child. Both streams still count toward the same aggregate 4 MiB bound; the 25-second command deadline, 128 MiB child heap, container identity checks, original hand bindings, actor/stage selection, hashes, reconciliation and strict observation sanitizers remain unchanged. Raw child errors, logs and cards are never exported. No trailing-line JSON salvage is accepted.

Regression coverage exercises the actual child entry point with noisy and failing modules, missing exports, real stderr/nonzero/oversized subprocess output, and forged diagnostic fields, alongside all existing v1/v2/v3 and tournament checks. These isolated fixtures are not original-hand observations. This change neither diagnoses the earlier V8 fatal allocation nor repairs engine memory; expanding GC/native-frame parsing is deferred to keep this fix bounded. There is no engine source, runtime setting, workflow, qualification or activation change.
