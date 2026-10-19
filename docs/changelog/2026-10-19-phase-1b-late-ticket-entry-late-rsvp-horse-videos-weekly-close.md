# Phase 1B: late ticket entry, late home game RSVP, horse videos, and the weekly close error (2026-10-19)

Dan, verbatim: "START PHASE 1. MUST-MOVE AUTO MOVES ARE ALLOWED. HORSES CAN
PUBLISH VIDEOS." Phase 1 is database-only; no engine release.

## 1. A late ticket entry calls a capacity function that exists

`fn_ca_register_for_tournament_with_ticket_for` seats a ticket holder into a
running tournament during late registration. If the first seating attempt
fails it opens capacity and retries. Both retries called
`fn_create_late_registration_capacity(p_tournament_id)`, which was dropped on
2026-09-08 (`20260908042200`) and replaced by
`fn_ensure_late_registration_capacity(uuid, integer)`. The 2026-10-17 rewrite
(`20261017004440_satellites_seat_bounty_targets`) copied an older body and
brought the dead name back. PL/pgSQL resolves calls only at run time, so it
installed cleanly and would have failed with 42883, rolling the whole
registration back, the first time a late ticket entry needed the retry
(humans and horses; the engine reaches it through `horseEntryRefusalBackoff.ts`).
Postgres logged zero occurrences in the 24 hours before the fix, so no entry
is known to have been refused yet; the defect was latent.

Fix (`20261019093516`): both calls are now
`fn_ensure_late_registration_capacity(p_tournament_id,0)`. Reserved entries is
**0** because this function has already inserted the entrant as `registered`
and unseated before the retry, and the capacity function counts that entrant
as demand. That is how `fn_seat_late_registrant` calls it. `1` would count
them twice, and for the entrant who fills the field, a non-zero reservation
reads the window as closed and opens nothing. The regular registration paths
pass 1 because their failed attempt is rolled back first. The unapplied Stage-B
draft (`20260910055955_*.sql.pending`) wrote 1 here; it never ran.

Every other byte is production's body (pre-image md5 `377446dc...`,
post-image `e0d819b1...`). After install, no live function calls the
dropped name. Law: `tests/a-late-ticket-entry-calls-a-capacity-function-that-exists.law.test.ts`
(corpus-wide: no current declaration may call the dropped name).

## 2. A late home game RSVP opens a plain direct message

`rsvp_to_home_game` answers an RSVP to a game that has started with "This game
has already started. Message the host directly." It made that conversation
with `fn_get_or_create_conversation(caller, host, 'direct')`. The only
overloads are `(uuid, uuid)` and `(uuid, uuid, uuid, text)`, so the call
resolved to the four-argument one and cast `'direct'` to a uuid. Proved on
production in a rolled-back probe (a horse RSVPing to a started public game):
`22P02 invalid input syntax for type uuid: "direct"`. Every late RSVP errored.

Fix (`20261019093626`): the two-argument overload, a plain direct conversation,
which reuses an existing one. Pre-image `ccdb5bce...`, post-image `50f4569d...`.
Law: `tests/a-late-home-game-rsvp-opens-a-plain-direct-message.law.test.ts`.

## 3. Horses can publish videos (Dan, 2026-10-19)

`fn_video_library_publisher_is_eligible` is the one test behind every door into
the Video Library (`publish_video_library_reel` and the row guards on
`social_posts`, `social_reels` and `video_reels_pipeline_config`). It required
`p.is_horse IS FALSE`. Removed (`20261019093704`): a horse is eligible under
the rules a human is (the profile exists and is not a `content_authors` row).
The two guard messages said "existing non-horse profile"; they now say
"existing profile". Nothing else in the publish path excludes horses:
`publish_horse_video_reel` and the post-contract trigger that tags a horse
upload's `origin_type` only identify horses (CLAUDE.md 10.5 permits that).
Law: `tests/horses-can-publish-to-the-video-library.law.test.ts`.

These functions were first written by World Hub's
`20260923120000_video_library_official_publisher.sql` (same database). World
Hub's own copy of that body still carries the exclusion; a future World Hub
migration that re-declares the function from it would bring it back.

## 4. Must-move auto moves are allowed (ruling recorded)

Recorded in `docs/LAWS.md` (resolved conflicts) as a narrow exception to
CLAUDE.md 10.6 #2: the engine's `must_move`, `break` and `balance` seat moves
inside a must-move game the player joined. Client-side switching of the active
table (`MultiTablePage` `activeIndex`) stays forbidden;
`tests/no-auto-table-switch.law.test.ts` is unchanged.

## 5. The weekly accounting close and "cannot find parent statement on pldbgapi2 call stack"

Not changed in this phase, on purpose. What is known:

- pg_cron job 272 (`union-weekly-rakeback-close`, every 5 minutes) failed with
  this error on 2026-10-13 00:30 and 02:30, 2026-10-17 09:25, and 2026-10-19
  00:40 and 06:40 UTC (the other failures in the week were plain statement
  timeouts). Each time a scope visit raised inside
  `fn_process_weekly_accounting_scope`'s scheduler loop, the handler caught
  it, and a following statement in that frame hit the debugger error, which
  rolled the whole tick back.
- The masked error. 06:40: the job's 240 s statement timeout fired during a
  scope visit (the run ended at 240.6 s). The handler, the visit bookkeeping
  and its alert insert all ran, and the next `IF` (plpgsql line 315) failed.
  00:40: a non-timeout error was caught by `WHEN OTHERS` about 218 s in, and
  its `GET STACKED DIAGNOSTICS` (line 264) failed. That tick had no
  transaction id, so it wrote nothing before the error. A caught error is not
  logged, and everything it would have recorded was rolled back, so its text
  is not recoverable.
- Effect: the close still completes; the week of 2026-10-05 finished on
  2026-10-18 after 214 attempts. A failed tick loses its work and leaves no
  record of the failing scope, so that scope is not sent to the back of the
  queue.
- Cause: plpgsql_check 2.7 is in `shared_preload_libraries`. Its pldbgapi2
  layer tracks a statement stack per call through the fmgr hook, and Supabase's
  `supautils` also hooks fmgr. Upstream issue okbob/plpgsql_check#197
  ("pldbgapi2 call stack error with recursive PL/pgSQL functions", reported on
  a Supabase build) has the maintainer naming that interaction. Upstream
  master has replaced pldbgapi2 with pldbgapi3, which does not use the fmgr
  API.
- `20260911161415_a_broken_debugger_is_not_a_seat_stack_mismatch` is NOT a
  workaround. It only stops `fn_ca_hand_commit_refusals` counting the
  debugger's message as a seat stack mismatch.
- Three rolled-back production probes (`pg_temp` functions only) did not
  reproduce it: recursion through a SECURITY DEFINER function, with and
  without temp-table DDL, a caught statement timeout three frames deep, and
  the job's own plpgsql -> SQL -> recursive plpgsql chain. The trigger is
  narrower than any of these.
- The root fix is on the platform: upgrade plpgsql_check to a pldbgapi3
  release, or remove it from `shared_preload_libraries`. Both are Supabase
  project settings, not migrations.
