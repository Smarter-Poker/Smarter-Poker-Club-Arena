# An Adopting Generation Decides A Dead Generation's Hand

Date: 2026-09-22. Engine only: `server/src/tournament/abandonedGenerationDoor.ts`
(new), `TournamentManagerBase.resumeLifecycle`, one seeded counter in
`observability/engineInstruments.ts`, and a schema-manifest fragment naming the
database door the engine now calls. No migration, no workflow change, no row
written by this change itself, no chip moved.

## What was wrong

Every tournament hand is authorised by one `smarter_private.f06_hand_permits`
row that the manager's lease generation reserves before the deal and closes
after it. When that generation dies with a hand in the air (its lease proof
lapsed in a database blip, the process restarted, the manager was fenced),
nothing it owned can close the permit again: every F06 door refuses a stale
generation.

The generation that adopts the event then reads each table through
`fn_f06_hand_number_state`, is told `hand_permit_unresolved`, and throws
`f06_engine_admission_unproven`. Its recovery retried every ~15 s for the rest
of its life and the answer never changed. The table stopped dealing while the
event stayed RUNNING. Nothing in the engine ever asked the one door that can
decide such a hand, `public.fn_f06_abort_abandoned_generation`, although that
door admits the `tournament-manager` actor.

Measured on production 2026-09-22 (read-only):

| Measure                                                                                        | Value                                                                                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Tables holding a reserved permit of a generation that is not the lease holder, about 16:20 UTC | MTT 54 tables in 35 events, Satellite 1, SNG 80, Spin 90; every adopter's heartbeat fresh, every event RUNNING |
| Abandoned-generation receipts written by hand today                                            | 397, between 12:40 and 13:23 UTC                                                                               |
| ...of which moved the event's blind clock back                                                 | 328, by up to 294 levels                                                                                       |
| ...of which released the adopting manager's lease                                              | 385, including all 328 that moved the clock                                                                    |

The last two rows are why this change is shaped the way it is. The door does
more than close the permit: when play stopped at a lower level than the one the
event now shows, it returns `tournaments.current_level` and every table's
blinds to where play stopped. Every hand run that moved the clock also released
the live manager, so that a fresh adoption would read the moved clock. A
manager that keeps running on the clock it read before the door would be
wrong about its own level.

## What changed

`resumeLifecycle` (every adoption goes through it) now, after reading the
event and its table inventory and before creating any dealer:

1. reads `fn_f06_hand_number_state` for each table (four at a time), and keeps
   every reserved permit whose generation is not this manager's
   (`abandonedPermitGeneration` accepts only an exact, well-formed answer about
   this table and this event);
2. asks `fn_f06_abort_abandoned_generation` once per dead generation, with a
   receipt derived from (event, generation) so any later caller replays it,
   `p_release_current_lease = false`, and a reason naming both generations;
3. when the door answered with a decision (made now, replayed, or made by
   another receipt since the read), starts the adoption again from the event
   row, so the clock, blinds and inventory it adopts are the ones the door
   left. The second pass does not ask again.

Refusals, by what they mean:

- a rule the door names (`F06_ABANDONED_ROSTER_CHANGED`,
  `F06_ABORT_SAVED_STACKS_CHANGED`, ...) is reported once as
  `Tournament.abandoned_generation_refused`; the table stays exactly as blocked
  as before this change and adoption goes on;
- `F06_ABANDONED_HAND_HAS_A_RETAINED_SUBMISSION`: the blocked tables' retained
  originals are finished with `resumeRetainedHandSubmission`, the same call
  the table's own admission makes first, and the door is asked once more;
- an answer that says nothing about the hand (a lane the door would not wait
  for, a serialization failure, a lost connection) is asked again, at most
  three times, one and two seconds apart;
- the platform freeze: the door refuses it, and an adoption never waits on
  it (waiting would hold every healthy table of the event, and a resume slot,
  until the thaw). Inside the freeze the door is not asked, the table stays
  exactly as blocked as before, and the next adoption asks.

`poker_f06_abandoned_generation_closures_total{outcome}` counts every answer
(`aborted`, `replayed`, `already_closed`, `refused`, `transient`), seeded at
zero.

This is not a sweep or a retry loop. It runs only inside an adoption the
engine was already performing, for the generations that adoption found
blocking its own tables, and credits or debits nothing: the door proves from
rows that every chair still holds its registration's chips and closes the
permit with a receipt.

## Verification

- `server/src/tournament/AbandonedGenerationAdoption.test.ts`, 42 tests. The
  adoption tests run the real `resumeLifecycle` on a small model of the
  database in which the door frees the dead generation's tables and moves the
  clock from level 7 to level 3. With the manager change removed, 8 of them
  fail (the door is never asked and the manager adopts level 7); with it, all
  pass: the door is asked once per dead generation, before any dealer, with
  the exact request above; the event row is read again and the manager adopts
  level 3; a permit of its own generation, an unreadable table and a rule
  refusal never reach a second pass; transient answers are bounded; the
  freeze is never waited on and the next adoption asks; a later adoption asks
  again after a refusal; an adoption whose lifecycle ends stops asking and
  starts no dealer; a retained original is finished first. An independent
  review of the diff against the production door's SQL found no mismatch in
  arguments, reply shape or refusal codes.
- `SeatFirstActualDeal.test.ts` pins a replacement manager's exact RPC
  sequence; it now starts with the adoption's `fn_f06_hand_number_state` read
  and is updated in this commit.
- `npx tsc --noEmit` passes and the whole server suite passes on the final
  code (986 files, 16,966 tests, 1 file skipped as on main); `check-phantom-tables.mjs`
  sees the new `.rpc('fn_f06_abort_abandoned_generation')` and is satisfied by
  the manifest fragment (and fails without it).

## Costs and limits

- One extra `fn_f06_hand_number_state` read per table per adoption.
- Adoptions inside the maintenance freeze (every deploy) do not decide. A
  dead generation left by a mid-hour blip is decided by the adoption that
  follows it; one already standing at a deploy waits for the next adoption
  or an operator run of the same door with the same receipt.
- A table whose hand the door refuses by rule stays blocked until an operator
  decides it; the refusal is reported with its code.
- Not in this change: a manager that lost its lease cannot finish stopping
  while it retains a break source; the 13:53 UTC lease expiry came from the
  database connection pool running out; engine releases are refused at the
  checkpoint. The door matches the evidence level by small and big blind
  only and takes the first match, so a structure that repeats a blind pair
  (an ante-only step) can move the clock one level too far; that is the
  door's own definition and is left to its owner.
