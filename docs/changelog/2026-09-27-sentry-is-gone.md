# Sentry Is Gone From The Engine, The Repository, The Database And The Host (2026-09-27)

## Why

Dan closed and deleted the Sentry account on 2026-09-27 and ordered Sentry
removed everywhere, with nothing left. The SDKs had already left the engine and
the app on 2026-09-15/16 (#4718, 397fe26e58); nothing has been sent since.
This change removes what was still standing.

## Database (20260927212653_the_database_keeps_nothing_of_sentry.sql)

- Dropped schema `retired_error_telemetry_20260916` (the archived error log,
  event budget and fingerprint tables, all empty, and their sequence).
- Dropped `ca_archive.autofix_attempts`, the retired Sentry-to-Claude autofix
  audit (1868 rows: 891 sentry, 880 unsourced, 97 vercel). Neither repository
  reads it.
- Deleted the one `source = 'sentry'` row from `ca_archive.autofix_budget`
  (the Sentry loop's archived daily cap). The table and its `_global` and
  `vercel` rows stay; the Vercel build-failure loop was never Sentry's.
- Dropped `signup_errors.forwarded_to_sentry`, its partial index
  `signup_errors_pending_forward_idx`, and
  `signup_errors_archive.forwarded_to_sentry`. The only writer (World Hub
  `/api/cron/sentry-signup-bridge`) is gone; the last write was 2026-09-14.
- `archive_signup_errors` no longer copies that column. Same rows move. The
  World Hub cron `/api/cron/archive-signup-errors` keeps calling
  `archive_signup_errors(30)` with the same signature.
- `orb1_buyin_transaction` (a deprecated stub that only raises) and
  `fn_ca_stranded_completing_tournaments` lose the words that named Sentry,
  in a code comment and in one detail literal. Nothing else changes; each is
  replaced over its exact production pre-image with a post-image assertion.
- The comments on `fn_ca_stranded_completing_tournaments` and
  `client_crash_log` no longer name Sentry.

Re-verified against production at 22:34 UTC, read-only: all three function
pre-images (md5, owner, ACL, proconfig, SECURITY DEFINER, volatility) still
match; each new body differs from the live one only on the line that named
Sentry; the schema holds exactly 8 relations and no functions; the sequence
is owned by its table column, so the non-CASCADE drops succeed; nothing else
depends on the dropped objects (pg_depend); no policy, trigger, view, cron
job, vault secret, type or description names Sentry apart from the objects
this migration drops or rewrites.

## Repository

- `tests/sentry-never-comes-back.law.test.ts`: no package.json or lockfile may
  declare or resolve a Sentry package, no source file may import one, and no
  workflow, env template or Docker file may configure a `SENTRY_` key.
- `tests/the-database-keeps-nothing-of-sentry.law.test.ts` pins the migration.
- `scripts/ci/supabase-columns-manifest.json` no longer lists
  `forwarded_to_sentry` on `signup_errors` or `signup_errors_archive`, so the
  column snapshot matches the schema the migration leaves. The fragment
  overlay has no column tombstone, and the nightly refresh regenerates the
  base from production after the migration is applied.
- Removed the chip-journal probe that replayed the 2026-09-17 telemetry
  archive migration; the archive it preserved no longer exists.
- Deleted 19 stale remote branches named after Sentry work (no open PRs);
  stale Sentry pull requests #3049, #2957, #991 and #4684 were closed.
- Applied migrations and dated changelogs stay: they are history.
- `scripts/ci/schema-manifest.d/retired-error-telemetry.json` stays: it is the
  tombstone that refuses a reference to the retired tables.
- `scripts/qualification/horse-league-process-priority-native.mjs` still
  refuses any `SENTRY` key in a horse process environment. That is a guard.
- The captured production schema dumps under
  `tests/fixtures/full-weekly-accounting/`, `scripts/ci/fixtures/mtt-unlimited/`,
  `scripts/ci/probes/spin-expiry/inputs/`,
  `scripts/ci/probes/production-alert-core/notification/inputs/` and
  `scripts/ci/probes/bbj-bank-replay/funded/source/*/build/` still carry the
  2026-09-14 column and sequence names. They are sha256-pinned evidence
  captures (source-binding manifests), the same kind of history as an applied
  migration, and are not edited.
- Every other case-insensitive `sentry` hit in `src/`, `server/src` and
  `tests/` is a camelCase identifier such as `hasEntryCapacity`,
  `ownsEntry`, `LightningDiagnosisEntry`, `DiamondGamesEntry` or
  `WheelBonusEntryService`; none names Sentry.
- No `_agent_tmp/wh-horses-snapshot/` exists in the repository (the directory
  is gitignored and untracked) or anywhere under `~/Documents` on the Mac.

## GitHub Actions

- No `SENTRY_*` secret or variable existed on Smarter-Poker-Club-Arena.
- Deleted `AUTOFIX_GITHUB_TOKEN` and `ANTHROPIC_API_KEY` from the repository's
  Actions secrets: both were introduced by 12eed62945 (Phase 5.2.0, the
  Sentry-to-Claude autofix loop), their last workflow reference left in
  #4189, and nothing in `.github/`, `scripts/`, `src/` or `server/src`
  names either. The underlying tokens are not revoked by this.

## Engine Host

- `/opt/club-arena` is the release object store (the release fetches
  `origin/main` into it and builds from `git archive`), so its checkout was
  fast-forwarded to `origin/main`, which removes `services/sentry-autofix`
  and the old Sentry dependencies the proper way.
- The Sentry comment left in `server/.env` and the `SENTRY_DSN` lines left in
  its six `.env.bak*` files were removed (backups in
  `/root/env-backup-20260927`, mode 600, Sentry lines stripped).
- Removed the stale `server/node_modules` install, the `previous` and
  `ba4c666b` engine images (the only images that still carried the SDK), the
  two retired buildx builders (`v1`, `v2`) and their caches, the default
  builder cache, and `restoration-archive-20260916/sentry-removal`.
- The running engine (`e6b9dc5d`) was not touched. Re-verified at 22:30 UTC:
  its container has no `SENTRY` environment entry, no `node_modules/@sentry`
  and no `sentry` in `package.json`; the staged image `a1077c7c` has none in
  `node_modules`, `package.json` or `package-lock.json`; no systemd unit or
  cron file names Sentry.

## World Hub (reported, not changed)

- `main` (pushed 2026-09-27 21:47 UTC) has no `@sentry/*` package in
  `package.json` or `package-lock.json`, no `pages/api/cron/sentry-signup-bridge`,
  no Sentry config file, workflow or env template, and GitHub code search
  finds no source that reads `forwarded_to_sentry`. The only `sentry` matches
  are seven historical migrations.
- The Vercel project `hub-vanguard` has no `SENTRY_*` environment variable.
  Its `ANTHROPIC_API_KEY` and `AUTOFIX_CLAUDE_MODEL` are read by the live
  Vercel build-failure autofix (`pages/api/deploy-autofix.js`), which is not
  Sentry's; `AUTOFIX_GITHUB_TOKEN` is set there too.
