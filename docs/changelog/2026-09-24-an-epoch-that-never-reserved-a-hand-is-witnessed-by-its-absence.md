# An epoch that never reserved a hand is witnessed by its absence (2026-09-24)

Run 36068474418 (the 21:36 UTC recovery window, on #5217) went further than
any engine release since 2026-09-22: every capture refusal cleared, every row
proof passed, the previous-work join settled, 62 tables were written and all
62 read back, the eleven dead generations' rows were proved
(`provedRows: tables=11/11 tournament=11`), and for the first time since
`smarter_private.f06_mixed_custody_snapshot` was written, the guard sent
`fn_f06_prepare_mixed_manager_custody` for the first retained 8825 manager.
The receipt said `mixed_custody_rpc_unknown` and named nothing. The Postgres
log said:

```
F06_MIXED_ALLOCATION_WITNESS_UNPROVEN
PL/pgSQL function f06_mixed_custody_snapshot(uuid,uuid,jsonb) line 42 at RAISE
PL/pgSQL function fn_f06_prepare_mixed_manager_custody(...) line 60 at assignment
```

## The cause, read from rows

Line 42 witnesses an allocation-backed engine - one holding an allocator epoch
and no local permit - from the `f06_hand_permits` rows reserved under that
epoch, on the premise that "historical allocator custody is the native witness
after a permit clears". That premise has a second case it never named. On
8825af51 an engine holds exactly one allocator epoch for its life
(`installF06Allocator` refuses a second; `custodyId := randomUUID()` at
admission, TournamentManagerBase.ts:1600), and every hand it deals reserves a
permit under that epoch. An epoch with NO permit row is therefore an engine
that dealt nothing in this generation: a table admitted and left waiting for
players. And `drainedF06Originals` is every engine the manager held at its
stop (`[...this.tableEngines.entries()]`, :5797), waiting ones included.

The retained managers are two hard-coded tournaments. The first, 5a387a75 (the
$100 Freeroll, 12:00 PM), read from the rows: three tables dealt under 8825's
generation 66291622 (2c621856 with the aborted permit, dbd8b7ea, fcbbd2ea),
and seven waiting single-seat tables (09f5e9eb, 49a444ac, 623b526d, 66b1cb1d,
6d8512e3, 815d35dd, 9bf11d84) with no permit under it at all. Nothing was ever
allocated under those seven epochs, so nothing is transferred from them, and
refusing the whole transfer for them is the wedge behind the wedge (CLAUDE.md
10.86 rule 4).

## The fix, at the source

Migration `20260924225647_an_epoch_that_never_reserved_a_hand_is_witnessed_by_its_abse`
(applied 2026-09-24 23:04 UTC, body md5 `5422e7f7...`): when the epoch has no
permit row, the function witnesses that absence under the same locks it
already holds -

- no permit under (tournament, generation, table, epoch): the case;
- no reserved permit anywhere on the table (a hand in the air is never absent;
  `F06_MIXED_ORIGINAL_OMITTED` would refuse it too, one loop later);
- the table's own `f06_lifecycle` is the witnessed lifecycle, which this engine
  never moved, and a lifecycle the caller asserts that differs from it refuses
  exactly as before -

and records `permits: []`, `witness: 'never_reserved'` on the
`engine_lifecycles` entry. An epoch that did reserve is witnessed exactly as
before and marked `witness: 'permits'`. The guard holds the receipt to exactly
those two shapes: `never_reserved` is accepted only with an empty permit list,
no local permit and no lifecycle the guard could place itself; a receipt
naming neither witness refuses `mixed_original_lifecycle_evidence_invalid`.
The release contract pins (`engine-release-database-proof.py`
`MIXED_CUSTODY_CONTRACT` and the admission fixture) carry the new body and
definition md5.

## Named

`mixed_custody_rpc_unknown` was a process-wide require. It is a witness now:
the manager (as `failedTable`), the RPC, observe/commit, the PostgREST error
code and message, and the physical map's shape - engines, permits,
allocation-backed, null-lifecycle, and the first twelve allocation-backed
engines as `table:epoch:lifecycle:hand:seats`. The next refusal on this path
will say which engine and why in the receipt, not on the Postgres log alone.

## Pinned

`tests/legacyEngineCheckpointGuard.test.ts` (244): two waiting originals on a
retained manager are witnessed `never_reserved` and the transfer proceeds; an
epoch that reserved is still witnessed from its permits; a receipt naming
neither witness refuses and commits nothing; a `never_reserved` witness for an
engine the guard can itself place refuses; a refused custody RPC names the
manager, the RPC, the message and the map.

## Every manager is observed before any is committed

Read against the rows before the next attempt: the second retained manager,
615783bf (Afternoon Free Buy), will refuse
`F06_RETIRED_CANONICAL_CHANGED: registrations` in
`smarter_private.f06_retired_origin_transfer`. One `tournament_players` row
(user 62ec986d) was attested on 2026-09-21 as `playing`, chip count 0, no
seat, and now reads `eliminated`, position 12, `eliminated_at` 2026-09-18
22:12:05: a real bust, recorded after the attestation by the knockout door's
second caller. The origin and abort receipts are immutable and a real bust is
not unrecorded to tidy a comparison, so that refusal stands until the
comparison itself is changed - a change to a custody proof that was proposed
and NOT applied in this session (the migration was refused by the session's
own action classifier); it is recorded here for Dan's decision, not routed
around.

What this PR does about it is the guard's own discipline. The commit call
inserts an immutable `f06_manager_custody_transfers` row carrying the run's
release checkpoint, and the guard observed and committed each manager in
turn, so the second manager's refusal would have stranded the first manager's
row and every later attempt would have refused it as
`F06_MIXED_TRANSFER_CHANGED` for ever. The two calls are two phases now: every
manager is observed and checked before the first commit is sent, and a
refusal anywhere in the first phase commits nothing. Pinned: a refusal on the
second manager's observation leaves no receipt, no transfer, and every
original in the map.
