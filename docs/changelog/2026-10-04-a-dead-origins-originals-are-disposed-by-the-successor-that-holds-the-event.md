# A Dead Origin's Originals Are Disposed by the Successor That Holds the Event (2026-10-04)

## What Was Frozen

Fifteen RUNNING events dealt nothing after 23:42-23:43Z on 2026-10-03: twelve
heads-up Sit & Gos and Spins, two more SNGs and the 6-player "Sunday Funday
Main Event Satellite" (9ff52091). At 23:43:51-55Z, during a database stall, the
engine lost their leases and prepared a mixed custody transfer for each with
one original hand in the air. The process was replaced at 23:55Z before any
original was disposed. From then on every resume was refused:

    postgres: F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED   (about 90 an hour)
    engine:   [GameServer.Tournament_resume_failed_for_t] Error:
              f06_mixed_successor_custody_unproven
    /health:  tournamentResumesFailing: 15

Twelve originals were `reserved` permits of the dead origin generation, dealt
preflop and never dispatched. Three (9a8e68e9, fe0582bd, e8bfda49) had no
permit row at all: their `fn_f06_begin_hand` never committed during the stall,
but the engine's binding named the permit, so the snapshot listed the table as
pending and nothing could ever witness it.

## Why It Kept Happening

Only the dead origin could give either kind a terminal disposition, and nothing
in the live path did it for the origin. 2026-09-26 (71 events), 09-28, 10-01 (2
events) and now 10-03 (15 events) were each cleared by an operator migration
calling `fn_f06_void_stranded_mixed_original` by hand. Every engine replacement
during a database stall stranded events again.

## The Fix

`20261004125152_a_dead_origins_originals_are_disposed_by_the_successor_that_.sql`:

1. `smarter_private.f06_mixed_custody_snapshot` witnesses an original whose
   permit row does not exist by its `f06_absent_permit_releases` row (the
   absence record `fn_park_stopped_time_bank_custody` already writes and
   `fn_f06_begin_hand` already obeys). Without one it stays pending.
2. `public.fn_f06_void_stranded_mixed_original` counts such a recorded absence
   toward the transfer's original set.
3. `smarter_private.f06_dispose_dead_origin(transfer)`, under the event's lane
   and with no lease but the successor's, records each never-begun permit's
   absence (refusing if any start witness of that hand or a later one exists on
   the table) and runs the reviewed stranded void for any reserved original.
4. `public.fn_f06_dispose_dead_origin_originals(t, g, transfer)` is that door for
   the successor itself, gated by `f06_authority(t, g)`: service role, the
   tournament-manager actor, and a live protocol-2 lease at exactly the
   transfer's successor generation, which fences the origin.
5. Once, the fifteen frozen transfers are disposed through (3).

`GameServer.performTournamentManagerAdmission` now asks the door on the durable
path (no drained packet, pending originals) before `admitMixedF06Transfer`. A
process that still holds the original engines in memory never takes that branch
and recovers them itself, as before. A refusal names the database's reason
(`f06_mixed_dead_origin_disposal_unproven: <message>`) and returns the lease.

No chip moves: absences are records, and reserved hands are voided as misdeals
by the existing void, which proves every chair already holds its pre-deal stack.

## Contract

The snapshot is part of `fn_f06_mixed_custody_contract`; its new digests
(`da0de440...`, definition `db2e73c7...`) are carried by
`MIXED_CUSTODY_CONTRACT` in `server/scripts/engine-release-database-proof.py`,
by `tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json`, and
by the shared-hand lane, which installs the snapshot section of the migration.

## Pinned

`tests/a-dead-origins-originals-are-disposed-by-the-successor-that-holds-the-event.law.test.ts`
(`docs/laws.d/a-dead-origins-originals-are-disposed-by-the-successor-that-holds-the-event.md`);
engine: `server/src/tournament/MixedTournamentCustody.test.ts`.
