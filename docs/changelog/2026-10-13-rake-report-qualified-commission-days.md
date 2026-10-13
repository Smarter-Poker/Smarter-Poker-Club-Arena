# Rake Report Commission Queries

The Advanced Club Data report repeatedly exceeded its database deadline. Bounded live diagnostics reproduced a timeout in its raw monthly commission aggregate before settlement classification. The report read millions of journal entries despite existing transaction-owned per-agent daily reporting facts.

The reader now uses verified complete UTC days, exact journal fallback for invalid or unqualified days and partial edges, and indexed unpaid settlement gaps. Original authorization, amounts, settlement boundaries, ordering, pagination and nullable residual totals remain unchanged. Nonfinite numeric values retain the original settled-sum calculation. Original financial writers and invalidation triggers remain unchanged and are verified by exact source hashes.

A private operator-only helper qualifies one historical closed day under the original commission writer lock. The existing explicit migration installer has an optional exact-source-bound historical qualification step, with separate transactions, finite deadlines, durable marker readback and no automatic retries. It changes private report metadata, while preserving the original journal and balances.

Native PostgreSQL passed 1,344 exact before/after JSON comparisons, qualification/replay/rollback and original writer lock/invalidation cases. The real installer module passed against the isolated native database, including dry run, durable day markers, unchanged journal and a second operation with no repeated writes. The maintained Data Console native checks invoke these regressions directly. Production installation, timing and live period checks remain pending.
