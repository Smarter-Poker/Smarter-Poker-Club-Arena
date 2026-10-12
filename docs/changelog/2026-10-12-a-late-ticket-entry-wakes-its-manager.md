# A Late Ticket Entry Wakes Its Manager (2026-10-12)

## What Happened On 2026-10-11

From 17:45 to 18:53 UTC the database request pool ran dry: PostgREST pool timeouts (PGRST003), 2,120 HTTP 503 and 100 HTTP 504 in the 18:00 hour against none in any other hour of the day, and the platform dealt 2,387 hands in the 18:30 ten minutes against about 8,300 normally (482 tables at 18:20, 385 at 18:30, against about 590).

The chain, read from the Postgres logs:

1. Sunday 200 Deep Stack (6561f9f4) started at 17:00 with a two hour late window. Satellite tickets issued at 17:31 sent their holders into the ticket door, fn_ca_register_for_tournament_with_ticket_for, late.
2. Every late ticket entry was refused with 'ticket admission tournament cache changed' (the door expected a roster count the trigger only writes before the start). That raise carried SQLSTATE 40001.
3. PostgREST 14.5 re-runs a request that ends in 40001, without limit, on the same connection. 22,401 refusals came from 10 backends, and each re-run took the event's exclusive settlement lane again.
4. With the lane held, every hand write on that event's tables (insert_hole_cards, save_hand_state_snapshot) was refused by f06_cancelled_preparation_writer_guard and f06_aborted_hand_guard with F06_RETRY_CANONICAL_LANE, also 40001, also re-run without limit: 142,697 and 69,356 raises in the window, against 1,000 to 5,000 an hour normally.
5. 40 to 60 connections spun until 18:53, when 20261011185301 changed both codes so PostgREST returns them.

## What Other Lanes Already Fixed

- 20261011185301 (PR #6690): F06_RETRY_CANONICAL_LANE is 55P03 and the two ticket refusals are 55000, so neither is re-run by PostgREST.
- 20261012031813 (PR #6697): the ticket door expects the running count, so the refusal itself is gone; the horse registration pass backs off a refused entry; hole card retries are jittered.
- 20261012061427 (PR #6726): every other custom 40001 in the catalog that a re-run cannot change was moved to 55000 or 55P03.

Since 20:00 UTC on 2026-10-11 the lane refusal runs at 50 to 340 an hour (all 55P03), 'ticket admission tournament cache changed' has not appeared, and there has been no HTTP 503 or 504 on the database API in any hour, including the 00:00, 02:00 and 04:00 Sunday Funday starts.

## What Was Still Broken

With the count refusal gone, a late ticket entry reached the last step of the door for the first time, and that step refused too. The door woke the tournament manager with 'late_ticket_registration'. fn_emit_tournament_manager_wake admits only rebuy, reentry, addon, late_registration, deal_vote and bounty_settled (so does the tournament_manager_wakes reason check), so it raised 'invalid tournament manager wake reason' and the whole admission rolled back. On 2026-10-12 from 05:08 to 05:28 UTC that refused 10 of 10 late ticket entries to Sunday Funday Six-Card Closer (7e9996f6). The reason has been in the door since 20260909165629; no late ticket entry has ever succeeded.

## The Fix

Migration 20261012112543_a_late_ticket_entry_wakes_its_manager changes that one literal to 'late_registration', the wake every other late door emits and the one the engine acts on (TournamentManagerEliminations). Locks, ledger legs, seating, ticket, entitlement and every check are unchanged. The migration proves on apply that no function in public or smarter_private hands the wake door a reason outside its list.

## The Law

tests/a-late-ticket-entry-wakes-its-manager.law.test.ts pins the migration byte-exact, the closed list, the replacement, and refuses any later migration that hands the wake door an unknown literal reason.
