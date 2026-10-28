# Reference inspection failure stages

The original-hand inspector returned the same top-level unknown for module loading, child transport, JSON parsing and result validation. Run 40612165192 therefore cannot establish missing journal records or a particular loader defect.

The existing finite diagnostic now reports closed stage and failure codes, drains stderr separately from its single JSON report, and suppresses startup console methods only inside that child. Both streams still count toward the same aggregate 4 MiB bound; the 25-second command deadline, 128 MiB child heap, container identity checks, original hand bindings, actor/stage selection, hashes, reconciliation and strict observation sanitizers remain unchanged. Raw child errors, logs and cards are never exported. No trailing-line JSON salvage is accepted.

Regression coverage exercises the actual child entry point with noisy and failing modules, missing exports, real stderr/nonzero/oversized subprocess output, and forged diagnostic fields, alongside all existing v1/v2/v3 and tournament checks. These isolated fixtures are not original-hand observations. The composed reader also records bounded nearby V8 GC/native-frame context while keeping allocation and isolate ownership unknown. It does not repair engine memory. There is no engine source, runtime setting, workflow, qualification or activation change.

Composition with the bounded V8-context reader preserves both reviewed implementations. The existing wiring contract now binds the reviewed reference function and embedded helper bytes and strictly expects the sanitized child-transport stage; the tournament result and private-payload exclusion remain unchanged.
