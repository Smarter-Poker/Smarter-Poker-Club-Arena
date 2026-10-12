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
| Installed, no file, all time              | 1,272                         | 35                                                          |
| Installed, no file, since 2026-09-01      | 133                           | 15                                                          |
| Installed, no file, 7-day gate window     | 11                            | 8, all under 24 hours old and carried by open pull requests |
| Merged, not installed, 21-day gate window | 0 failing, 9 to 12 unprovable | 0 failing; 2 explicitly marked superseded; 2 aliased        |

## How Each Gap Was Settled

- **Genuinely missing source (1,178 files, plus 5 stubs).** Recovered byte-exact from
  `schema_migrations.statements`; every body hashes to
  `md5(array_to_string(statements, chr(10)) || chr(10))` for its version.
  Below the 2026-09-15 freeze they carry the legacy `-- BACKFILLED` header,
  which the guards already honour for that range; 72 of them are byte-identical
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
  `check-recorded-migrations-evidence.mjs` asks production for the recorded md5
  (as `fn_ca_migration_text` reports it).
- **Never installed, superseded.**
  `20260917232311_mtt_activate_unlimited_admission` and
  `20260918005913_mtt_activate_unlimited_with_original_funding` are marked
  superseded by `20260918023630` in the `superseded` section of the alias
  table, because both are byte-pinned by the MTT activation source binding and
  cannot carry a header; production activated unlimited MTT admission once,
  through that file (recorded as `20260918051115`).
- **Self-marked, never backfilled as live.** `20260910125453` ("NOT APPLIED")
  and `20260917181100` ("UNAPPLIED CANDIDATE") are recorded in production but
  their own text says they are candidates. They are left for their owners.

## What Stays Open, And Why

- Sixteen recoveries create a trigger on a money table. The required trusted
  check "Money trigger declaration authority" accepts such a file only with an
  independently reviewed contract in `scripts/ci/money-trigger-recovery-policy.json`
  and a declaration migration applied to production, which this read-only
  reconciliation may not do. They are held back for the money-trigger owners:
  `20260420005652`, `20260420011512`, `20260721185147`, `20260815165118`,
  `20260815192707`, `20260819211747`, `20260820120810`, `20260820121527`,
  `20260820122738`, `20260821191431`, `20260823042107`, `20260903191338`,
  `20260904081210`, `20260911161027`, `20260912061157`, `20260914003624`.
- `20260909180615_maintenance_ownership_fits_process_lifetime` is what
  production runs (live `fn_entry_purchases_frozen` reads `break_started_at`),
  but recording it makes it the definition the chip-journal atomicity probe
  replays, and that probe's fixture still models the older function. Held back
  for the maintenance lane to bring the probe up to the production contract.
- `20260905000730_the_club_message_has_one_rule_and_one_door` (Dan's
  2026-09-04 ruling) is recorded, and
  `tests/unit/oneLengthForTheClubMessage.test.ts` now pins the rule production
  has run since then instead of the one it replaced.

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
within 24 hours or be marked superseded by a named file (a
`-- SUPERSEDED BY <version>` first line, or a registry row for a pinned file). It runs trusted code from
the default branch only, reads nothing from the branch but its filenames, and
has no schedule. `tests/an-installed-migration-and-its-file-agree.law.test.ts`
pins the alias table, the grace, the marker and the workflow's shape.

## Update, 2026-10-02

The 52 apply-time pairs and the September recoveries were recorded on `main`
by the mirror bands (#5501 to #5508), so the alias table now holds no rows;
its loader, its `superseded` section and both gates' support for it remain.
Re-measured against all 5,234 rows of `schema_migrations`: 15 migrations
installed between 2026-09-27 and 2026-10-01, more than 24 hours old, still had
no file on `main`. Thirteen are recorded here headerless and byte-equal to
`fn_ca_migration_text`, each with a manifest row. Their authored copies sit on
pull requests idle since 2026-09-27/28 (#5450, #5460, #5467, #5479, #5481,
#5482, #5484, #5521, #5532), which can drop them on their next merge of
`main`. Two are held back for their owners because a byte-exact record would
break a law the owner must settle: `20260927154806` (open-week recompute
lock, #5450) replaces the definition that
`a-page-waits-for-its-witness-before-it-holds-anything` and
`a-page-cannot-certify-an-unfinished-week` read, and `20260927221321`
(horse stack-off audit schedule, #5484) schedules periodic work without the
`-- periodic-work:` line `no-band-aids` requires.
