# The ninth recorded migration, and what the tenth still needs

2026-09-23, third pass. Issue #5008. PR #5122 landed eight of the ten recovered
records, the verified recording category and two root-cause guard fixes. This
is the ninth.

## Why it could not be in #5122

`20260917060339` is one of only two of the ten that
`check-money-trigger-declared` said anything about, and the required
`Money trigger declaration authority` check could not see the fix that was in
the same branch.

`Trusted Money Trigger Recovery` is `pull_request_target`, checks out the
DEFAULT BRANCH, loads its policy only from reviewed main code and reads its
live evidence itself, never from a PR artifact. It is right to be built that
way, and it meant it ran MAIN's copy of `offenders()` - the dollar-quote-blind
one - which reported eight undeclared triggers on money tables in a file that
contains no `CREATE TRIGGER` statement at all. All eight were text inside one
`$trigger_pins$[...]$trigger_pins$` JSON literal it hands to
`jsonb_array_elements()` in order to ASSERT that those triggers are present and
unchanged. All eight are live, all eight already hold a row in
`public.ca_declared_money_triggers`, and `fn_undeclared_money_triggers()`
returns zero rows platform-wide.

With #5122 on main the same trusted job reads **zero** findings for this file.

## The file, byte for byte

`array_to_string(statements, chr(10))` and nothing else, so its md5 equals the
`md5` column of `public.fn_ca_migration_text('20260917060339')`:
`0892a3fa158d856a729eb8a31e3fc8d5`.

## What the tenth still needs, measured

`20260917181100` is the last one, and it is not blocked by any guard. It is
blocked by a CI probe that it makes MORE honest, which is worth writing down.

`scripts/ci/probes/chip-journal-atomicity` builds a closure of functions from
the migration history - the newest definition of `atomic_distribute_rake` and
every public helper it reaches - and replays them into an isolated PostgreSQL.
Production has been running a newer `atomic_distribute_rake` since 2026-09-17
and the repo had no file for it, so the probe has been exercising a stale body.
Adding the file gives the probe the real one, and its minimal fixture is then
short of exactly:

- `auth.role()`. The fixture stubs `auth.uid()` and not its other half.
- four relations, measured by running the probe's own closure resolver against
  a tree with and without the file (closure 23 -> 27):
  `accounting_agreement_history` and `union_rakeback_log`, both present in the
  reviewed capture at `tests/fixtures/full-weekly-accounting/schema.sql`, and
  `accounting_cash_bank_receipts` and `accounting_routed_settlement_runs`,
  whose DDL is in the migration itself.

That is a change to the fixture of a money-critical probe that cannot be run
outside Linux CI, so it is its own pull request rather than a passenger on this
one. Everything else it needs is already on main: the dollar-quote fix, and the
reviewed recovery contract in `scripts/ci/money-trigger-recovery-policy.json`
for the single real trigger finding it carries.
