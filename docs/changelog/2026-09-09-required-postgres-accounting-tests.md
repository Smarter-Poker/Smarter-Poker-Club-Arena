# Required PostgreSQL transaction gate — local Phase 2 build

The existing ordinary server suite skips CashoutDeparturePostgres.test.ts unless its disposable database is supplied. A passing ordinary suite therefore did not prove real SQL transaction behavior.

The CI workflow now defines accounting_postgres on an ephemeral Ubuntu runner, installs PostgreSQL 17 tools if absent, and runs scripts/dev/probe-departure-postgres.sh. The harness creates its own socket-only temporary cluster and destroys only that cluster. No production SQL probe or production credential is used. Package setup suppresses creation of a default PostgreSQL 17 service.

The required Server Engine (typecheck + tests) job depends on this job and explicitly fails if it did not succeed. Both have the same change/schedule condition. scripts/dev changes now trigger these gates. The harness discovers PostgreSQL 17 on supported Mac/Linux paths and rejects another major version.

Validation completed locally: YAML parsing/dependency assertions, shell syntax, 88 database cases through the portable harness before the subsequent close-path edits, and 23 focused workflow tests. The initial related-workflow run had 233 passes and one obsolete count assertion expecting exactly two scheduled suites. That assertion now checks the named client, server and accounting suites and their required dependency.

Actual execution of the new GitHub job is still pending. This is not a CI-run, publication or Phase 2 completion claim. Final combined tests must run after the close-path build.

PostgreSQL package source: https://www.postgresql.org/download/linux/ubuntu/.
