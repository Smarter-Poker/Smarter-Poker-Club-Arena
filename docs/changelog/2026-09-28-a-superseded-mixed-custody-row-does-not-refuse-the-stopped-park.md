# A superseded mixed custody row does not refuse the stopped park, and the original's own check is read at the root (2026-09-28)

## What happened

Tournament 4e2de62d ("Friday Fight Night Opener", 31 players, tables 287108c9,
bdee0569, ae9de3e7, 77ded6f4) came back at 13:47:19Z on 2026-09-28 after two
days, dealt until 13:49:52Z under lease generation 9e2be701 on engine
763e4cec, lost the lease at 13:49:49Z, and has dealt nothing since.

Two defects, one after the other:

1. **The stop could not park its banks.** Mixed transfer 95634084 (prepared
   2026-09-26 09:34Z, completed 2026-09-28 00:56:59Z) had written the four
   tables' `engine_presence_parked` rows as `engine_instance =
   'f06_mixed_custody'` at hands 14775285, 14774766, 14772724 and 14775004.
   `fn_park_stopped_time_bank_custody` refused `mixed_custody_adopted` over ANY
   such row, whatever its hand number, and nothing but a live engine's own
   break park ever rewrites one. The tables had dealt to 16686550-16686591, so
   the rows were dead (loadTimeBanksFromPark reads a snapshot only at the exact
   hand an engine boots at), but at 13:50:02Z all four parks were refused and
   the stop failed "retained time-bank custody" on every table. All seven
   `f06_mixed_custody` rows on production were superseded the same way.

2. **The successor could not recover.** The failed stop fell through to a
   second mixed transfer (2b5b36ff, origin 9e2be701, successor 658aba20,
   13:50:32Z) with the four stopped engines still in the process. The
   successor's `recoverMixedF06Custody` re-checks the admission's `current()`
   inside its own bound data authority, and that closure called the drained
   packet's `current()` inline - the ORIGINAL manager's staleness check, whose
   methods are bound to 9e2be701. Every re-admission (13:50:39Z, 14:04:58Z,
   15:32Z, ...) threw "Tournament data authority cannot be rebound inside
   another manager context" at the first `assertCurrent()` and was retained on
   `GameServer.mixed_original_recovery_retained`. #5478 had moved the fleet scan
   in the same closure to the root and left this read inline.

The lease row's fresh heartbeat (instance 1-8e5738c4, generation 658aba20) is
that retained successor manager: it is registered, owns the lease and keeps
proving it, and deals nothing - the class #5493 counts. It is not a heartbeat
for a manager that does not exist.

## The fix

- `supabase/migrations/20260928154327_a_superseded_mixed_custody_row_does_not_refuse_the_stopped_p.sql`:
  the park still refuses `mixed_custody_adopted` unless the mixed row is
  PROVED superseded - a readable non-negative integer hand number strictly
  below the custody and a `hand_history` row on the table strictly above it
  and at or below the custody. A proved-superseded row falls through to every
  existing check and is overwritten like any other park row. The
  open-transfer refusal, the lock, the attestation paths, the ACL and the
  security posture are unchanged. Pre-image md5 ed3f8597 (20260928001128),
  post-image md5 668e5dd5.
- `server/src/GameServer.ts`: `drainedOriginalIsCurrent(packet)` reads the
  in-process original's check at the process root (`bindToProcessRoot`), and
  the mixed admission's `current()` uses it. The predicate is unchanged; the
  original enters only its own authority and the successor's context is
  restored on return.

## Proof

- Rolled-back probe on production, 2026-09-28 15:46Z (pg_temp copy of the new
  body, table 48bbf0ee of completed tournament bf09b28f, mixed row at 14777319,
  last hand 16140715): production body refused `mixed_custody_adopted`; the new
  body refused a custody at the row's own hand, refused when the row was moved
  to 16140715 and the custody put at 16140718 with no hand between, parked ok
  at 16140715 over the real row, and answered ok on replay. 0.07 s for all.
- `tests/a-superseded-mixed-custody-row-does-not-refuse-the-stopped-park.law.test.ts`
  and `server/src/theOriginalsOwnCheckIsReadAtTheProcessRoot.law.test.ts`
  (the latter reproduces the production throw first).
- `tests/a-permit-that-never-reached-the-database-does-not-hold-the-bank.law.test.ts`
  now pins its pre/post-image check on its own migration file instead of
  "the latest park", since this migration redefines the park after it.

## Not done here

- Transfer 2b5b36ff is still open, so until the engine fix is deployed the park
  keeps answering `mixed_transfer_recorded` for 4e2de62d, correctly. The event
  resumes through the fixed admission path, not through the park.
- The repeated lease losses ("no answer arrived, and the database did not say
  it moved") that start each of these episodes are the lease streams' (#5493,
  #5504).
