# 2026-09-24 - Tournament creation refuses what the client refuses (database)

## What changed

Migration `20260924033701_tournament_creation_refuses_what_the_client_refuses`
adds `public.fn_tournament_config_refusal(p_config, p_surface)`, which returns
the first rule a configuration breaks (the same machine codes the client
validator uses) or NULL. `fn_create_tournament` calls it for surface `create`
after authorisation and before anything is written, and
`fn_upsert_tournament_schedule` calls it for surface `schedule` only when the
stored configuration changes. The migration touches no rows.

`ci.yml` gains the step "Tournament creation refuses what the client refuses",
which runs `scripts/ci/test-tournament-creation-rules.py` against PostgreSQL
17 over the shared case table
`scripts/ci/fixtures/tournament-creation-rules/cases.json`. Because `ci.yml` is
a pinned cash qualification input, its pin in
`scripts/qualification/cash-native-hosted.manifest.json` moves to the new bytes
with a `tournamentCreationRulesIntegration` note; cash SQL and immutable
capture inputs are unchanged.

## Why

The creation forms refused configurations the engine cannot run (a satellite
with no target, a rebuy with no late window, a past start, more seats than one
deck deals, a falling Sit And Go ladder, a non-positive stack), and a direct
call to the same RPC accepted every one of them. Schedules were not validated
until the spawner used them.

## Evidence

- `scripts/ci/test-tournament-creation-rules.py` (PostgreSQL 17, in CI).
- `tests/unit/tournamentCreationRulesSqlParity.test.ts`: every `RETURN` code of
  the SQL rule is in the case table, the migration is pinned to the newest repo
  post-images, both authoring RPCs call the rule, and no row is written.

## Still pending

Installation on production. The client half (the shared validator and its
sentences) ships in its own change.
