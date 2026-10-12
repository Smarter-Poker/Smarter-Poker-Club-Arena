# A Late Ticket Entry Expects The Running Count

## What Happened

On 2026-10-11 from 17:50 to 18:53 UTC the database ran out of API connections. PostgREST answered simple reads with PGRST003 ("Timed out acquiring connection from connection pool") and 504s, and the engine logged thousands of schema cache and supabase_timeout failures a minute.

Postgres logged `F06_RETRY_CANONICAL_LANE` (normally 300 to 1,400 per 15 minutes) about 6,000 times a minute, and `ticket admission tournament cache changed` 22,401 times, both with SQLSTATE 40001.

## Root Cause

1. `fn_ca_register_for_tournament_with_ticket_for` (the ticket door, 2026-09-09) checks its write with `current_players = v_players_before + 1`, a count only the pre-start roster trigger produces. Since 20260922141704 that trigger leaves a RUNNING field alone on INSERT and the door that admits a late entrant publishes the count. The wallet doors moved to that rule (`v_expected_cached_players`); the ticket door did not. Every late ticket entry was refused: 0 of 1,413 ticket admissions since the door was written were late.
2. The refusal carried SQLSTATE 40001. PostgREST 14.5 re-runs a request whose transaction ends in 40001, without limit, holding its pool connection the whole time.
3. Sunday 200 Deep Stack (6561f9f4) started 17:00 with two hours of late registration. Three satellite tickets for it were issued at 17:31:34. The horse late-registration pass (TournamentRecurringService.registerHorses, every five minutes) offered the five ticket holders a seat. Each call became a request that never ended: ten backends re-ran it 22,401 times.
4. Every re-run took the event's exclusive settlement lane. Every hand write on its tables (`insert_hole_cards`, `save_hand_state_snapshot`, `fn_ca_process_hand_post_commit_obligations`, `fn_project_hand_side_effects`) found the lane held and raised `F06_RETRY_CANONICAL_LANE`, also 40001, also re-run. 40 to 60 connections spun.
5. It stopped twice at :53 because the entry freeze makes the door answer `platform_frozen` before it reaches the failing check: the first wave ran 17:50:22 to 17:53:00, the second 18:10:31 to 18:53:15 (with a two-minute gap at 18:45 when no ticket call was in flight, during which the lane refusals fell from about 5,800 to 82 a minute).

## What Changed

- 20261011185301 (PR #6666, another lane) moved the F06 lane raises to 55P03 and the two ticket raises to 55000, so PostgREST no longer re-runs them.
- 20261012031813 (this change) gives the ticket door the same expectation the wallet doors hold: one more before the start, unchanged once RUNNING. Nothing else in the door changes.
- The horse registration pass now defers a horse whose entry came back as an error (10 minutes, doubling to an hour, with jitter), and stops the pass when the database did not answer at all (timeout, exhausted pool, dropped connection), instead of queueing one more request per horse.
- `insert_hole_cards` retries wait a jittered 100 to 400 ms instead of a fixed 150 and 300 ms, so the tables of one event refused together do not return together.

## Play Impact

- Hands dealt per minute: 849 from 17:00 to 17:50, 869 from 18:00 to 18:15, 497 from 18:15 to 18:50 (down 41 percent), 946 from 19:00 to 19:30.
- No table stopped: every table that dealt after 18:05 and closed before 19:30 belonged to a finished Spin, Sit And Go or a broken MTT table. The longest gap on a table that kept dealing was 2 minutes 27 seconds.
- No tournament stalled: all 918 tournaments dealing before 18:15 dealt during 18:15 to 18:50 or had finished.
- The five Sunday 200 Deep Stack ticket holders were never seated. Their tickets are still `issued` for an event that has completed.

## Laws

- `tests/a-late-ticket-entry-expects-the-running-count.law.test.ts` pins the door expectation and refuses any later migration that raises a custom 40001.
- `server/src/services/aRefusedHorseEntryIsNotAskedEveryPass.law.test.ts` pins the caller backoff and the stopped pass.
