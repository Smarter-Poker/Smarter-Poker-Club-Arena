# The tenth recorded migration, and the probe that had been testing a stale body

2026-09-23, fourth pass. Issue #5008. This is the last of the ten records, and
it is the only one that was never blocked by a guard verdict at all.

## What actually stood in its way

`scripts/ci/probes/chip-journal-atomicity` builds a closure of functions out of
the migration history - the newest definition of `atomic_distribute_rake` and
every public helper it reaches - and replays them into an isolated PostgreSQL
to prove the chip journal survives failure and replay.

Production has been running a newer `atomic_distribute_rake` since
2026-09-17 18:11:00Z, and this repo had no file for it. **So the probe has been
replaying a body production stopped running six days ago.** Recording the file
is what makes the probe honest, and it is also what made it fail: with the real
body, the closure grows from 23 functions to 27, and the fixture is short of
what those four reach.

Measured by running the probe's own closure resolver against a tree with and
without the file, rather than by reading error messages one CI round at a time:

| missing | where it comes from here |
| --- | --- |
| `auth.role()` | stubbed in `fixture.sql` beside `auth.uid()`, which was already there. NULL is what a direct connection sees in production too, so `COALESCE(auth.role(),'service_role')` takes the engine path, which is the path this probe drives. A test that wants a browser caller sets `test.role`, exactly as the other fixtures set `test.actor`. |
| `accounting_agreement_history` | the reviewed capture at `tests/fixtures/full-weekly-accounting/schema.sql`, read the same way `wallet_transactions` already is |
| `union_rakeback_log` | the same capture |
| `accounting_cash_bank_receipts` | defined by this migration; a bare stand-in in `fixture.sql`, like every other table there |
| `accounting_routed_settlement_runs` | the same, carrying the columns the migration's own ALTER adds - `standalone_club_id` and the two generated `scope_kind` / `scope_id` - because the probe replays function bodies and not table ALTERs |
| `clubs.is_union` and `hand_history.started_at` | two columns production has and this fixture did not; `fn_cash_earning_club` reads both |

The two stand-ins carry no foreign keys, because no table in that fixture does:
it is a minimal schema for a chip-journal probe, not a model of accounting
referential integrity, and the migration itself remains the authority for the
real DDL.

## The file, byte for byte

`array_to_string(statements, chr(10))` and nothing else, so its md5 equals the
`md5` column of `public.fn_ca_migration_text('20260917181100')`:
`b244edf6ee9ef6552d7103020bc8b732`.

Its six findings, and what production says about each, are in
`scripts/ci/recorded-migrations.manifest.json`. The short version: not one
function it declares is reachable by `anon`; 24 of its 25 money-trigger
findings are text inside a `$catalog$` JSON literal it asserts against, and the
25th is bound by the reviewed contract already on main; its two repair-shaped
names are existing debt from August with rows in the band-aid register; and the
guard redefinition it failed to declare was recorded forward on 2026-09-21,
which is the entry this change adds to
`tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts` with all
four hashes bound.

With this, `Applied Migrations Are Recorded` has all ten.
