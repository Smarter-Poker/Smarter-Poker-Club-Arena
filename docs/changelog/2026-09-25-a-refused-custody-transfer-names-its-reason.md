# A refused custody transfer names its reason (2026-09-25)

Diagnosed read-only on production release 778075b4. After a tournament
manager lost its lease (`fenceForTournamentLeaseLoss`), its cleanly stopped
engines reported "retained time-bank custody" in `TournamentManagerBase.stop()`
and the manager was quarantined. That is the correct outcome for that state,
and the quarantine's retry pass did its job: every quarantined manager was
re-offered the same stop on its backoff, for hours. Seventeen managers,
thousands of attempts each, `reason: GameServer.tournament_lease_lost_stop_failed`
on every one of them. What the log held about WHY the release path kept
refusing: nothing. Zero `f06_drained_custody_unproven`, zero mixed-custody
lines, zero `fn_f06_prepare_mixed_manager_custody` calls.

The release path is `GameServer.transferDrainedF06Custody`, which asks
`TournamentManager.captureDrainedF06Custody` and then
`captureMixedF06Custody` for a packet and, having none, returns false. Between
them the two captures and the transfer end in roughly fifteen unnamed guards,
every one of which answered with the same bare `null` or `false`. The commit
that shipped the time-bank rule already says why that is not acceptable, on
the engine (`ServerTableEngineBase.maintenanceDurabilityReason`): "A gate that
can refuse for four different reasons must say which one." This one could
refuse for fifteen and said nothing.

## What changed

Every guard keeps its exact condition and its exact order. Each now names
itself on the way out, and the boolean is derived from the name, so the answer
the gate gives and the reason an operator reads cannot disagree:

- `TournamentManagerBase.captureDrainedF06Originals` walks its seventeen
  clauses one `if` at a time and names the one it refuses on
  (`engine_stops_not_all_fulfilled`, `stop_fence_not_applied`,
  `lease_authority_not_expired`, `manager_running`, ...,
  `original_not_registered`, `engine_process_ownership_held`,
  `engine_settlement_in_flight`); `drainedF06OriginalsRefusal()` reads that
  verdict. The walk stays in the capture, and the verdict is kept beside the
  class rather than on it, because
  `tests/a-race-that-touched-nothing-names-it-and-waits.law` pins that the
  capture's body reads exactly the terms the release guard's `drainWitness`
  diagnoses.
- `TournamentManager.captureDrainedF06Custody` and `captureMixedF06Custody`
  record an `F06CustodyRefusal` (`{ path, refused, detail? }`, in
  `drainedF06Custody.ts`) on each guard: `originals_not_drained` (with the
  clause above as detail), `lease_generation_unknown`,
  `no_retained_break_sources`, `successor_is_origin`, `nothing_to_transfer`,
  `active_stopped_original_custody`, `retirement_reservation_refused`,
  `physical_identity_unreadable`, `local_vector_incomplete` (five details),
  `stale_before_admission_read` / `stale_after_admission_read` and
  `stale_before_prepare` / `stale_after_prepare`, each carrying which clause
  of the former `current()` conjunction went false. A returned packet clears
  it. `lastF06CustodyRefusal()` reads it.
- `GameServer.transferDrainedF06Custody` names its own identity checks
  (`custody_already_held`, `packet_manager_mismatch`, `manager_not_registered`,
  `packet_not_current`, `physical_map_incomplete`, `original_not_registered`,
  `retirement_admission_refused`, `bank_receipt_not_prepared`) and, when the
  capture returned null, reports the capture's reason. A capture that returns
  null without naming why is itself named: `capture_refusal_unnamed`.
- The refusal is logged as `[tournament-custody-refused]` ONCE per manager per
  distinct reason, keyed on `path:guard[:clause]`, never once per attempt: the
  retry pass runs every five seconds, and a line per attempt is how thousands
  of identical lines bury the one that changed. A reason that changes is
  logged again. A different manager on the same tournament starts its own
  record.
- The quarantine record carries it, so `/health.quarantinedTournamentManagers[]`
  now reads `custodyRefusal: 'mixed:originals_not_drained:engine_running'`
  beside `reason`, `attempts` and `ageMs`. A retry record made before the
  transfer runs keeps the refusal the last transfer named; a record by a
  different manager starts with none.

No condition, order, threshold or outcome moves. No `.some(...)` short-circuit
was widened; where one predicate covered several clauses it was split into
sequential checks in the same order. `TournamentLifecycleOwnership.guard`
still proves no await splits the identity checks from the map mutation; its
literal for the refusal now reads `return this.noteF06CustodyRefusal(`,
because the refusal returns false THROUGH the note that names it.

## What this does not do

It does not clear the refusal. The time-bank metadata defect that makes a
cleanly stopped engine report retained custody, and the lease-loss amplifier
behind it, are repaired on a sibling branch; `ServerTableEngineBase`
departure and `forgetTimeBank` logic and `renewTournamentLeaseProof` are
untouched here. This is the observability half: the next quarantined manager
says which guard is holding it, once, and /health says so for as long as it
is held.

## Evidence

- `MixedTournamentCustody.test.ts`: 10 new cases, one per named guard on the
  real manager, real guards and mocked transport: the drained path's
  `stale_before_admission_read:pending_seat_moves`, and on the mixed path
  `successor_is_origin`, `nothing_to_transfer`,
  `active_stopped_original_custody`, `physical_identity_unreadable`,
  `originals_not_drained:engine_registry_changed`,
  `retirement_reservation_refused`, `stale_before_prepare:physical_map_incomplete`,
  and the transfer path's `custody_already_held` with its one log line; a
  packet clears the record. 57/57.
- `aRefusedCustodyTransferNamesItsReason.test.ts` (new): a quarantined
  manager's refusal reaches `/health` as `custodyRefusal`; an unnamed null is
  named; two refusals with one reason log once, a changed reason logs again,
  a different manager logs its own. 3/3.
- `quarantinedTournamentManagers.test.ts`: the refusal survives a retry
  record and starts empty for a new owner. 12/12.
- `npx tsc --noEmit -p server` clean.
