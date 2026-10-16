# Recorded Anti-Cheat Exemption, Anon Revoke And Cron Roster (2026-10-16)

## What Was Wrong

- `20261015170348_anti_cheat_multi_account_exemptions_beta_testers` and
  `20261015184608_cashout_messages_still_reach_players_and_agents` were applied
  to PokerIQ-Production on 2026-10-15 but their files sat in PR #7028 for twelve
  hours, red on `Supabase Invariants - New Migrations Were Applied`, because no
  schema-manifest fragment declared `anti_cheat_exemptions` or
  `fn_anti_cheat_flags_skip_exempt`.
- That migration left Postgres's default `EXECUTE` grant on the new SECURITY
  DEFINER trigger function, so the hourly Production Integrity Audit reported
  `anon_definers=1`: the one anon-executable definer not on
  `docs/security/anon-executable-definers.json`.
- `20261016040716_sp_daily_digest` (#7070) scheduled `sp-daily-metrics-snapshot`
  and `sp-daily-digest-watchdog` without moving the scheduled-work roster, so
  Cron Health failed with "A pg_cron job appeared or vanished on production".

## What Changed

- `scripts/ci/schema-manifest.d/anti-cheat-exemptions.json` declares the table
  and trigger function until the nightly base snapshot absorbs them.
- `20261016100351_the_anti_cheat_exemption_trigger_is_not_callable_by_anon`
  revokes `EXECUTE` from `PUBLIC`, `anon` and `authenticated`, with an in-transaction
  readback. Applied to production at 10:03 UTC; the live anon-executable definer
  set is now exactly the 24 allowlisted signatures. The trigger still fires with
  the definer's rights, so KingFish and Danimal remain exempt.
- `docs/attestation/cron-roster.tsv` and `ACTIVE_JOBS` move 134 -> 136 for the
  two digest jobs, read live (`cron.job`: 138 total, 136 active).
