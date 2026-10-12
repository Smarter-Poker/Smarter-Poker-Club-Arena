# The migration production applied from #5522 is recorded, and #5522 and #5527 are closed (2026-09-28)

Two open pull requests each tried to stop one lost `fn_consume_time_bank` reply
from holding a tournament's stopped time bank for the life of the engine
process. Both applied their migration to production before merging. #5530 then
merged and is the one mechanism that ships.

## What shipped, and what did not

- **Shipped (#5530, merged 16:48Z):** every engine debit carries a request id;
  `fn_consume_time_bank` receipts it (`20260928144831`, carried byte for byte
  from #5527); a lost answer keeps its id and is asked again by that id until
  the database answers. The flag clears only when every kept debit is answered.
  #5533 removed the second overload #5527 had left beside the receipted one.
- **#5527 closed:** its migration is #5530's migration. Its engine half retried
  once and then fell back to the permanent flag, which still freezes under a
  sustained slowdown, the case that froze 87a68e55.
- **#5522 closed, its engine half not carried:** it wrote an unknown debit into
  `smarter_private.time_bank_consume_unconfirmed` and lowered the flag once the
  row was on disk. That records the seconds as owed without knowing whether they
  were charged, and nothing reads the row (a reader would be a repair job,
  CLAUDE.md 10.12). Asking again by id knows.

## What this change does

Production holds `20260928142429` (the write-down table and its service-role
door). The migration was applied from the unmerged branch, so the repo had no
file for it and `Applied Migrations Are Recorded` counted it as drift. This adds
the file, recovered byte for byte from `supabase_migrations.schema_migrations`
(9470 bytes, md5 `ac0edf96...`, equal to `public.fn_ca_migration_text`), a row
in `scripts/ci/recorded-migrations.manifest.json`, and the schema-manifest
fragment. Nothing is applied or altered in production.

Read live the same day: `smarter_private.time_bank_consume_unconfirmed` holds 0
rows; `fn_record_unconfirmed_time_bank_consume` is executable by `postgres` and
`service_role` only and refuses any other `auth.role()`; nothing in `server/src`
calls it. The objects are inert. Dropping them is a separate, deliberate
migration and is not made here.

## What still holds the release shut

The serving engine `763e4cec` holds `timeBankAccountingUnconfirmed` on 71
terminal tournament table engines. All 87 refusals in its log fall between
16:05:02Z and 16:17:38Z (the second overload, PGRST203), none since. Those flags
live in that process's memory and the release certificate refuses
`stopped_bank_custody_stuck` from every serving release by law
(`tests/noServingReleaseBuysACustodyException.law.test.ts`), so the engine that
would clear them cannot be installed while they stand. Only replacing that
process clears them.
