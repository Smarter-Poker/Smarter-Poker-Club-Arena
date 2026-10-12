# A retired generation's retirement reservation yields to the live one

**Date:** 2026-09-29
**Area:** engine, F06 table-break retirement custody

## What stalled

From 01:15Z on 2026-09-29 (engine fa480b9b) the $100 Freeroll 6:00 PM
(cb8f2dd1, 171 players) dealt no hand. Every 20-40 s the engine admitted a
new manager, which logged `Resuming...`, built dealers for the first four
tables, threw `f06_retirement_custody_held` from `createManagedTableEngine`
on the fifth (b6af1747), fenced the dealers it had built
(`f06_engine_admission_fenced` x4) and released its lease
(`tournament-manager-release ... confirmed`). 87a68e55 (since 23:20Z),
6a18ddaa (since 23:20Z), 1f918c8c and 4ed38a9f (since 00:12Z) were in the
same loop.

## Root cause, read from rows and logs

- `smarter_private.f06_operations`: break `e487977d` for cb8f2dd1, source
  table `b6af1747`, state `park_requested`, revision 1, custody `50b3eacb`
  claimed by generation `83b3ec21`, created 00:51:54Z.
- Engine log: at 01:14:07Z lease generation 83b3ec21 "expired before it was
  renewed"; at 01:14:26Z the lost-lease stop and the drained transfer were
  refused (`originals_not_drained`); at 01:14:39Z the manager's lease release
  was confirmed. The first `f06_retirement_custody_held` for cb8f2dd1 is
  01:15:43Z.
- `TournamentRetirementCustody.withCustody` keeps a reservation it could not
  acknowledge (`held` + `pending`, keyed by the generation's identity) so the
  SAME generation can replay it: a roster that does not fit yet
  (`TournamentBreakAwaitsSeatsError`) or a lost close/ACK. The only ways out
  were that same identity replaying, or the drained/mixed transfer contract.
  Once 83b3ec21 was stopped and released, neither could ever happen, and
  `admissionAllowed(b6af1747)` returned false for the life of the process,
  so every successor's `resumeLifecycle` failed at
  `TournamentManagerBase.createManagedTableEngine`.

The durable layer already supported the successor: every F06 door is
lease-fenced (`f06_authority`), `fn_f06_claim_custody` and
`fn_f06_admit_parked_movement` replace an old generation's custody by
revision CAS, and `fn_f06_hand_number_state` refuses every hand on a source
with an open break (`source_excluded`). Only the process-local reservation
had no successor.

## Fix

- `TournamentRetirementCustody.abandonedReservations` lists pending
  reservations of one tournament held by a generation other than the live one
  with no work running; `yieldAbandoned` releases one exact identity, and
  refuses running work, a mixed transfer, the live generation's own
  reservation, a replaced identity or a table with an engine registered.
- `GameServer.yieldAbandonedRetirementCustody` yields only when the asking
  manager is the registered one and nothing of the old generation remains in
  the process (no registered, stopping or quarantined manager, no
  unconfirmed lease release or release barrier, no drained or mixed
  transfer), and only after `confirm` returned true; it re-checks everything
  after the await.
- `TournamentManager.adoptAbandonedRetirementCustody` is the confirm: it
  reads `fn_f06_break_state` under the live lease (lease-fenced, locks the
  row) and requires the same break, table and lifecycle. It remembers the
  durable row and wakes the elimination sweep so this generation claims the
  break through the ordinary retirement path.
- `resumeLifecycle` calls it right after the abandoned-generation door and
  before any dealer is built.

No cron, sweep or compensating write. No money moves. No migration.

## Tests

- `server/src/services/TournamentRetirementCustody.test.ts`: listing and
  exact yield; refusals for running work, a replaced identity, a mixed
  transfer, the retired generation itself and a registered engine.
- `server/src/tournament/aRetiredGenerationsCustodyYieldsToTheLiveOne.law.test.ts`
  (law, `docs/laws.d/`): real TournamentManager and GameServer; yield after
  the durable receipt; refusal for each surviving trace of the old generation
  and each missing or mismatched receipt; resume asks before building any
  dealer.
