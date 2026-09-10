# Retired Automatic Mutation And Database Deploy Paths

## Before

Club Arena still carried two legacy automation families after their source implementation had been removed. The Sentry automatic fixer could create source changes without a reviewed human release path. A database cron could also dispatch engine deployments through a stored GitHub credential. Both paths duplicated the reviewed Hetzner Club Arena release authority and left historical tables, functions, schedules, and a vault secret available to runtime code.

## After

Migration `20260910050100_retire_legacy_autofix_and_db_deploy_dispatch.sql` removes every executable function and exact cron entry for those retired paths in one transaction. It deletes only the named dispatcher secret, moves historical rows into the locked `ca_archive` schema, revokes runtime access, and fails closed if any executable route survives.

The active release receipt remains deliberately separate. `ca_engine_deploy_attempts` and `fn_ca_record_engine_deploy_attempt` record the result of the reviewed Hetzner deployment itself. They cannot schedule, dispatch, retry, repair, or mutate a release.

The schema integration now uses the branch-owned `hetzner-release-authority-retirements.json` tombstone. The shared nightly snapshots remain read-only, and obsolete declarations were removed from their original fragments so the effective manifest cannot add and remove the same object.

## Verification

- The migration version is unique and the SQL is one explicit transaction.
- Every retired function name, table or view, cron command alias, and dispatcher secret has a fail-closed postcondition.
- The active workflow calls only the preserved five-argument receipt writer.
- Manifest JSON parsing and schema-fragment conflict checks cover the retirement declaration.
