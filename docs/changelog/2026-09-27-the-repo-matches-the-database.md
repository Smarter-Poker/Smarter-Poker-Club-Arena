# The Repository Matches The Database

2026-09-27. Owner instruction: "Repo drift: dozens of migrations are live in
production with no file in the repo. Until the repo matches the database,
rebuilds can silently lose fixes." Nothing was applied to production; the
database was only read (`SELECT`), and every file added records SQL that
production already ran.

## What Was Measured

A two-way diff by name, with statement hashes, of all 5,005 rows in
`supabase_migrations.schema_migrations` against every migration file on
`main` here and in World Hub (the other repository that writes this
database), plus Commander, Diamond Arena and PepNationLab for attribution.

| Direction                                 | Before                        | After (all reconciliation PRs merged)                       |
| ----------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| Installed, no file, all time              | 1,272                         | 19                                                          |
| Installed, no file, since 2026-09-01      | 133                           | 10                                                          |
| Installed, no file, 7-day gate window     | 11                            | 8, all under 24 hours old and carried by open pull requests |
| Merged, not installed, 21-day gate window | 0 failing, 9 to 12 unprovable | 0 failing; 2 explicitly marked superseded; 2 aliased        |

## How Each Gap Was Settled

- **Genuinely missing source (1,194 files).** Recovered byte-exact from
  `schema_migrations.statements`; every body hashes to
  `md5(array_to_string(statements, chr(10)) || chr(10))` for its version.
  Below the 2026-09-15 freeze they carry the legacy `-- BACKFILLED` header,
  which the guards already honour for that range; 76 of them are byte-identical
  to the recoveries on the abandoned pull request #4425 and reuse its exact
  files. Two at or after the freeze are headerless, as the recording manifest
  requires. Ten carried unqualified `UPDATE`/`DELETE` statements on temporary
  tables or at migration top level; each carries an
  `unqualified-write-ok:` line in its header saying so, verified against
  `pg_proc` (no live function body still contains any of them).
- **Five with no recorded SQL.** `statements` is NULL, so they are stubs that
  say so and invent nothing. The one after the 2026-09-20 law carries an
  `@live-proof` reading its own history row.
- **Same migration, different version and name (52 pairs).** The Supabase MCP
  stamps its own version at apply time. These pairs are recorded in
  `scripts/ci/applied-migration-aliases.json` instead of being backfilled a
  second time, and both gates read it through
  `scripts/ci/migration-aliases.mjs`. A row is honoured only when its file is
  in the tree and the applied version has no file of its own, and
  `check-recorded-migrations-evidence.mjs` asks production for the recorded md5.
- **Never installed, superseded.**
  `20260917232311_mtt_activate_unlimited_admission` and
  `20260918005913_mtt_activate_unlimited_with_original_funding` now begin
  `-- SUPERSEDED BY 20260918023630`; production activated unlimited MTT
  admission once, through that file (recorded as `20260918051115`).
- **Self-marked, never backfilled as live.** `20260910125453` ("NOT APPLIED")
  and `20260917181100` ("UNAPPLIED CANDIDATE") are recorded in production but
  their own text says they are candidates. They are left for their owners.

## What Stays Open, And Why

- Eight migrations applied today whose files are on open, active pull requests
  (#5392, #5394, #5403, #5410, #5424, #5426, #5427, #5431). They land with
  those pull requests.
- Seven installed migrations whose files live in Commander or PepNationLab,
  which the gate does not index; `20260420` (`vercel_autofix_columns`), whose
  SQL was never recorded anywhere; and `manual`, which World Hub keeps under
  `supabase/migrations/_obsolete/`.
- No merged migration was found that should be live and is not.
  `011_hand_events.sql` remains deliberately uninstalled, as its own header
  says, until the engine event log is wired.

## Regression Protection

`.github/workflows/migration-ledger-reconciled.yml` asks both questions on
every pull request into `main` and every push to `main`: an installed
migration must have a file (24-hour grace for work in flight; a branch that
adds the missing file passes), and a merged migration must be installed
within 24 hours or say `-- SUPERSEDED BY <version>`. It runs trusted code from
the default branch only, reads nothing from the branch but its filenames, and
has no schedule. `tests/an-installed-migration-and-its-file-agree.law.test.ts`
pins the alias table, the grace, the marker and the workflow's shape.
