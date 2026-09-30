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
  audit. Neither repository reads it.
- Dropped `signup_errors.forwarded_to_sentry`, its partial index
  `signup_errors_pending_forward_idx`, and
  `signup_errors_archive.forwarded_to_sentry`. The only writer (World Hub
  `/api/cron/sentry-signup-bridge`) is gone; the last write was 2026-09-14.
- `archive_signup_errors` no longer copies that column. Same rows move.
- `orb1_buyin_transaction` (a deprecated stub that only raises) and
  `fn_ca_stranded_completing_tournaments` lose the words that named Sentry,
  in a code comment and in one detail literal. Nothing else changes; each is
  replaced over its exact production pre-image with a post-image assertion.
- The comments on `fn_ca_stranded_completing_tournaments` and
  `client_crash_log` no longer name Sentry.

## Repository

- `tests/sentry-never-comes-back.law.test.ts`: no package.json or lockfile may
  declare or resolve a Sentry package, no source file may import one, and no
  workflow, env template or Docker file may configure a `SENTRY_` key.
- `tests/the-database-keeps-nothing-of-sentry.law.test.ts` pins the migration.
- Removed the chip-journal probe that replayed the 2026-09-17 telemetry
  archive migration; the archive it preserved no longer exists.
- Deleted 19 stale remote branches named after Sentry work (no open PRs).
- Applied migrations and dated changelogs stay: they are history.
- `scripts/qualification/horse-league-process-priority-native.mjs` still
  refuses any `SENTRY` key in a horse process environment. That is a guard.

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
- The running engine (`e6b9dc5d`) was not touched.
