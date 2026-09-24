# A dead generation proves its park from the row it read (2026-09-24)

Run 36061780372, the 21:36 UTC recovery window, was the furthest an engine
release had reached since 2026-09-22: every capture refusal cleared (#5198,
#5201, #5202, #5203), every row proof passed (#5211, #5213), the previous-work
join settled (#5206), the re-verification after the write held (#5215), all
83 park writes returned - and the checkpoint refused:

```
{"ok":false,"reason":"native_checkpoint_unconfirmed","stage":"checkpoint",
 "attemptedTables":83,"completedCalls":83,"verifiedTables":0,...
 "unresolvableCustody":"tables=47 attempted=28 parkedNoRoster=11 failedBoundary:attempted=8 ..."}
```

Named nothing: the require was the process-wide one. The Supabase edge logs
for those thirteen seconds hold 22 `POST 403 engine_presence_parked`, and the
Postgres logs hold the same 22 as

```
TOURNAMENT_MANAGER_FENCED: lease generation is no longer current
```

raised by `smarter_private.fn_smarter_data_api_pre_request`, the PostgREST
pre-request hook that fences every request carrying tournament-manager
authority whose lease generation is not the current one (`protocol_version
= 2`, heartbeat inside 30 s, not F06-aborted). Eleven tables, each written
once and once more five seconds on - 8825's own `parkWriteRetryMs` - and
every one of them a `parkedNoRoster` deferral. Read from the rows:

| table    | parked row written | tournament | lease heartbeat stopped | banks in row |
| -------- | ------------------ | ---------- | ----------------------- | ------------ |
| 042c53ae | 2026-09-22 14:53   | RUNNING    | 2026-09-22 15:05        | 1            |
| 074ee320 | 2026-09-22 13:53   | RUNNING    | 2026-09-22 13:53        | 3            |
| 2788e5fb | 2026-09-18 21:53   | RUNNING    | 2026-09-22 13:53        | 4            |

A STOPPED, TERMINAL tournament engine on a lease generation whose heartbeat
stopped two days ago, holding the banks it read from `engine_presence_parked`
at `start()` and never seating anybody to claim them. Its
`persistPresenceForRestart` is bound to that generation
(`bindTournamentDataAuthority`), the request carries it, and the database
refuses it. **Correctly.** A generation that is no longer current must not
write tournament data. That fence is the platform's own rule, it is doing
exactly what it was built to do, and this fix does not argue with it.

## The write was never needed

The deferral that admitted these engines (#5203, `deadParkedBanksDeferred`)
already says why: 8825's `captureParkedTimeBanks` starts from
`{ ...this.parkedTimeBanks }` and the engine seats nobody, so the row the
checkpoint writes is the row the engine read - and on 8825 `parkedTimeBanks`
is filled from nowhere but `loadTimeBanksFromPark`, which only fills it when
`snapshot.handNumber === this.handCount`. Writing it again changes nothing the
successor will read, and on a dead generation cannot be done at all. So the
guard asks the row FIRST, before anything is written, and a `parkedNoRoster`
capture whose row still says what the engine holds is not written: the row is
its proof.

"Says what the engine holds" is the standard the write's own readback applies,
minus the two conjuncts that only a fresh write can satisfy (instance and
write window):

- the row exists, its snapshot is the shape `loadTimeBanksFromPark` accepts
  (`version 1`, `parkedAt` equal to the row's), and it is at the captured hand;
- every bank the engine holds is in it byte for byte;
- any entry the row holds that the engine does not is one the loader would
  have SKIPPED as unrestorable - the same predicate - so the successor skips it
  again; an entry it would keep is a bank the engine lost, and is not proof;
- the row carries no presence the successor would still read
  (`PARKED_PRESENCE_FRESH_MS`, 20 min): a stopped engine's own write would have
  left an empty presence, and a row older than that is read for its banks only.

A capture whose row does NOT say that stays on the write path exactly as
before. A cash engine, or a tournament engine whose lease is still current
(its :53 announcement nulls the snapshot, so its row never proves), gets its
row rewritten and read back inside its own write window; one whose generation
is dead gets the same fenced refusal as today - now naming the table, the
deferral, and which check the row failed (`rowProof=snapshot.handNumber`,
`rowProof=row.present`, ...). Nothing is admitted on "could not tell": an
unreadable row is simply not a proof, and the write path answers instead.

## What else this names

Two more process-wide requires on the same path became per-table witnesses,
with no change to their condition or code:

- `native_checkpoint_unconfirmed` names the table whose write the engine did
  not confirm, its scope, its deferral, and the engine's own
  `maintenanceDurabilityReason`. At 21:36 it refused 83 tables and named none.
- `native_readiness_refused` (the final `isMaintenanceStateDurable` walk)
  names the table and the reason. A dead generation whose row was proved is
  the ONE admitted exception, and only for the ONE reason its unwritten park
  produces on 8825: `parkedTimeBanks` non-empty and `parkedBankSaveComplete`
  false -> `bank_park_write_incomplete`. The process's own `readyForRestart()`
  never counted a stopped engine's durability at all (8825 `unparkedTables`:
  `if (!engine.isRunning()) continue;`), so nothing admitted here is something
  the engine refused.

The receipt carries a new `provedRows` field - how many candidate rows proved,
by scope, which did not and on which check, and what each proved row held -
carried verbatim by the transport and read by nothing.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts` (239 tests): a `parkedNoRoster`
engine whose write the database fences is proved from the row it read, the
row is untouched, and the release proceeds; a row with an unrestorable extra
entry still proves; five shapes that do not prove (a restorable bank the
engine lost, a bank that moved, another hand, a nulled snapshot, a fresh
presence) each refuse the fenced write naming the check, and each are written
and read back when the write is not fenced; a missing row and a failed read
are not proofs; a fenced write on a table that is not a dead generation still
refuses and now names it; a proved table the engine will not call durable for
any other reason still refuses, naming the reason. The fixture's
`readyForRestart` now mirrors 8825's `unparkedTables` for stopped engines, and
its engine carries 8825's `maintenanceDurabilityReason`.
