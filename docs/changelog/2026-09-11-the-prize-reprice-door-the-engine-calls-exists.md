# The prize reprice door the engine calls exists

2026-09-11 · database (`20260911090347`), applied to production 09:05:09 UTC

## What happened

The engine recalculates place prizes while an event runs. It certifies every
changed prize through `fn_ca_reprice_unpaid_tournament_place`, and when that
call fails it refuses the finish ("atomic completion will refuse an
incomplete prize set").

Since #4066 and #4105 the deployed engine has called that function, but
production never had it. It is defined only in
`20260910000905_final_tournament_roster_seat_authority_after_scheduler_fence`,
part of the M6 seat-authority cutover, which was never applied. The
phantom-reference gate did not catch this, because a schema-manifest
fragment (`codex-final-tournament-roster-seat-authority.json`) declared the
function in advance.

At 09:01 UTC the engine logged this for fe72385b, whose standings had been
corrected to true bust order at 08:38:

    prize recalc could not certify prize=54.45 for fb7da841: Could not find
    the function public.fn_ca_reprice_unpaid_tournament_place(...) in the
    schema cache

## The fix

The function is installed verbatim from `20260910000905` (lines 2129-2243),
with one change marked `HOTFIX EDIT`: it takes this tournament's settlement
lane (`fn_ca_lock_settlement_lane_for_tournament`) instead of the raw global
key. That matches `20260910035245` and the `20260910051125` hotfix of
`fn_move_tournament_player`.

Nothing else from that cutover is included. In particular, its
`REVOKE ... ON tournament_players FROM service_role` is left out. Nothing
existing is replaced or dropped.

## Verified

Local PostgreSQL 17 fixture:

- a compare-and-set reprice succeeds;
- a stale expected prize is refused (40001);
- a non-RUNNING event is refused (55000);
- place evidence is refused (55000);
- negative or fractional cents are refused (22023);
- re-applying is a no-op.

Production, one transaction with `lock_timeout 5s`:

- the dependencies' preflight passed;
- the postflight confirmed md5 `691a3f79…`, SECURITY DEFINER, owner and
  search_path;
- service_role can execute it; anon and authenticated cannot;
- the version was recorded in `schema_migrations`.

## Also checked

Every `.rpc('…')` name in `server/src` and `src` was compared against
production's `pg_proc`. The only other name missing from production is
`fn_sweep_seatless_late_registrants`, which was dropped on purpose on
2026-09-08, and no runtime code calls it.
