# A seat-exit guard without its consumer refuses nothing

2026-09-11 · database (`20260911081910`), applied to production 08:22:40 UTC

## What happened

From about 05:05 UTC, no tournament with a seated winner could finish.
Every finish was refused with:

    [Tournament.atomic_finish_refused] TerminalSettlementRefusedError:
      tournament seat-exit authority left 1 live seat(s) unconsumed  (P0404)

The engine logged 532 of these in the 75 minutes before 08:15, and 0
`COMPLETE - winner`. Each refusal was replayed five times, and every replay
took the settlement lane's global lock, so the refusals also slowed hand
settlement everywhere:

- hand commits were waiting on advisory locks in about half of all samples;
- the main event loop reached p50 ~450 ms;
- the elimination queue grew past 600, with the oldest entry waiting 20
  minutes.

## Why

At 05:05, `20260911050554` from `agent/codex-live-realtime/stage-b-clean-v3`
(`ee3e351c6d`, not on main) was applied. It wrapped
`fn_complete_tournament_terminal` in the seat-exit authority from
`20260909014545`. On success, that wrapper requires every authorization row
to be consumed.

Exactly one thing consumes those rows: the trigger
`zy_tournament_live_seat_exit_requires_authority` on `table_seats`.
Production has never had that trigger:

- `20260909014545`, the cutover that installs it, was never applied.
- `20260910051125` explains why the trigger cannot be installed on its own.

So every successful finish left its winner's row behind, and the close
raised. `20260910051125` had already hit the same trap for
`fn_move_tournament_player`, and fixed that one call site by passing `false`.
`fn_ca_settle_bounty_rebuy_generation_v1` (`20260911052648`) has the same
shape.

## The fix

The fix goes in the guard itself, not in each call site.
`fn_ca_close_tournament_seat_exit_authority` still counts and deletes the
rows and clears the session settings, byte for byte. It now raises only when
the consumer trigger exists and is enabled (`tgenabled` `O` or `A`).

- Without the consumer, requiring consumption can only refuse the exit it was
  opened for.
- With the consumer, the requirement is back automatically, with no
  migration and no call-site edit.
- No wrapper was replaced, so the md5s the Stage-B preflights pin still
  match.

## Verified

Local PostgreSQL 17, starting from the exact production body (md5
`0811b7a7…`):

- no consumer: returns 1 and deletes the row;
- consumer enabled: raises P0404;
- consumer disabled: returns 1;
- `false`: returns 1;
- nothing left: returns 0;
- re-applying is a no-op.

Production, 08:22:40 UTC, in one transaction with `lock_timeout 5s`:

- the preflight md5 matched;
- the postflight confirmed owner, SECURITY DEFINER, search_path and ACL are
  unchanged;
- the version was recorded in `schema_migrations`.

Forty seconds later, 28 tournaments had completed.

## Pinned by

`tests/a-seat-exit-guard-needs-its-consumer.law.test.ts`. The newest
definition of the close must keep its raise conditional on the consumer.
