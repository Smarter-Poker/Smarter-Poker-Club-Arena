# A refusal that cannot change is not a serialization failure (2026-10-07, #6326)

## The outage

From 2026-10-06 15:36 to 2026-10-07 01:14 UTC, PostgREST stopped answering for
5 to 12 minutes roughly once an hour. In each window almost every request in
the project got HTTP 504 `PGRST003` (pool acquisition timed out), up to 9,720 a
minute, and the engine's own calls failed first. The windows (from
`postgrest_logs`, 504s per minute above 1,000): 15:36, 16:56, 17:50, 18:44,
19:52, 20:44, 21:49, 22:45, 23:39 and 01:00-01:12. They do not line up with
the :55 break, and there were none before 15:33 on 10-06 or after 02:06 on 10-07.

## The cause

`postgres_logs` held 3,467,664 copies of one error, at about 100 a second,
from 15:33:11 on 10-06 to 02:06:00 on 10-07, and nothing else at that rate:

    observed winner ca905025-... does not match locked winner <NULL>
    for tournament 62a15104-...
    sql_state_code 40001, application_name "PostgREST 14.5", user authenticator
    context fn_settle_tournament_places line 196 <- fn_complete_tournament_terminal_pre_seat_guard
            <- fn_complete_tournament_terminal (the engine's terminal RPC)

The engine sent that RPC about ten times a minute. The other 99 per second were
PostgREST's own. PostgREST 14 treats SQLSTATE 40001 as a transient
serialization failure and re-runs the whole request transaction on the same
connection until it stops failing; it never returns the 40001, and no
statement timeout ends it because every attempt is a new statement. Supabase
documents this as a PostgREST 14 bug, fixed in PostgREST 16. This project runs
PostgREST 14.5 with a 41-connection pool.

The refusal could never stop failing. It runs after `FOR UPDATE` on the whole
roster, so it compares committed, locked rows. Every engine request it
answered therefore pinned one pool connection permanently. Counting distinct
backends raising it, per minute: 22 at 00:30, 33 at 00:42, 39 at 00:53, 40 at
01:02. At the pool size every other request queued for 10 s and got a 504; at
01:12-01:14 PostgREST recycled (a 26,840-request 503 burst), the count dropped
to 2 and began to climb again, one a minute. That is the "about hourly, but
drifting" period: the time to leak 40 connections.

The tournament: 62a15104 was a three-player PLO4 Spin. At 15:33:04 a platform
retirement (the event later handled by 20261006182937 and the retained-seat
recovery) marked its two live players eliminated with no elimination sequence.
Its manager then found no live player and named the only sequenced bust,
ca905025 (third place, 15:29), as the winner. The database correctly refused
that, but with 40001. When the event's chairs were restored it resumed at
02:06:22, which ended the refusal and the loop, and it completed at 02:09:09
through the platform's own terminal authority: face0000-...0007 first (150.00,
the whole 100% pool), 00000000-...0025 second, ca905025 third. Nobody was paid
twice or short, so there is nothing to settle.

The 2026-09-10 bursts of `terminal replay parameters disagree with stored
receipt` (50-80 a second) were the same retry. They ended only because the
manager fence made the request's pre-request hook raise 42501 instead.

## The fix

`20261007071300_a_refusal_that_cannot_change_is_not_a_serialization_failure`
moves the twelve refusals that compare a caller's observation with a durable or
locked record from SQLSTATE 40001 to 55000 (object_not_in_prerequisite_state,
which these functions already use for their other state refusals):

| function                                           | refusal                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| fn_settle_tournament_places                        | observed winner does not match locked winner             |
| fn_settle_satellite_tournament_pre_money_path_gate | observed winner does not match the locked last survivor  |
| fn_settle_tournament_bubble_protection             | observed bubble user does not match durable place        |
| fn_complete_tournament_terminal_pre_seat_guard     | terminal replay parameters disagree with stored receipt  |
| fn_complete_tournament_terminal_pre_seat_guard     | mystery evidence receipt conflicts with canonical proof  |
| fn_resolve_tournament_terminal_outcome             | terminal outcome parameters disagree with stored receipt |
| fn_ca_tournament_terminal_receipt                  | receipt winner differs from observed winner              |
| fn_resolve_satellite_settlement_outcome            | satellite outcome winner disagrees with stored receipt   |
| fn_ca_satellite_settlement_receipt                 | satellite receipt winner differs from observed winner    |
| fn_ca_satellite_cohort_receipt                     | satellite cohort receipt identity differs                |
| fn_ca_tournament_cancellation_receipt              | cancellation actor disagrees with stored receipt         |
| fn_poker_diamond_tournament_cancellation_receipt   | cancellation actor disagrees with stored receipt         |

Each body is read from `pg_get_functiondef`, pinned by md5, and only the
SQLSTATE literal of that one RAISE changes; the reverse substitution must
reproduce the pinned text, so nothing else can move. Owner, SECURITY DEFINER,
search_path and grants are kept by `CREATE OR REPLACE`. Messages are unchanged.

What the engine sees now: the refusal comes back in milliseconds as a SQLSTATE.
`requestTournamentTerminalReceipt` already treats that as a database-stated
rollback, makes its bounded attempts, asks the serialized resolver, and raises
`TerminalSettlementRefusedError`, which the manager handles by trying again on
its next pass. The receipt-disagreement texts it already matches
(`adoptStoredTerminalReceipt`) are now actually delivered to it. No engine
change, so no engine release.

Not changed: 40001 for a lost compare-and-set or a busy lane
(`F06_RETRY_CANONICAL_LANE`, `... CAS changed % rows`, `... lost its claim`).
There a retry re-reads state another transaction is changing and stops when it
commits. Those still cost a busy-wait under PostgREST 14, but they end.

## The pin

`tests/a-refusal-that-cannot-change-is-not-a-serialization-failure.law.test.ts`
pins the twelve moves and refuses any later migration that raises a
"does not match / disagree / differs / conflicts with" refusal as 40001 or 40P01.

## Probe

Before applying, one `execute_sql` call ran the whole substitution without the
`EXECUTE`, against the live definitions, ending in `RAISE EXCEPTION`. It
returned `PROBE_OK moved 12 refusals` with each new RAISE text. No DDL.
