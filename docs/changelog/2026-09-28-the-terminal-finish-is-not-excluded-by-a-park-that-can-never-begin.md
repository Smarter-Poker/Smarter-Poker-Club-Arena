# The terminal finish is not excluded by a park that can never begin (2026-09-28)

Stream `stuck-0926`. Builds on PR #5474 (its fixture and probe harness) and
narrows its predicate.

## What was wrong

bfcfaf17 "DSS Thursday $5.50 NLH Turbo" was decided on 2026-09-18 05:17 UTC:
heads-up won, winner f9e96cd6 holds all 168,000 chips on table 0cfc4303, the
event's last open table. It is still RUNNING, and the winner has never been
paid (40.02 of the 63.00 pool). Engine 41b91390 logs "is decided (1 playing) -
recovering the winner" every ~20 seconds.

Rolled-back production probe, 2026-09-28 04:15 UTC:
`fn_complete_tournament_terminal(bfcfaf17, f9e96cd6, 'places')` refuses
`F06_SOURCE_EXCLUDED`, raised by trigger `a00_f06_source_roster`
(`smarter_private.f06_source_guard`, line 97) on `fn_settle_tournament_places`'
own winner flip. The table carries f06_operations break 544dc515:
`park_requested`, no manifest, no admission, member, attempt, close, cleanup or
abort; revision 2, custody claimed by the live lease generation 84e15465. The
balancer requested the park 22 seconds before the final hand; that hand ended
the event, so the park can never begin.

## Why not unbind every bare park

PR #5474 treats every such bare row as unbound for every writer. But every
live `park_requested` row is bare until it begins (27 of 27 in the last two
days, the newest minutes old): the manifest is written at begin. That change
would re-admit all ordinary seat and registration writes to a source table
between the balancer's request and its begin, the window the guard exists for.

## What changes

`f06_source_guard`'s `bound` test does not count a bare pre-manifest park of
the same event while the writer is that event's own terminal settlement:
`app.tournament_seat_exit_operation = 'terminal_finish'` and a
`terminal_finish` row in `tournament_seat_exit_authorizations` for this
tournament carrying the transaction's token. `fn_complete_tournament_terminal`
opens both, under the finish lane, before it settles. Everything else is
byte-identical.

No money is written by the migration. After it is installed, the engine's own
decided recovery calls `fn_complete_tournament_terminal`, which pays through
`tournament_terminal_settlements` (it reads its own receipt first), once.

Residue, deliberately left: break 544dc515 stays `park_requested` on a
COMPLETED event. Nothing can begin it; it is recorded here rather than closed by
a hand-written state change.

## Proof

`runuser -u postgres -- bash scripts/dev/probe-f06-terminal-finish-bare-park-pg16.sh`
(throwaway PostgreSQL 16, the exact production pre-image be484837):

```
OK refused: pre-image, terminal authority, winner flip
OK allowed: terminal authority, winner flip and seat exit
OK refused: no authority at all
OK refused: no authority, seat exit
OK refused: terminal GUC with no authorization row
OK refused: terminal authority of another event
OK refused: a move authority
OK refused: terminal GUC over a move authorization row
OK refused: a park with a member (begin evidence)
OK refused: a begun park with a manifest
ALL PROOFS PASSED
```

Not executed against production: a trigger body cannot be swapped inside a
rolled-back probe without DDL (CLAUDE.md section 2 rule 3). The production
refusal it removes was probed; the new body was run only in the local cluster.

Law: `tests/the-terminal-finish-is-not-excluded-by-a-park-that-can-never-begin.law.test.ts`.
