# A migration recorded under another version is named (2026-10-25)

The Supabase MCP `apply_migration` stamps `schema_migrations` with the apply time, not the file's version: `20261024195842_cashier_transaction_history_scope.sql` was recorded as `20261024203917`, and `20261024200548_plo5_one_two_madness_without_lightning.sql` as `20261024204032`.
`scripts/ci/check-applied-migrations-are-recorded.mjs` now prints `RECORDED UNDER A DIFFERENT VERSION: applied <v> <name>; file <file> - rename ...` under any gap whose file is in the repo under another version (an exact name, or a long name the history stored truncated), and lists them as `recordedElsewhere` in `--json`. They still count as gaps; exit codes and the UNKNOWN sibling-index behaviour are unchanged.
An exact-name pair was already accepted by name, so in practice the line fires for truncated names; the pre-push `check-migrations-applied.mjs` reads the schema manifest, not `schema_migrations`, so it is unchanged.
PUBLISHING.md now says to install a merged migration through Apply Merged Migration (`repository_dispatch` `apply-merged-migration`). Pinned by `tests/appliedMigrationsRecordedIndex.test.ts`.
