# Sentry Residue After The First Purge (2026-09-27)

## Why

Dan closed and deleted the Sentry account on 2026-09-27 and ordered every trace
removed. #5483 (`docs/changelog/2026-09-27-sentry-is-gone.md`) carried the
first purge: the migration that drops every catalog object naming Sentry, the
two laws, and the probe that replayed the 2026-09-17 archive. Autopilot merged
it at 22:42 UTC while this review was still running. This change carries what
that review found afterwards, and records what was verified outside the
repository.

## Database

- `20260927224816_the_archive_keeps_no_sentry_cap.sql` deletes the one row of
  DATA that still named Sentry: `ca_archive.autofix_budget` held the retired
  autofix pipeline's three archived daily caps (`_global` 1.6000, `sentry`
  1.0000 "Sentry runtime-error autofix.", `vercel` 0.6000). The `sentry` row
  is the configuration of a provider that no longer exists, not a record, so
  it goes; the table and its other two rows stay, because the Vercel
  build-failure loop was never Sentry's. No DDL, one transaction, lock
  timeout, pre-image asserted on all three rows and post-image on the two
  that remain. Independent of 20260927212653.
- 20260927212653 (merged in #5483, not yet applied when this was written) was
  re-verified against production at 22:34 UTC, read-only: all three function
  pre-images (md5, owner, ACL, proconfig, SECURITY DEFINER, volatility) match;
  each new body differs from the live one only on the line that named Sentry;
  `retired_error_telemetry_20260916` holds exactly 8 relations and no
  functions; the sequence is owned by its table column, so the non-CASCADE
  drops succeed; nothing else depends on the dropped objects (pg_depend);
  the `signup_errors` policies are `true`/`true` and name no column; no
  policy, trigger, view, cron job, vault secret, type or description names
  Sentry apart from the objects that migration drops or rewrites.

## Repository

- `scripts/ci/supabase-columns-manifest.json` no longer lists
  `forwarded_to_sentry` on `signup_errors` or `signup_errors_archive`, so the
  column snapshot matches the schema 20260927212653 leaves. The fragment
  overlay has no column tombstone and no source in this repository selects the
  column, so the phantom-column gate loses nothing; the nightly refresh
  regenerates the base from production once the migration is applied.
- `tests/the-database-keeps-nothing-of-sentry.law.test.ts` also pins the new
  migration: one transaction, a lock timeout, no DDL, exactly one DELETE with
  its WHERE, asserted before and after.
- What stays, and why:
  - `scripts/ci/schema-manifest.d/retired-error-telemetry.json`: the tombstone
    that refuses a reference to the retired tables.
  - `scripts/qualification/horse-league-process-priority-native.mjs`: refuses
    any `SENTRY` key in a horse process environment. A guard.
  - Applied migrations and dated changelogs: history.
  - The captured production schema dumps under
    `tests/fixtures/full-weekly-accounting/`,
    `scripts/ci/fixtures/mtt-unlimited/`, `scripts/ci/probes/spin-expiry/inputs/`,
    `scripts/ci/probes/production-alert-core/notification/inputs/` and
    `scripts/ci/probes/bbj-bank-replay/funded/source/*/build/` still carry the
    2026-09-14 column and sequence names. They are sha256-pinned evidence
    captures bound by source-binding manifests, the same kind of history as
    an applied migration, and are not edited.
  - `MIGRATION-CHANGELOG.md` and `docs/HANDOFF-2026-09-03-club-operations-upgrade.md`
    each name the path of the 2026-09-16 restoration archive
    (`.../sentry-removal/...`). Frozen history; the archive itself was removed
    from the engine host today.
- Every other case-insensitive `sentry` hit in `src/`, `server/src` and
  `tests/` is a camelCase identifier (`hasEntryCapacity`, `ownsEntry`,
  `LightningDiagnosisEntry`, `DiamondGamesEntry`, `WheelBonusEntryService`,
  `authenticatesEntryPredicate`); none names Sentry. The same is true of the
  one `sentry` string in the running engine's
  `/app/dist/services/TournamentBrainContext.js`.
- No `_agent_tmp/wh-horses-snapshot/` exists in the repository (`_agent_tmp/`
  is gitignored and untracked, absent from `origin/main`) or anywhere under
  `~/Documents` on the Mac (find to depth 6, Spotlight). Nothing to delete
  and nothing references it.

## GitHub Actions (Smarter-Poker-Club-Arena)

- No `SENTRY_*` secret or variable existed (21 secrets, 8 variables listed).
- Deleted `AUTOFIX_GITHUB_TOKEN` and `ANTHROPIC_API_KEY` from the repository's
  Actions secrets: both were introduced by 12eed62945 (Phase 5.2.0, the
  Sentry-to-Claude autofix loop), their last workflow reference left in
  #4189, and nothing in `.github/`, `scripts/`, `src/` or `server/src` names
  either. Deleting the secrets does not revoke the underlying tokens.

## Engine Host (read-only, 22:30 UTC)

- `/opt/club-arena` is a clean `main` checkout at 52c99680fd (the release
  fetches `origin/main` into it); `services/sentry-autofix` is gone;
  `grep -ci sentry server/.env` is 0; none of the six `.env.bak*` files names
  Sentry; `/root/env-backup-20260927` holds the pre-edit copies at mode 600.
- The running container (`e6b9dc5d`, image 9ae87ba8cf21, up since 20:56 UTC)
  has no `SENTRY` environment entry, no `node_modules/@sentry` and no `sentry`
  in `package.json`. The staged image `a1077c7c` has none in `node_modules`,
  `package.json` or `package-lock.json`. No `previous` or `ba4c666b` image
  remains. No systemd unit or cron file names Sentry. The
  `restoration-archive-20260916/sentry-removal` directory is gone.

## World Hub (reported, not changed)

- `main` (pushed 21:47 UTC) has no `@sentry/*` in `package.json` or
  `package-lock.json`, no `pages/api/cron/sentry-signup-bridge`, no Sentry
  config file, workflow or env template, and GitHub code search finds no
  source reading `forwarded_to_sentry`; its
  `/api/cron/archive-signup-errors` still calls `archive_signup_errors(30)`,
  whose signature 20260927212653 keeps. The only `sentry` matches are seven
  historical migrations.
- The Vercel project `hub-vanguard` has no `SENTRY_*` environment variable
  among its 55. `ANTHROPIC_API_KEY` and `AUTOFIX_CLAUDE_MODEL` are read by the
  live Vercel build-failure autofix (`pages/api/deploy-autofix.js`), which is
  not Sentry's; `AUTOFIX_GITHUB_TOKEN` is set there too. The `club-arena`
  Vercel project has no environment variables.
