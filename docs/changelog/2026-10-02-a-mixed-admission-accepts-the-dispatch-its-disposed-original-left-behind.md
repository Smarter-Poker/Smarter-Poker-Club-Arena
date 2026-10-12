# A Mixed Admission Accepts the Dispatch Its Disposed Original Left Behind (2026-10-02)

## What Was Frozen

MTT 3414f268 "DSS Thursday $100 PLO4 Freeroll" (12 playing, 2 tables) and SNG
a59d7bbb "PLO4 Heads-Up 5 Turbo" (2 playing) dealt nothing after 23:15Z on
2026-10-01 (engine 1a8f73eb). Every resume logged:

    [GameServer.Tournament_resume_failed_for_t] Error: f06_mixed_successor_custody_unproven

and Postgres logged `F06_MIXED_CANONICAL_CHANGED` for each attempt. The two
unadmitted transfers also held the engine's F06 preparation barrier, so the
00:55Z and 01:55Z maintenance breaks were not certified
(`f06_preparation_stuck`) and engine releases were blocked.

## The Line That Refused

Transfers d7812b54 (a59d7bbb) and 011c1b2e (3414f268) were prepared at
23:15:36 and 23:15:39 while one original hand per event was in dispatch
(permits c6acd1b6 and cbdcb98a). The snapshot stored each original's
`f06_hand_dispatch` row in `canonical_proof.hand_dispatch` and listed its table
as pending. Both hands then finished: the permits are `accepted` with their
committed hands, and the dispatch rows are gone. That is the original's
terminal disposition, the one legal change before admission.

`fn_f06_admit_mixed_manager_custody` compared the whole snapshot minus only
`originals`, `original_evidence` and `pending_original_tables`. The original's
own dispatch row disappearing made `hand_dispatch` differ, so the admission
refused for ever. Before the hand finished it refused
`F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED`, so a transfer captured with an
original in dispatch could never be admitted.

Read-only, every other snapshot key of both transfers equals the live rows.

## The Fix

`20261002023035_a_mixed_admission_accepts_the_dispatch_its_disposed_original.sql`
compares `hand_dispatch` without exactly the rows whose permit is one of the
transfer's bound originals. Every other dispatch row and every other key is
compared as before. An original still in dispatch has no witness, so it stays
pending and is still refused `F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED`.
Restoring the one comparison reproduces the pre-image digest (asserted).

The function is part of `fn_f06_mixed_custody_contract`, so the post-image
digests are carried by `MIXED_CUSTODY_CONTRACT` in
`server/scripts/engine-release-database-proof.py`, by
`tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json`, and the
shared-hand lane installs this migration after 20261001151056.

## Pinned

`tests/a-mixed-admission-accepts-the-dispatch-its-disposed-original-left-behind.law.test.ts`
(`docs/laws.d/a-mixed-admission-accepts-the-dispatch-its-disposed-original-left-behind.md`).
