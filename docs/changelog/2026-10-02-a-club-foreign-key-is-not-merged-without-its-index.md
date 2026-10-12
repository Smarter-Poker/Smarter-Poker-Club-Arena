# A foreign key into clubs is not merged without its index

2026-10-02. Migration `20260926140858` created two `club_id` foreign keys into
`public.clubs` (`accounting_legacy_rakeback_certificates`,
`accounting_legacy_settlement_legs`) with no index that could answer them. The only
check for that, `scripts/ci/check-club-fk-indexes.mjs`, asks production through
`fn_ca_fk_index_gaps` and runs only after deploy, because pull-request CI holds no
production credentials. Every post-deploy certificate failed from 09:41Z until
`20261002150335` (#5834) added the two indexes.

## What changed

`scripts/ci/check-added-club-fk-indexes.mjs` runs in the pull-request
`Invariant guards (parallel)` step of `TypeScript compilation and repository
checks`. It reads the migration files the branch adds, applies them on top of the
repository's existing migrations, and fails when a single-column foreign key into
`public.clubs` that an added file creates has no full (non-partial) index leading
on its column. The failure names the table and column and prints the
`CREATE INDEX` to add.

## What it deliberately does not judge

Production has foreign keys into `clubs` that no file in this repository creates
(18 of 95 on 2026-10-02: no statement in the migration ledger creates nine, seven
came from `20260917181100`, one from `20260817185349`, and one from a version
whose file here is a different migration). A `DROP INDEX`, rename or dropped column
cannot be judged against keys the repository cannot see, so those stay with the
post-deploy check. Dynamic SQL in `EXECUTE` strings and function bodies are not
read.

## Evidence

- `origin/main` with nothing added: passes.
- `20260926140858` alone, on its parent `7eab4212fd`: fails, naming both legacy
  accounting tables. Adding `20261002150335` makes it pass.
- Replaying each migration in the repository as if it were the only file added
  on top of the ones before it flags 25 files. In 23 of them, a later migration
  added the missing index. The other two are pre-ledger files
  (`002_financial_core.sql`, `013_missing_tables.sql`) whose keys production
  does not have.
- `tests/an-added-club-foreign-key-brings-its-index.test.ts`.
