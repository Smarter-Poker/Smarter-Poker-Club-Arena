# 2026-09-24 - Tournament creation rules: one list on every client surface

## What changed

`src/lib/tournamentCreationRules.ts` is now the single list of tournament
configuration rules the client applies. The Create Game modal, the
table-config page (`buildTournamentConfig`) and the recurring schedule editor
(`TournamentScheduleService.upsert`) all funnel their `p_config` through
`tournamentRpcConfigRefusal`, and every refusal code, from the client or from
the database, becomes one Title Case sentence through
`tournamentCreateErrorMessage` / `tournamentCreateDbErrorMessage`.

Where the surfaces used to disagree, the server's rule won: payouts must total
within 1 of 100 (the modal used 0.5; the service skipped a zero total), a past
start is refused everywhere (the table-config page silently replaced it with
now), a satellite needs a target, a rebuy or re-entry needs an open late
window, the seat count must fit one deck, a Sit And Go or Spin ladder may not
fall, and a starting stack must be positive.

## Why

Three copies of the rules disagreed with each other and with the database, so
an owner could build a configuration on one page that another page, or the
engine, refused.

## Evidence

- `tests/unit/tournamentCreationRules.test.ts` runs the validator against the
  shared case table `scripts/ci/fixtures/tournament-creation-rules/cases.json`
  and exercises all three surfaces.
- `tests/components/tournamentCreationRulesModal.test.tsx` covers the modal's
  live checks.
- The assertions that read the database migration itself (every SQL refusal
  code is in the case table, and the pinned post-images) moved to
  `tests/unit/tournamentCreationRulesSqlParity.test.ts`, which ships with the
  migration in the database candidate, so this client change is self-contained.

## Still pending

The database side (migration `20260924033701_tournament_creation_refuses_what_the_client_refuses`)
ships separately and is not installed yet. Until it is, a direct RPC call can
still create what the client now refuses.
