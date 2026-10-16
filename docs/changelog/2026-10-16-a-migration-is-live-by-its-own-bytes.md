# A Migration Is Live By Its Own Bytes

Production Integrity Audit run 38939751917 failed "Every merged migration is live" on `20261015173123_a_calculating_week_advances_on_its_own_tick.sql`. Production does have that migration: `supabase_migrations.schema_migrations` holds version `20261015173123` with statements byte-identical to the file (MD5 `c0326d2c100dd1295822f61ee981cecb`), but its name is NULL. With no name to match, the check fell through to the file's `@live-proof`, which pins a `fn_process_weekly_accounting_scope` body that later installed migrations replaced, as they were meant to.

`check-migrations-are-live.mjs` now treats a ledger row with the file's own version and the file's exact bytes as that file. This is the same lock the recording manifest already relies on: a file that never ran cannot hash to the statements production recorded for its own version. A different byte count still goes on to the object and proof checks.
