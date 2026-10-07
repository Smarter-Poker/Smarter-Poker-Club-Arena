# Leaderboard Isolation Retains Safe Restore Failure Evidence

The corrected bootstrap-identity run passed role restoration but failed the original-owner extension restore. Owning cleanup destroyed its private stderr, leaving a stage-only failure that cannot establish the cause. The owning restore path now retains only actual client status, SQLSTATE when present, a fixed allowlisted category, and an anchored numeric stdin line index when available. Private SQL, names, settings and raw errors remain unprinted and are removed by the unchanged verified cleanup.

Extension input uses psql's file-from-stdin mode to supply line attribution without splitting connections or transactions. Shared destination refusal reporting also covers the existing database, namespace, schema and catalog-readback failure paths, preserving the same refusal behavior. Exact extension versions, original owners, catalog equality and cleanup remain mandatory. No extension is skipped or replaced, and no production permission or financial behavior changes.

Executable focused regressions exercise the extracted helper and classification/privacy boundaries. Static checks passed; actual extension failure classification is pending a subsequent protected-main preflight. This is diagnosis support, not a claim that the extension restore or the remaining Auth/financial qualification is fixed or complete.
