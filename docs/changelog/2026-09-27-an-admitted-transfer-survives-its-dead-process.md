# An admitted mixed custody transfer survives the death of its process (2026-09-27)

## What was broken, read from rows

`smarter_private.f06_manager_custody_transfers` held 124 transfers created by
engine `cd5892e8` during the 2026-09-26 09:33 UTC lease collapse; none had a
completion. Re-measured at 21:17 UTC on 2026-09-27: 124 uncompleted, 118 of them
on RUNNING events, and all 118 events without a hand in the last 30 minutes
(`/health`: `tournamentResumesFailing 118`, `tournamentLease.conflictCount 44`,
`unparkedReasons.f06_preparation_unresolved 55`). Two disjoint classes:

- **73 never admitted.** Owned by the stranded-original void door
  (20260927145449, #5419/#5447) - not this change. By 21:30 the live engine had
  begun admitting them (44 admitted-with-a-live-lease at that read).
- **45 admitted at 09:34 on 09-26 and never completed.** This change. The
  admitting process lived until ~13:55 and died. 44 still carried its lease;
  the engine asked for the transfer's successor generation - the same
  generation the dead lease holds - and `claim_tournament_lease_v2` only takes
  a stale lease for a DIFFERENT generation, so it answered `granted=false`
  forever. The 45th had no lease: its claim was granted and admission refused
  `F06_MIXED_ADMITTED_PROCESS_CHANGED`, because the admission is bound to the
  dead process's exact lease row.

Independently, 24 of the 45 could not have completed even while their process
lived: `f06_mixed_adopt_presence` refused `F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN`
(23) or `..._ARRIVAL_UNPROVEN` (1) for players who had already busted before the
transfer was prepared - 0 chips on the registration and no chair in the event
that is live or holds a chip. The same rows block 13 of the other class too.

## What changed

Migration `20260927163949` (one BEGIN/COMMIT, `lock_timeout`, preimages
asserted, postimage asserted):

1. `smarter_private.f06_manager_custody_readmissions` - append-only (the
   transfer tables' own immutability triggers), PK `(transfer_id, generation)`,
   UNIQUE `(transfer_id, prior_generation)`, `CHECK (generation <> prior_generation)`.
2. `public.fn_f06_readmit_mixed_manager_custody` - a NEW door beside the admit
   door. It admits exactly: the caller holds the event's live protocol-2 lease
   (f06_authority around the event lane); the transfer equals the caller's
   immutable copy; it HAS an admission and NO completion; the caller's
   generation is not the origin, successor, admitted or any earlier readmitted
   generation. It carries the admission's own terminal proof unchanged.
3. `f06_mixed_current_admission` accepts the original admission (unchanged
   rule) or the readmission of exactly this generation, each bound to the exact
   current lease row.
4. `fn_f06_find_mixed_manager_custody` additionally reports the chain head and
   whether its lease is live. The receipt is unchanged.
5. `f06_mixed_adopt_presence`: a presence key whose player holds nothing is
   recorded on the completion receipt as `discarded: holds_nothing`, never
   carried. Every other refusal is unchanged.

`fn_f06_admit_mixed_manager_custody` and `fn_f06_complete_mixed_manager_custody`
are byte-identical before and after (asserted). No trigger, constraint, lease
claim, reaper or immutability guard is relaxed; nothing is deleted; no chip,
seat, registration, ledger or wallet row is written by the migration.

Engine (`server/src/tournament/mixedF06Custody.ts`, `GameServer.ts`): discovery
reads the admitted holder; an admitted transfer is re-read on every admission
attempt; when its holder is dead the engine claims a FRESH generation (never the
origin, successor or holder - a shared generation is a shared fence) and calls
the readmission door, then completion runs exactly as before.

## Proof against production rows (one rolled-back DO block, 21:2x UTC)

New bodies installed as `pg_temp` functions over a `pg_temp` readmission table
with the real immutability trigger; the real `claim_tournament_lease_v2`,
`f06_authority`, `f06_try_lane` and a `pg_temp` copy of the live completion
body (md5 `43aa1470...` asserted, only its two helper calls re-pointed).

- **Positive: 45 of 45** dead-held events claimed a fresh generation, were
  readmitted and completed; after completion discovery returns no open receipt.
  31 presence keys discarded as holds-nothing. For every event
  `sum(tournament_players.chips)`, felt stack, live seat count and registration
  count were identical before and after completion.
- 29 further events (admitted minutes earlier by the live engine, lease fresh)
  were correctly NOT treated as dead: discovery reported `live: true`.
- Refusals, each by name:
  - changed canonical proof -> `F06_MIXED_SUCCESSOR_CHANGED`
  - another event's transfer -> `F06_MIXED_SUCCESSOR_CHANGED`
  - never-admitted transfer -> `F06_MIXED_READMISSION_UNADMITTED`
  - origin generation / successor(=admitted) generation -> `F06_MIXED_READMISSION_GENERATION_REUSED`
  - a live holder: discovery `live: true`, a fresh claim `granted=false`
  - the dead generation after takeover (current admission and completion) -> `F06_LEASE_FENCED`
  - a readmitter replaced by a later readmission -> `F06_LEASE_FENCED`
  - after completion -> `F06_MIXED_ALREADY_COMPLETE`
  - UPDATE / DELETE of a readmission row -> `F06_MANAGER_TRANSFER_IMMUTABLE`
  - a discarded player given one chip back -> `F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN`
    (a re-seat on an empty stack is refused earlier by
    `TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK`; a seat with a stack is the same
    "holds something" case)
  - a chain of two readmissions: the second names the first as prior and completes.
- Presence alone (old body vs new, every open RUNNING transfer): old refuses 37
  (24 dead-held, 4 live-held, 9 unadmitted), new refuses 0.

Laws: `tests/an-admitted-transfer-survives-its-dead-process.law.test.ts` (the
SQL), `server/src/tournament/anAdmittedTransferSurvivesItsDeadProcess.law.test.ts`
(the engine).
