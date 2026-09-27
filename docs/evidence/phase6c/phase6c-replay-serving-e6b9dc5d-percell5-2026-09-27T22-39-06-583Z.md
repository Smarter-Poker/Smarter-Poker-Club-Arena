# Phase 6C exact-input replay evidence (2026-09-27T22:39:06.583Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`. Evidence shape: aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position.

## Batch

- Command: `node scripts/phase6c-replay.mjs /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/journal-copy-e6b9dc5d-percell5.ndjson --engine-sha e6b9dc5d472a040a118f537f65203a6cae45ce80 --limit 355 --since 2026-09-27T20:57:00Z --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-chart-store-2c8a2d9f448e.json --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-solver-store-postflop-dff78313b437.json --store-pins ../docs/evidence/phase6c/phase6c-store-pins-2026-09-27.json --label serving-e6b9dc5d-percell5 --out ../docs/evidence/phase6c --full-verdicts /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/full-verdicts-percell.json --note 'predeclared coverage batch: from the same 50164-record e6b9dc5d window copy (2026-09-27T20:57:00Z to 21:55:00Z), the newest 5 DECIDE_FAST records of every (format, variant, street) cell observed in the window, 72 cells and 355 records; DECIDE_DEEP records are not selected (they are counted and refused by name in the newest-2000 batch)' --note 'solver stores recorded beside every decision: charts 240, postflop 7747, postflopV31 0, no external policy artifact, charts loaded 2026-09-27T20:56:31.337Z; matched to the pinned snapshots in phase6c-store-pins-2026-09-27.json'`
- Batch rule: newest 355 journaled decision records at or after 2026-09-27T20:57:00Z, in journal order
- Source: ndjson copy (355 records)
- Decisions from 2026-09-27T21:08:28.669Z to 2026-09-27T21:53:48.462Z
- Serving engine SHA (declared): `e6b9dc5d472a040a118f537f65203a6cae45ce80`
- Replay engine SHA (code that ran): `ec15b4daff3a2224b592c753d7e193eeb094a824` (not the serving engine)
- Releases recorded on the replayed rows: `e6b9dc5d472a040a118f537f65203a6cae45ce80`
- Rows for the serving engine in this batch: 355
- Chart store at replay: 240 entries, digest `2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf`, revision 2026-07-19T15:11:48.555537+00:00
- Postflop store at replay: 7747 entries, digest `dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d`, revision 2026-09-03T18:18:13.594197+00:00
- Snapshot chart_store: fetched 2026-09-27T22:18:16.947Z to 2026-09-27T22:18:17.572Z from memory_charts_gold through the production loader, identity recomputed by the store module on load
- Snapshot solver_store:postflop: fetched 2026-09-27T22:18:18.975Z to 2026-09-27T22:18:37.081Z from gto_postflop_compact through the production loader, identity recomputed by the store module on load
- Pin chart_store: 240@`2c8a2d9f448e5dd2`, source unchanged 2026-09-10T02:34:36.095Z to 2026-09-27T22:18:52.902Z; witness: Read twice through the Supabase SQL interface, at 2026-09-27T22:13:57.415Z (before the fetch) and 22:18:52.902Z (after it): pg_postmaster_start_time 2026-09-10T02:34:36.095Z; pg_stat_user_tables n_tup_ins 0, n_tup_upd 0, n_tup_del 0 on both reads; relfilenode 82206 on both reads; count 240 and max(created_at) 2026-07-19T15:11:48.555537Z on both reads and in the fetched rows. Cumulative table statistics are reset only by a crash restart (which moves the postmaster start) or an explicit reset, so zero writes on both reads means no row was inserted, updated or deleted between the postmaster start and the second read.
- Pin solver_store:postflop: 7747@`dff78313b437357d`, source unchanged 2026-09-10T02:34:36.095Z to 2026-09-27T22:18:52.902Z; witness: Read twice through the Supabase SQL interface, at 2026-09-27T22:13:57.415Z and 22:18:52.902Z: pg_postmaster_start_time 2026-09-10T02:34:36.095Z; pg_stat_user_tables n_tup_ins 0, n_tup_upd 0, n_tup_del 0 on both reads; relfilenode 17187839 on both reads; count 7747 and max(built_at) 2026-09-03T18:18:13.594197Z on both reads and at both ends of the paged fetch.
- Release `e6b9dc5d472a` committed 2026-09-27T18:59:46.000Z (no process running it started earlier)
- Decision-code files that differ, serving engine to replay code: `server/src/engine/EquityLoadGovernor.ts`, `server/src/engine/GtoCharts.ts`, `server/src/engine/GtoPostflop.ts`, `server/src/engine/horseDecision/protocol.ts`, `server/src/engine/horseDecision/workerRuntime.ts`, `server/src/gto/SolverStoreIdentity.ts`
- Decision-code files that differ, recorded release `e6b9dc5d472a` to replay code: `server/src/engine/EquityLoadGovernor.ts`, `server/src/engine/GtoCharts.ts`, `server/src/engine/GtoPostflop.ts`, `server/src/engine/horseDecision/protocol.ts`, `server/src/engine/horseDecision/workerRuntime.ts`, `server/src/gto/SolverStoreIdentity.ts`
- Note: predeclared coverage batch: from the same 50164-record e6b9dc5d window copy (2026-09-27T20:57:00Z to 21:55:00Z), the newest 5 DECIDE_FAST records of every (format, variant, street) cell observed in the window, 72 cells and 355 records; DECIDE_DEEP records are not selected (they are counted and refused by name in the newest-2000 batch)
- Note: solver stores recorded beside every decision: charts 240, postflop 7747, postflopV31 0, no external policy artifact, charts loaded 2026-09-27T20:56:31.337Z; matched to the pinned snapshots in phase6c-store-pins-2026-09-27.json

## Result

- Total: 355
- reproduced: 354 of 355
- diverged: 1 of 355
- refused: 0 of 355
- Independent qualification: agreed 355, disagreed 0, refused (reference unavailable) 0
- Receipt digest equal to the original: 350 of 355 replayed
- Authority owner identical between original and replay: 355 of 355 replayed

### Status and reason

| status:reason                | count |
| ---------------------------- | ----- |
| reproduced:clean             | 350   |
| reproduced:rng_after_differs | 4     |
| diverged:action              | 1     |

### Solver-store references

| reference             | status and detail                                                                                                                     | decisions |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| chart_store           | available: pinned 240@2c8a2d9f448e (pg_stat ins/upd/del 0 since postmaster start 2026-09-10T02:34:36Z, read 22:13:57Z and 22:18:52Z)  | 1         |
| solver_store:postflop | available: pinned 7747@dff78313b437 (pg_stat ins/upd/del 0 since postmaster start 2026-09-10T02:34:36Z, read 22:13:57Z and 22:18:52Z) | 60        |

### Latency and work

- Replay computeMs median 5.81, p95 15.91; original computeMs median 18.70, p95 95.21; replay wall (runtime round trip) median 6.06, p95 16.16
- Equity samples per replay: median 170, max 450; equity calls median 1; policy-graph node visits median 8

### Authority (module that produced the accepted action, original decisions)

| module                    | count |
| ------------------------- | ----- |
| reference:postflop        | 260   |
| reference:intent_engine   | 88    |
| reference_legality        | 5     |
| reference:chart_bb_defend | 1     |
| reference:variant_price   | 1     |

## Coverage Matrix (format x variant x street x outcome)

180 declared cells (5 formats x 9 registered variants x 4 streets): 72 observed, of which 71 fully replayed, 1 partly unreplayed and 0 unreplayed; 108 unobserved; 0 observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.

### Observed cells

| format | variant    | street  | observed | reproduced | diverged | refused | coverage          | outcomes (route or reason)                                       | table sizes   |
| ------ | ---------- | ------- | -------- | ---------- | -------- | ------- | ----------------- | ---------------------------------------------------------------- | ------------- |
| cash   | nlh        | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 6 5           |
| cash   | nlh        | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 1; 6 4      |
| cash   | nlh        | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 4; 6 1      |
| cash   | nlh        | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 3; 6 2      |
| cash   | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 2 5           |
| cash   | plo4       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | plo4       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | plo4       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 5 5           |
| cash   | plo5       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 2; 5 3      |
| cash   | plo5       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 2; 5 3      |
| cash   | plo5       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 2; 5 3      |
| cash   | plo6       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 1; 6 4      |
| cash   | plo6       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 2; 6 3      |
| cash   | plo6       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 1; 6 4      |
| cash   | plo6       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 2; 4 3      |
| cash   | plo8       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 2 5           |
| cash   | plo8       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | plo8       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | plo8       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | short_deck | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 5           |
| cash   | short_deck | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| cash   | short_deck | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| cash   | short_deck | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| cash   | pineapple  | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 6 5           |
| cash   | pineapple  | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 6 5           |
| cash   | pineapple  | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 6 5           |
| cash   | pineapple  | river   | 3        | 3          | 0        | 0       | replayed          | reproduced:reference:postflop 3                                  | 6 3           |
| cash   | flh        | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 5           |
| cash   | flh        | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| cash   | flh        | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| cash   | flh        | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| mtt    | nlh        | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 4 3; 6 2      |
| mtt    | nlh        | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| mtt    | nlh        | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 2; 5 1; 6 2 |
| mtt    | nlh        | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 5 2; 6 3      |
| mtt    | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 1; 5 4      |
| mtt    | plo4       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 5 5           |
| mtt    | plo4       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 5 5           |
| mtt    | plo4       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 5 5           |
| mtt    | plo5       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 2 1; 4 2; 5 2 |
| mtt    | plo5       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 4 2; 5 3      |
| mtt    | plo5       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 4 2; 5 3      |
| mtt    | plo5       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 5 5           |
| mtt    | plo6       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 5           |
| mtt    | plo6       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 3 5           |
| mtt    | plo6       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| mtt    | plo6       | river   | 2        | 2          | 0        | 0       | replayed          | reproduced:reference:postflop 2                                  | 2 2           |
| spin   | nlh        | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 5           |
| spin   | nlh        | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 3; 3 2      |
| spin   | nlh        | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| spin   | nlh        | river   | 5        | 4          | 1        | 0       | partly unreplayed | reproduced:reference:postflop 4; diverged:action 1               | 3 5           |
| spin   | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 4; reproduced:variant_price 1           | 2 2; 3 3      |
| spin   | plo4       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 5           |
| spin   | plo4       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| spin   | plo4       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| spin   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 2 5           |
| spin   | plo5       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 5           |
| spin   | plo5       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 5           |
| spin   | plo5       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| spin   | plo6       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 3 5           |
| spin   | plo6       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 2; 3 3      |
| spin   | plo6       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| spin   | plo6       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| hu_sng | nlh        | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 4; reproduced:chart_bb_defend 1         | 2 5           |
| hu_sng | nlh        | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | nlh        | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | nlh        | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                       | 2 5           |
| hu_sng | plo4       | flop    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 5           |
| hu_sng | plo4       | turn    | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | plo4       | river   | 5        | 5          | 0        | 0       | replayed          | reproduced:reference:postflop 5                                  | 2 5           |

### Unreplayed decisions by cell and named reason

| format | variant | street | reason          | decisions |
| ------ | ------- | ------ | --------------- | --------- |
| spin   | nlh     | river  | diverged:action | 1         |

### Unobserved cells

| format | variant    | unobserved streets |
| ------ | ---------- | ------------------ |
| cash   | flo8       | all four           |
| mtt    | plo8       | all four           |
| mtt    | short_deck | all four           |
| mtt    | pineapple  | all four           |
| mtt    | flh        | all four           |
| mtt    | flo8       | all four           |
| sng    | nlh        | all four           |
| sng    | plo4       | all four           |
| sng    | plo5       | all four           |
| sng    | plo6       | all four           |
| sng    | plo8       | all four           |
| sng    | short_deck | all four           |
| sng    | pineapple  | all four           |
| sng    | flh        | all four           |
| sng    | flo8       | all four           |
| spin   | plo8       | all four           |
| spin   | short_deck | all four           |
| spin   | pineapple  | all four           |
| spin   | flh        | all four           |
| spin   | flo8       | all four           |
| hu_sng | plo5       | all four           |
| hu_sng | plo6       | all four           |
| hu_sng | plo8       | all four           |
| hu_sng | short_deck | all four           |
| hu_sng | pineapple  | all four           |
| hu_sng | flh        | all four           |
| hu_sng | flo8       | all four           |

## Decisions

| #   | release  | format/variant/street/size | route orig/replay               | action same | status     | reason            | compute orig/replay ms | wall ms | samples | node visits | authority                 |
| --- | -------- | -------------------------- | ------------------------------- | ----------- | ---------- | ----------------- | ---------------------- | ------- | ------- | ----------- | ------------------------- |
| 1   | e6b9dc5d | cash/plo6/river/3p         | -/-                             | yes         | reproduced |                   | 10.10/39.80            | 48.98   | 120     | 8           | reference:postflop        |
| 2   | e6b9dc5d | cash/plo6/river/3p         | -/-                             | yes         | reproduced |                   | 9.91/4.72              | 5.28    | 120     | 8           | reference:postflop        |
| 3   | e6b9dc5d | cash/plo6/turn/6p          | -/-                             | yes         | reproduced |                   | 19.44/10.82            | 11.13   | 120     | 8           | reference:postflop        |
| 4   | e6b9dc5d | mtt/plo5/river/5p          | -/-                             | yes         | reproduced |                   | 62.23/48.11            | 49.51   | 170     | 8           | reference:postflop        |
| 5   | e6b9dc5d | cash/plo6/turn/6p          | -/-                             | yes         | reproduced |                   | 22.80/11.62            | 12.57   | 120     | 8           | reference:postflop        |
| 6   | e6b9dc5d | cash/plo6/turn/3p          | -/-                             | yes         | reproduced |                   | 10.97/4.76             | 5.03    | 120     | 8           | reference:postflop        |
| 7   | e6b9dc5d | cash/plo6/turn/6p          | -/-                             | yes         | reproduced |                   | 38.09/10.22            | 10.54   | 120     | 8           | reference:postflop        |
| 8   | e6b9dc5d | cash/plo6/turn/6p          | -/-                             | yes         | reproduced |                   | 28.59/8.64             | 8.92    | 120     | 8           | reference:postflop        |
| 9   | e6b9dc5d | cash/plo6/flop/6p          | -/-                             | yes         | reproduced |                   | 35.73/10.09            | 10.35   | 120     | 8           | reference:postflop        |
| 10  | e6b9dc5d | mtt/plo5/river/5p          | -/-                             | yes         | reproduced |                   | 58.93/17.16            | 17.60   | 170     | 8           | reference:postflop        |
| 11  | e6b9dc5d | cash/plo6/flop/6p          | -/-                             | yes         | reproduced |                   | 20.92/9.60             | 9.81    | 120     | 8           | reference:postflop        |
| 12  | e6b9dc5d | mtt/plo5/river/5p          | -/-                             | yes         | reproduced |                   | 49.09/16.26            | 16.83   | 170     | 8           | reference:postflop        |
| 13  | e6b9dc5d | mtt/plo5/river/5p          | -/-                             | yes         | reproduced |                   | 30.17/12.83            | 13.18   | 170     | 8           | reference:postflop        |
| 14  | e6b9dc5d | mtt/plo5/river/5p          | -/-                             | yes         | reproduced |                   | 37.00/11.62            | 11.91   | 170     | 8           | reference:postflop        |
| 15  | e6b9dc5d | cash/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 8.60/5.77              | 6.48    | 450     | 8           | reference:postflop        |
| 16  | e6b9dc5d | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |                   | 17.69/14.05            | 14.40   | 450     | 8           | reference:postflop        |
| 17  | e6b9dc5d | cash/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 7.14/3.05              | 3.25    | 450     | 8           | reference:postflop        |
| 18  | e6b9dc5d | cash/plo6/flop/3p          | -/-                             | yes         | reproduced |                   | 10.14/3.66             | 3.85    | 120     | 8           | reference:postflop        |
| 19  | e6b9dc5d | cash/plo6/river/4p         | -/-                             | yes         | reproduced |                   | 11.50/6.77             | 6.96    | 120     | 8           | reference:postflop        |
| 20  | e6b9dc5d | mtt/plo5/turn/5p           | -/-                             | yes         | reproduced |                   | 37.32/17.53            | 17.91   | 170     | 8           | reference:postflop        |
| 21  | e6b9dc5d | spin/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 15.75/26.04            | 26.32   | 220     | 8           | reference:postflop        |
| 22  | e6b9dc5d | cash/plo6/river/4p         | -/-                             | yes         | reproduced |                   | 15.76/6.23             | 6.45    | 120     | 8           | reference:postflop        |
| 23  | e6b9dc5d | cash/plo6/river/4p         | -/-                             | yes         | reproduced |                   | 12.03/6.73             | 6.98    | 120     | 8           | reference:postflop        |
| 24  | e6b9dc5d | spin/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 15.18/6.94             | 7.23    | 220     | 8           | reference:postflop        |
| 25  | e6b9dc5d | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |                   | 27.38/14.12            | 14.43   | 450     | 8           | reference:postflop        |
| 26  | e6b9dc5d | mtt/nlh/preflop/4p         | intent_engine/intent_engine     | yes         | reproduced |                   | 13.22/8.79             | 9.06    | 320     | 8           | reference:intent_engine   |
| 27  | e6b9dc5d | cash/plo6/flop/3p          | -/-                             | yes         | reproduced |                   | 6.79/3.20              | 3.41    | 120     | 8           | reference:postflop        |
| 28  | e6b9dc5d | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |                   | 14.72/11.96            | 12.27   | 450     | 8           | reference:postflop        |
| 29  | e6b9dc5d | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |                   | 19.29/11.14            | 11.36   | 450     | 8           | reference:postflop        |
| 30  | e6b9dc5d | spin/plo5/river/2p         | -/-                             | yes         | reproduced |                   | 15.26/6.43             | 6.70    | 170     | 8           | reference:postflop        |
| 31  | e6b9dc5d | mtt/plo5/turn/5p           | -/-                             | yes         | reproduced |                   | 35.39/15.91            | 16.16   | 170     | 8           | reference:postflop        |
| 32  | e6b9dc5d | cash/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 8.15/4.39              | 4.59    | 450     | 8           | reference:postflop        |
| 33  | e6b9dc5d | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |                   | 17.28/10.78            | 11.02   | 450     | 8           | reference:postflop        |
| 34  | e6b9dc5d | spin/plo5/river/2p         | -/-                             | yes         | reproduced |                   | 33.91/9.10             | 9.34    | 170     | 8           | reference:postflop        |
| 35  | e6b9dc5d | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |                   | 3.43/1.79              | 1.98    | 450     | 8           | reference:postflop        |
| 36  | e6b9dc5d | cash/plo6/flop/6p          | -/-                             | yes         | reproduced |                   | 21.48/9.32             | 9.51    | 120     | 8           | reference:postflop        |
| 37  | e6b9dc5d | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |                   | 16.74/6.53             | 6.78    | 220     | 8           | reference:postflop        |
| 38  | e6b9dc5d | spin/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 26.66/11.42            | 11.67   | 220     | 8           | reference:postflop        |
| 39  | e6b9dc5d | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |                   | 48.30/9.68             | 10.18   | 450     | 8           | reference:postflop        |
| 40  | e6b9dc5d | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |                   | 16.61/11.47            | 11.74   | 450     | 8           | reference:postflop        |
| 41  | e6b9dc5d | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |                   | 36.98/18.41            | 18.68   | 450     | 8           | reference:postflop        |
| 42  | e6b9dc5d | mtt/plo5/turn/4p           | -/-                             | yes         | reproduced |                   | 27.74/13.17            | 13.47   | 170     | 8           | reference:postflop        |
| 43  | e6b9dc5d | mtt/plo5/turn/5p           | -/-                             | yes         | reproduced |                   | 34.23/14.46            | 15.03   | 170     | 8           | reference:postflop        |
| 44  | e6b9dc5d | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |                   | 31.65/6.83             | 7.30    | 170     | 8           | reference:postflop        |
| 45  | e6b9dc5d | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |                   | 21.11/9.79             | 10.01   | 450     | 8           | reference:postflop        |
| 46  | e6b9dc5d | cash/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 8.00/3.29              | 3.50    | 450     | 8           | reference:postflop        |
| 47  | e6b9dc5d | spin/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 22.42/7.98             | 8.21    | 220     | 8           | reference:postflop        |
| 48  | e6b9dc5d | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 100.75/6.38            | 6.92    | 220     | 8           | reference_legality        |
| 49  | e6b9dc5d | mtt/plo5/turn/4p           | -/-                             | yes         | reproduced |                   | 339.00/12.41           | 12.67   | 170     | 8           | reference:postflop        |
| 50  | e6b9dc5d | cash/plo5/river/5p         | -/-                             | yes         | reproduced |                   | 21.03/4.40             | 4.58    | 170     | 8           | reference:postflop        |
| 51  | e6b9dc5d | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                   | 176.12/6.23            | 6.50    | 320     | 8           | reference:intent_engine   |
| 52  | e6b9dc5d | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |                   | 4.93/1.54              | 1.99    | 450     | 8           | reference:postflop        |
| 53  | e6b9dc5d | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |                   | 23.83/11.70            | 11.92   | 450     | 8           | reference:postflop        |
| 54  | e6b9dc5d | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |                   | 26.73/5.60             | 5.91    | 220     | 8           | reference_legality        |
| 55  | e6b9dc5d | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |                   | 27.15/10.45            | 10.75   | 450     | 8           | reference:postflop        |
| 56  | e6b9dc5d | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |                   | 24.35/8.89             | 9.13    | 170     | 8           | reference:postflop        |
| 57  | e6b9dc5d | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |                   | 18.30/11.56            | 12.12   | 450     | 8           | reference:postflop        |
| 58  | e6b9dc5d | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |                   | 44.64/9.69             | 10.28   | 220     | 8           | reference:postflop        |
| 59  | e6b9dc5d | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                   | 19.29/5.75             | 6.02    | 320     | 8           | reference:intent_engine   |
| 60  | e6b9dc5d | cash/plo6/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                   | 10.39/2.60             | 3.14    | 0       | 8           | reference:intent_engine   |
| 61  | e6b9dc5d | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |                   | 23.26/11.23            | 11.48   | 450     | 8           | reference:postflop        |
| 62  | e6b9dc5d | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |                   | 3.10/0.63              | 0.83    | 450     | 8           | reference:postflop        |
| 63  | e6b9dc5d | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 19.71/9.18             | 9.40    | 220     | 8           | reference:intent_engine   |
| 64  | e6b9dc5d | mtt/nlh/preflop/4p         | intent_engine/intent_engine     | yes         | reproduced |                   | 20.61/6.20             | 6.47    | 320     | 8           | reference:intent_engine   |
| 65  | e6b9dc5d | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 33.39/7.30             | 7.48    | 320     | 8           | reference:intent_engine   |
| 66  | e6b9dc5d | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |                   | 38.34/9.28             | 9.55    | 220     | 8           | reference:postflop        |
| 67  | e6b9dc5d | cash/nlh/flop/3p           | -/-                             | yes         | reproduced |                   | 69.12/1.82             | 1.99    | 156     | 8           | reference:postflop        |
| 68  | e6b9dc5d | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |                   | 34.14/5.40             | 5.63    | 77      | 8           | reference:postflop        |
| 69  | e6b9dc5d | cash/plo5/river/3p         | -/-                             | yes         | reproduced |                   | 10.18/2.18             | 2.40    | 60      | 8           | reference:postflop        |
| 70  | e6b9dc5d | cash/plo6/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                   | 6.57/2.89              | 3.05    | 0       | 8           | reference:intent_engine   |
| 71  | e6b9dc5d | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 17.86/2.55             | 2.80    | 112     | 8           | reference:intent_engine   |
| 72  | e6b9dc5d | mtt/nlh/preflop/4p         | intent_engine/intent_engine     | yes         | reproduced |                   | 48.54/12.25            | 12.47   | 112     | 8           | reference:intent_engine   |
| 73  | e6b9dc5d | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 17.49/5.16             | 5.39    | 77      | 8           | reference:postflop        |
| 74  | e6b9dc5d | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.94/0.23              | 0.45    | 0       | 8           | reference:intent_engine   |
| 75  | e6b9dc5d | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |                   | 76.80/21.28            | 21.48   | 450     | 8           | reference:postflop        |
| 76  | e6b9dc5d | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                   | 36.89/7.91             | 8.17    | 320     | 8           | reference:intent_engine   |
| 77  | e6b9dc5d | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 49.57/8.62             | 9.02    | 320     | 8           | reference:intent_engine   |
| 78  | e6b9dc5d | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 69.98/7.90             | 8.12    | 220     | 8           | reference:postflop        |
| 79  | e6b9dc5d | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |                   | 151.41/9.41            | 9.66    | 220     | 8           | reference:postflop        |
| 80  | e6b9dc5d | cash/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 2.59/0.29              | 0.47    | 0       | 8           | reference:intent_engine   |
| 81  | e6b9dc5d | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                   | 44.11/8.56             | 8.76    | 320     | 8           | reference:intent_engine   |
| 82  | e6b9dc5d | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 43.76/10.09            | 10.42   | 170     | 8           | reference:intent_engine   |
| 83  | e6b9dc5d | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 80.53/8.63             | 8.90    | 160     | 8           | reference:intent_engine   |
| 84  | e6b9dc5d | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                   | 18.33/3.15             | 3.34    | 320     | 8           | reference:chart_bb_defend |
| 85  | e6b9dc5d | cash/plo6/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                   | 7.71/2.47              | 2.63    | 0       | 8           | reference:intent_engine   |
| 86  | e6b9dc5d | cash/plo5/river/5p         | -/-                             | yes         | reproduced |                   | 14.27/5.98             | 6.17    | 170     | 8           | reference:postflop        |
| 87  | e6b9dc5d | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |                   | 32.26/8.82             | 9.03    | 220     | 8           | reference:postflop        |
| 88  | e6b9dc5d | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 26.26/4.57             | 4.80    | 320     | 8           | reference:intent_engine   |
| 89  | e6b9dc5d | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |                   | 39.64/10.18            | 10.52   | 220     | 8           | reference:postflop        |
| 90  | e6b9dc5d | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 31.15/9.41             | 9.59    | 160     | 8           | reference:intent_engine   |
| 91  | e6b9dc5d | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 51.96/15.58            | 15.83   | 220     | 8           | reference:intent_engine   |
| 92  | e6b9dc5d | spin/plo4/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                   | 28.09/7.78             | 8.01    | 396     | 8           | reference:variant_price   |
| 93  | e6b9dc5d | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                   | 4.87/1.64              | 1.92    | 0       | 8           | reference:intent_engine   |
| 94  | e6b9dc5d | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                   | 33.00/5.99             | 6.42    | 320     | 8           | reference:intent_engine   |
| 95  | e6b9dc5d | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                   | 51.90/4.65             | 4.87    | 132     | 8           | reference:intent_engine   |
| 96  | e6b9dc5d | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                   | 34.83/5.56             | 6.07    | 192     | 8           | reference:intent_engine   |
| 97  | e6b9dc5d | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 30.91/7.62             | 7.88    | 192     | 8           | reference:intent_engine   |
| 98  | e6b9dc5d | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |                   | 2.23/0.98              | 1.29    | 132     | 8           | reference:postflop        |
| 99  | e6b9dc5d | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 17.70/5.01             | 5.24    | 96      | 8           | reference:intent_engine   |
| 100 | e6b9dc5d | cash/plo6/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                   | 3.75/2.36              | 2.55    | 0       | 8           | reference:intent_engine   |
| 101 | e6b9dc5d | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 32.27/8.52             | 9.59    | 220     | 8           | reference:postflop        |
| 102 | e6b9dc5d | spin/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 20.59/6.99             | 7.38    | 220     | 8           | reference:intent_engine   |
| 103 | e6b9dc5d | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 87.52/18.34            | 18.62   | 160     | 8           | reference:intent_engine   |
| 104 | e6b9dc5d | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                   | 49.36/8.65             | 8.92    | 220     | 8           | reference:intent_engine   |
| 105 | e6b9dc5d | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 31.35/7.00             | 7.66    | 170     | 8           | reference:intent_engine   |
| 106 | e6b9dc5d | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 61.85/7.71             | 7.98    | 160     | 8           | reference:intent_engine   |
| 107 | e6b9dc5d | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                   | 38.81/7.74             | 8.29    | 220     | 8           | reference:intent_engine   |
| 108 | e6b9dc5d | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |                   | 13.49/6.82             | 7.18    | 170     | 8           | reference:postflop        |
| 109 | e6b9dc5d | mtt/plo4/river/5p          | -/-                             | yes         | reproduced |                   | 9.44/3.53              | 4.20    | 220     | 8           | reference:postflop        |
| 110 | e6b9dc5d | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                   | 18.63/6.19             | 6.46    | 220     | 8           | reference:intent_engine   |
| 111 | e6b9dc5d | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                   | 38.93/7.01             | 7.36    | 220     | 8           | reference:intent_engine   |
| 112 | e6b9dc5d | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |                   | 26.50/7.23             | 7.48    | 220     | 8           | reference:postflop        |
| 113 | e6b9dc5d | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 18.22/7.34             | 7.71    | 170     | 8           | reference:intent_engine   |
| 114 | e6b9dc5d | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                   | 19.05/6.66             | 6.89    | 220     | 8           | reference:intent_engine   |
| 115 | e6b9dc5d | cash/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 7.86/2.97              | 3.20    | 220     | 8           | reference:postflop        |
| 116 | e6b9dc5d | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |                   | 9.38/2.95              | 3.19    | 220     | 8           | reference:postflop        |
| 117 | e6b9dc5d | mtt/plo5/flop/4p           | -/-                             | yes         | reproduced |                   | 54.85/12.47            | 13.06   | 170     | 8           | reference:postflop        |
| 118 | e6b9dc5d | mtt/plo5/flop/5p           | -/-                             | yes         | reproduced |                   | 47.07/15.31            | 15.61   | 170     | 8           | reference:postflop        |
| 119 | e6b9dc5d | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 22.76/6.96             | 7.21    | 170     | 8           | reference:intent_engine   |
| 120 | e6b9dc5d | cash/plo5/river/3p         | -/-                             | yes         | reproduced |                   | 28.44/6.34             | 6.83    | 170     | 8           | reference:postflop        |
| 121 | e6b9dc5d | cash/plo5/turn/5p          | -/-                             | yes         | reproduced |                   | 35.02/6.24             | 6.49    | 170     | 8           | reference:postflop        |
| 122 | e6b9dc5d | cash/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 12.39/6.30             | 6.55    | 300     | 8           | reference:postflop        |
| 123 | e6b9dc5d | cash/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.75/0.30              | 0.49    | 0       | 8           | reference:intent_engine   |
| 124 | e6b9dc5d | cash/plo5/turn/5p          | -/-                             | yes         | reproduced |                   | 14.58/6.53             | 6.71    | 170     | 8           | reference:postflop        |
| 125 | e6b9dc5d | mtt/plo5/flop/5p           | -/-                             | yes         | reproduced |                   | 31.42/15.09            | 15.67   | 170     | 8           | reference:postflop        |
| 126 | e6b9dc5d | mtt/plo4/river/5p          | -/-                             | yes         | reproduced |                   | 5.57/2.98              | 3.52    | 220     | 8           | reference:postflop        |
| 127 | e6b9dc5d | cash/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 10.95/3.77             | 4.05    | 300     | 8           | reference:postflop        |
| 128 | e6b9dc5d | mtt/plo5/flop/4p           | -/-                             | yes         | reproduced |                   | 30.50/12.54            | 12.85   | 170     | 8           | reference:postflop        |
| 129 | e6b9dc5d | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 20.28/7.94             | 8.43    | 170     | 8           | reference:intent_engine   |
| 130 | e6b9dc5d | cash/plo5/turn/3p          | -/-                             | yes         | reproduced |                   | 13.28/5.63             | 5.78    | 170     | 8           | reference:postflop        |
| 131 | e6b9dc5d | mtt/plo4/river/5p          | -/-                             | yes         | reproduced |                   | 9.28/2.69              | 3.02    | 220     | 8           | reference:postflop        |
| 132 | e6b9dc5d | cash/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.55/0.22              | 0.63    | 0       | 8           | reference:intent_engine   |
| 133 | e6b9dc5d | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |                   | 21.39/7.58             | 7.80    | 220     | 8           | reference:postflop        |
| 134 | e6b9dc5d | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 18.65/6.47             | 6.67    | 220     | 8           | reference:postflop        |
| 135 | e6b9dc5d | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                   | 18.76/1.73             | 1.87    | 0       | 8           | reference:intent_engine   |
| 136 | e6b9dc5d | mtt/plo5/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 89.08/17.41            | 17.62   | 170     | 8           | reference:intent_engine   |
| 137 | e6b9dc5d | cash/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 33.31/5.62             | 5.81    | 300     | 8           | reference:postflop        |
| 138 | e6b9dc5d | cash/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 9.40/1.59              | 1.73    | 220     | 8           | reference:postflop        |
| 139 | e6b9dc5d | cash/plo5/flop/5p          | -/-                             | yes         | reproduced |                   | 22.07/5.91             | 6.07    | 170     | 8           | reference:postflop        |
| 140 | e6b9dc5d | cash/short_deck/turn/3p    | -/-                             | yes         | reproduced |                   | 9.09/3.80              | 4.04    | 450     | 8           | reference:postflop        |
| 141 | e6b9dc5d | mtt/plo5/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                   | 24.17/10.39            | 10.66   | 170     | 8           | reference:intent_engine   |
| 142 | e6b9dc5d | mtt/plo4/flop/5p           | -/-                             | yes         | reproduced |                   | 16.17/3.84             | 4.08    | 220     | 8           | reference:postflop        |
| 143 | e6b9dc5d | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |                   | 43.62/10.74            | 10.95   | 450     | 8           | reference:postflop        |
| 144 | e6b9dc5d | cash/plo5/turn/3p          | -/-                             | yes         | reproduced |                   | 18.23/6.17             | 6.35    | 170     | 8           | reference:postflop        |
| 145 | e6b9dc5d | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                   | 4.76/1.81              | 1.97    | 0       | 8           | reference:intent_engine   |
| 146 | e6b9dc5d | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.84/0.29              | 0.53    | 0       | 8           | reference:intent_engine   |
| 147 | e6b9dc5d | mtt/plo5/flop/5p           | -/-                             | yes         | reproduced |                   | 45.91/14.22            | 14.45   | 170     | 8           | reference:postflop        |
| 148 | e6b9dc5d | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                   | 7.37/1.93              | 2.09    | 0       | 8           | reference:intent_engine   |
| 149 | e6b9dc5d | cash/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 21.05/5.00             | 5.17    | 300     | 8           | reference:postflop        |
| 150 | e6b9dc5d | mtt/plo5/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                   | 32.25/9.63             | 9.87    | 170     | 8           | reference:intent_engine   |
| 151 | e6b9dc5d | cash/plo5/flop/5p          | -/-                             | yes         | reproduced |                   | 11.07/5.55             | 5.72    | 170     | 8           | reference:postflop        |
| 152 | e6b9dc5d | cash/short_deck/turn/3p    | -/-                             | yes         | reproduced |                   | 5.69/1.06              | 1.31    | 450     | 8           | reference:postflop        |
| 153 | e6b9dc5d | mtt/plo5/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 44.62/16.63            | 16.85   | 102     | 8           | reference:intent_engine   |
| 154 | e6b9dc5d | cash/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 18.92/3.59             | 3.76    | 180     | 8           | reference:postflop        |
| 155 | e6b9dc5d | cash/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 8.77/2.51              | 2.66    | 180     | 8           | reference:postflop        |
| 156 | e6b9dc5d | cash/plo5/flop/5p          | -/-                             | yes         | reproduced |                   | 9.84/3.77              | 3.91    | 102     | 8           | reference:postflop        |
| 157 | e6b9dc5d | cash/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.42/0.20              | 0.42    | 0       | 8           | reference:intent_engine   |
| 158 | e6b9dc5d | cash/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 15.36/4.23             | 4.58    | 220     | 8           | reference:postflop        |
| 159 | e6b9dc5d | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |                   | 36.95/10.10            | 10.32   | 220     | 8           | reference:postflop        |
| 160 | e6b9dc5d | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |                   | 74.25/8.08             | 8.62    | 170     | 8           | reference:postflop        |
| 161 | e6b9dc5d | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |                   | 19.92/5.71             | 5.90    | 170     | 8           | reference:postflop        |
| 162 | e6b9dc5d | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |                   | 31.89/10.89            | 11.23   | 220     | 8           | reference:postflop        |
| 163 | e6b9dc5d | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                   | 1.14/0.28              | 0.48    | 0       | 8           | reference:intent_engine   |
| 164 | e6b9dc5d | mtt/plo4/flop/5p           | -/-                             | yes         | reproduced |                   | 44.36/10.87            | 11.15   | 220     | 8           | reference:postflop        |
| 165 | e6b9dc5d | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |                   | 27.27/10.21            | 10.46   | 220     | 8           | reference:postflop        |
| 166 | e6b9dc5d | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |                   | 54.61/14.10            | 14.63   | 450     | 8           | reference:postflop        |
| 167 | e6b9dc5d | mtt/plo4/turn/5p           | -/-                             | yes         | reproduced |                   | 28.52/10.42            | 10.68   | 220     | 8           | reference:postflop        |
| 168 | e6b9dc5d | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |                   | 11.62/5.53             | 5.71    | 170     | 8           | reference:postflop        |
| 169 | e6b9dc5d | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                   | 12.12/0.25             | 0.42    | 0       | 8           | reference:intent_engine   |
| 170 | e6b9dc5d | mtt/plo4/turn/5p           | -/-                             | yes         | reproduced |                   | 38.91/10.86            | 11.10   | 220     | 8           | reference:postflop        |
| 171 | e6b9dc5d | cash/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 10.51/1.75             | 1.91    | 77      | 8           | reference:postflop        |
| 172 | e6b9dc5d | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                   | 17.50/1.32             | 1.47    | 0       | 8           | reference:intent_engine   |
| 173 | e6b9dc5d | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                   | 11.71/1.31             | 1.44    | 0       | 8           | reference:intent_engine   |
| 174 | e6b9dc5d | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |                   | 26.03/1.31             | 1.43    | 270     | 8           | reference:postflop        |
| 175 | e6b9dc5d | cash/nlh/river/3p          | -/-                             | yes         | reproduced | rng_after_differs | 140.59/8.09            | 8.24    | 270     | 8           | reference:postflop        |
| 176 | e6b9dc5d | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                   | 6.15/1.66              | 1.82    | 0       | 8           | reference:intent_engine   |
| 177 | e6b9dc5d | mtt/plo4/flop/5p           | -/-                             | yes         | reproduced |                   | 78.55/7.74             | 8.04    | 60      | 8           | reference:postflop        |
| 178 | e6b9dc5d | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |                   | 4.00/0.52              | 0.67    | 90      | 8           | reference:postflop        |
| 179 | e6b9dc5d | cash/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 71.08/1.71             | 1.93    | 60      | 8           | reference:postflop        |
| 180 | e6b9dc5d | cash/nlh/river/6p          | -/-                             | yes         | reproduced |                   | 7.01/0.66              | 0.91    | 90      | 8           | reference:postflop        |
| 181 | e6b9dc5d | cash/nlh/river/6p          | -/-                             | yes         | reproduced |                   | 6.19/0.72              | 0.93    | 450     | 8           | reference:postflop        |
| 182 | e6b9dc5d | cash/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 2.06/0.19              | 0.33    | 0       | 8           | reference:intent_engine   |
| 183 | e6b9dc5d | cash/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 50.02/4.95             | 5.10    | 220     | 8           | reference:postflop        |
| 184 | e6b9dc5d | spin/plo4/turn/2p          | -/-                             | yes         | reproduced |                   | 43.60/10.82            | 11.03   | 220     | 8           | reference:postflop        |
| 185 | e6b9dc5d | mtt/plo4/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 95.84/9.50             | 9.74    | 220     | 8           | reference:intent_engine   |
| 186 | e6b9dc5d | cash/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.88/0.26              | 0.42    | 0       | 8           | reference:intent_engine   |
| 187 | e6b9dc5d | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 1.04/0.32              | 0.67    | 0       | 8           | reference:intent_engine   |
| 188 | e6b9dc5d | mtt/plo4/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 158.14/14.59           | 14.84   | 132     | 8           | reference:intent_engine   |
| 189 | e6b9dc5d | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 6.10/1.53              | 2.02    | 0       | 8           | reference:intent_engine   |
| 190 | e6b9dc5d | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                   | 0.69/0.58              | 0.72    | 0       | 8           | reference:intent_engine   |
| 191 | e6b9dc5d | mtt/plo4/flop/5p           | -/-                             | yes         | reproduced |                   | 39.44/10.41            | 10.63   | 220     | 8           | reference:postflop        |
| 192 | e6b9dc5d | mtt/plo4/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 51.38/19.19            | 19.42   | 187     | 8           | reference:intent_engine   |
| 193 | e6b9dc5d | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                   | 1.05/0.20              | 0.50    | 0       | 8           | reference:intent_engine   |
| 194 | e6b9dc5d | mtt/plo4/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                   | 58.62/19.66            | 19.94   | 187     | 8           | reference:intent_engine   |
| 195 | e6b9dc5d | cash/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 11.20/3.43             | 3.67    | 220     | 8           | reference:postflop        |
| 196 | e6b9dc5d | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 4.60/1.86              | 2.07    | 0       | 8           | reference:intent_engine   |
| 197 | e6b9dc5d | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 5.37/2.00              | 2.18    | 0       | 8           | reference:intent_engine   |
| 198 | e6b9dc5d | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                   | 5.89/1.98              | 2.16    | 0       | 8           | reference:intent_engine   |
| 199 | e6b9dc5d | cash/plo4/flop/2p          | -/-                             | yes         | reproduced |                   | 18.17/3.43             | 3.64    | 220     | 8           | reference:postflop        |
| 200 | e6b9dc5d | mtt/plo4/flop/5p           | -/-                             | yes         | reproduced |                   | 41.88/10.01            | 10.54   | 220     | 8           | reference:postflop        |
| 201 | e6b9dc5d | cash/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 6.95/1.65              | 1.83    | 450     | 8           | reference:postflop        |
| 202 | e6b9dc5d | cash/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 3.88/1.53              | 1.70    | 450     | 8           | reference:postflop        |
| 203 | e6b9dc5d | cash/nlh/turn/6p           | -/-                             | yes         | reproduced |                   | 43.61/8.66             | 8.85    | 450     | 8           | reference:postflop        |
| 204 | e6b9dc5d | mtt/nlh/turn/2p            | -/-                             | yes         | reproduced |                   | 25.54/11.64            | 12.41   | 450     | 8           | reference:postflop        |
| 205 | e6b9dc5d | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |                   | 2.53/1.09              | 1.31    | 450     | 8           | reference:postflop        |
| 206 | e6b9dc5d | mtt/nlh/turn/2p            | -/-                             | yes         | reproduced |                   | 36.99/11.96            | 12.19   | 450     | 8           | reference:postflop        |
| 207 | e6b9dc5d | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |                   | 3.45/1.80              | 1.96    | 450     | 8           | reference:postflop        |
| 208 | e6b9dc5d | mtt/nlh/flop/2p            | -/-                             | yes         | reproduced |                   | 30.01/11.94            | 12.16   | 450     | 8           | reference:postflop        |
| 209 | e6b9dc5d | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |                   | 3.98/1.07              | 1.25    | 450     | 8           | reference:postflop        |
| 210 | e6b9dc5d | mtt/nlh/flop/2p            | -/-                             | yes         | reproduced |                   | 18.18/10.50            | 10.74   | 450     | 8           | reference:postflop        |
| 211 | e6b9dc5d | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.76/0.29              | 0.52    | 0       | 8           | reference:intent_engine   |
| 212 | e6b9dc5d | cash/short_deck/turn/3p    | -/-                             | yes         | reproduced |                   | 17.58/1.84             | 2.00    | 450     | 8           | reference:postflop        |
| 213 | e6b9dc5d | cash/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 14.13/3.89             | 4.06    | 300     | 8           | reference:postflop        |
| 214 | e6b9dc5d | mtt/plo4/river/5p          | -/-                             | yes         | reproduced |                   | 19.75/5.31             | 5.55    | 132     | 8           | reference:postflop        |
| 215 | e6b9dc5d | cash/short_deck/turn/3p    | -/-                             | yes         | reproduced |                   | 29.24/1.91             | 2.18    | 450     | 8           | reference:postflop        |
| 216 | e6b9dc5d | cash/short_deck/turn/3p    | -/-                             | yes         | reproduced |                   | 9.55/1.78              | 1.96    | 450     | 8           | reference:postflop        |
| 217 | e6b9dc5d | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 3.34/2.18              | 2.71    | 0       | 8           | reference:intent_engine   |
| 218 | e6b9dc5d | mtt/plo4/river/5p          | -/-                             | yes         | reproduced |                   | 89.91/7.17             | 7.42    | 220     | 8           | reference:postflop        |
| 219 | e6b9dc5d | mtt/plo4/turn/5p           | -/-                             | yes         | reproduced |                   | 21.41/11.84            | 12.19   | 220     | 8           | reference:postflop        |
| 220 | e6b9dc5d | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |                   | 6.34/1.85              | 2.02    | 450     | 8           | reference:postflop        |
| 221 | e6b9dc5d | mtt/nlh/flop/2p            | -/-                             | yes         | reproduced |                   | 84.47/10.69            | 11.02   | 450     | 8           | reference:postflop        |
| 222 | e6b9dc5d | mtt/plo4/turn/5p           | -/-                             | yes         | reproduced |                   | 23.73/10.63            | 10.90   | 220     | 8           | reference:postflop        |
| 223 | e6b9dc5d | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |                   | 8.79/1.75              | 1.92    | 450     | 8           | reference:postflop        |
| 224 | e6b9dc5d | mtt/nlh/flop/2p            | -/-                             | yes         | reproduced |                   | 45.16/10.34            | 10.55   | 270     | 8           | reference:postflop        |
| 225 | e6b9dc5d | mtt/nlh/flop/2p            | -/-                             | yes         | reproduced |                   | 84.52/8.76             | 8.96    | 270     | 8           | reference:postflop        |
| 226 | e6b9dc5d | mtt/nlh/river/6p           | -/-                             | yes         | reproduced |                   | 288.10/17.62           | 18.11   | 270     | 8           | reference:postflop        |
| 227 | e6b9dc5d | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                   | 0.74/0.22              | 0.62    | 0       | 8           | reference:intent_engine   |
| 228 | e6b9dc5d | mtt/nlh/river/6p           | -/-                             | yes         | reproduced |                   | 37.79/11.35            | 11.62   | 450     | 8           | reference:postflop        |
| 229 | e6b9dc5d | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                   | 4.85/1.38              | 1.82    | 0       | 8           | reference:intent_engine   |
| 230 | e6b9dc5d | cash/plo5/river/5p         | -/-                             | yes         | reproduced |                   | 148.15/7.92            | 8.08    | 170     | 8           | reference:postflop        |
| 231 | e6b9dc5d | mtt/plo4/turn/5p           | -/-                             | yes         | reproduced |                   | 170.43/7.94            | 8.31    | 77      | 8           | reference:postflop        |
| 232 | e6b9dc5d | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |                   | 29.15/4.41             | 4.99    | 102     | 8           | reference_legality        |
| 233 | e6b9dc5d | cash/plo5/turn/5p          | -/-                             | yes         | reproduced |                   | 30.07/3.80             | 4.05    | 60      | 8           | reference:postflop        |
| 234 | e6b9dc5d | mtt/nlh/river/6p           | -/-                             | yes         | reproduced |                   | 248.95/10.06           | 10.34   | 157     | 8           | reference:postflop        |
| 235 | e6b9dc5d | mtt/nlh/turn/6p            | -/-                             | yes         | reproduced |                   | 45.89/11.58            | 11.88   | 450     | 8           | reference:postflop        |
| 236 | e6b9dc5d | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |                   | 20.55/7.54             | 8.17    | 102     | 8           | reference:postflop        |
| 237 | e6b9dc5d | mtt/nlh/turn/6p            | -/-                             | yes         | reproduced |                   | 39.21/11.58            | 11.84   | 450     | 8           | reference:postflop        |
| 238 | e6b9dc5d | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |                   | 17.18/7.88             | 8.11    | 170     | 8           | reference:postflop        |
| 239 | e6b9dc5d | mtt/nlh/river/5p           | -/-                             | yes         | reproduced |                   | 55.92/9.32             | 9.87    | 270     | 8           | reference:postflop        |
| 240 | e6b9dc5d | mtt/nlh/river/5p           | -/-                             | yes         | reproduced |                   | 32.24/10.29            | 10.55   | 450     | 8           | reference:postflop        |
| 241 | e6b9dc5d | mtt/nlh/turn/5p            | -/-                             | yes         | reproduced |                   | 222.43/10.34           | 10.56   | 270     | 8           | reference:postflop        |
| 242 | e6b9dc5d | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |                   | 5.82/2.74              | 2.98    | 450     | 8           | reference:postflop        |
| 243 | e6b9dc5d | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |                   | 5.41/2.30              | 2.52    | 450     | 8           | reference:postflop        |
| 244 | e6b9dc5d | spin/plo6/flop/2p          | -/-                             | yes         | reproduced |                   | 16.65/7.20             | 7.40    | 120     | 8           | reference_legality        |
| 245 | e6b9dc5d | spin/plo6/flop/2p          | -/-                             | yes         | reproduced |                   | 20.39/5.06             | 5.53    | 72      | 8           | reference:postflop        |
| 246 | e6b9dc5d | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |                   | 14.16/5.21             | 5.47    | 102     | 8           | reference_legality        |
| 247 | e6b9dc5d | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |                   | 33.67/12.12            | 12.36   | 170     | 8           | reference:postflop        |
| 248 | e6b9dc5d | spin/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 17.57/7.63             | 7.83    | 450     | 8           | reference:postflop        |
| 249 | e6b9dc5d | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |                   | 30.38/8.98             | 9.21    | 170     | 8           | reference:postflop        |
| 250 | e6b9dc5d | spin/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 14.64/7.87             | 8.11    | 450     | 8           | reference:postflop        |
| 251 | e6b9dc5d | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 33.00/8.32             | 8.55    | 450     | 8           | reference:postflop        |
| 252 | e6b9dc5d | spin/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 67.40/8.50             | 8.74    | 220     | 8           | reference:postflop        |
| 253 | e6b9dc5d | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 170.59/7.33            | 7.88    | 450     | 8           | reference:postflop        |
| 254 | e6b9dc5d | spin/plo4/river/2p         | -/-                             | yes         | reproduced |                   | 74.31/2.10             | 2.40    | 220     | 8           | reference:postflop        |
| 255 | e6b9dc5d | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |                   | 21.64/3.77             | 4.37    | 450     | 8           | reference:postflop        |
| 256 | e6b9dc5d | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |                   | 33.95/19.24            | 19.58   | 450     | 8           | reference:postflop        |
| 257 | e6b9dc5d | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |                   | 14.36/7.62             | 7.87    | 120     | 8           | reference:postflop        |
| 258 | e6b9dc5d | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |                   | 17.82/6.90             | 7.11    | 270     | 8           | reference:postflop        |
| 259 | e6b9dc5d | spin/nlh/flop/2p           | -/-                             | yes         | reproduced |                   | 18.70/5.72             | 5.92    | 450     | 8           | reference:postflop        |
| 260 | e6b9dc5d | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |                   | 66.94/7.04             | 7.34    | 72      | 8           | reference:postflop        |
| 261 | e6b9dc5d | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |                   | 41.59/5.64             | 5.80    | 72      | 8           | reference:postflop        |
| 262 | e6b9dc5d | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |                   | 39.15/5.70             | 6.00    | 72      | 8           | reference:postflop        |
| 263 | e6b9dc5d | spin/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 141.22/11.47           | 11.75   | 450     | 8           | reference:postflop        |
| 264 | e6b9dc5d | spin/nlh/flop/2p           | -/-                             | yes         | reproduced |                   | 350.33/19.06           | 19.56   | 450     | 8           | reference:postflop        |
| 265 | e6b9dc5d | spin/nlh/river/3p          | -/-                             | no          | diverged   | action            | 82.86/10.25            | 10.49   | 270     | 8           | reference:postflop        |
| 266 | e6b9dc5d | spin/nlh/flop/2p           | -/-                             | yes         | reproduced |                   | 29.44/9.78             | 10.04   | 450     | 8           | reference:postflop        |
| 267 | e6b9dc5d | spin/nlh/river/3p          | -/-                             | yes         | reproduced |                   | 100.31/10.16           | 10.39   | 450     | 8           | reference:postflop        |
| 268 | e6b9dc5d | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 95.21/9.65             | 9.85    | 270     | 8           | reference:postflop        |
| 269 | e6b9dc5d | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |                   | 27.57/10.82            | 11.04   | 450     | 8           | reference:postflop        |
| 270 | e6b9dc5d | spin/nlh/turn/2p           | -/-                             | yes         | reproduced |                   | 25.35/8.76             | 8.97    | 270     | 8           | reference:postflop        |
| 271 | e6b9dc5d | spin/plo6/river/3p         | -/-                             | yes         | reproduced |                   | 22.31/5.79             | 6.30    | 120     | 8           | reference:postflop        |
| 272 | e6b9dc5d | spin/plo6/river/3p         | -/-                             | yes         | reproduced |                   | 22.65/10.09            | 10.29   | 120     | 8           | reference:postflop        |
| 273 | e6b9dc5d | spin/plo5/river/3p         | -/-                             | yes         | reproduced | rng_after_differs | 13.71/4.32             | 4.87    | 102     | 8           | reference:postflop        |
| 274 | e6b9dc5d | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |                   | 21.65/8.83             | 9.05    | 120     | 8           | reference:postflop        |
| 275 | e6b9dc5d | spin/plo5/river/3p         | -/-                             | yes         | reproduced |                   | 28.21/6.81             | 7.04    | 170     | 8           | reference:postflop        |
| 276 | e6b9dc5d | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |                   | 28.70/7.82             | 8.04    | 72      | 8           | reference:postflop        |
| 277 | e6b9dc5d | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |                   | 18.00/8.61             | 8.84    | 120     | 8           | reference:postflop        |
| 278 | e6b9dc5d | spin/plo5/river/3p         | -/-                             | yes         | reproduced |                   | 32.76/4.09             | 4.29    | 102     | 8           | reference:postflop        |
| 279 | e6b9dc5d | spin/plo4/river/3p         | -/-                             | yes         | reproduced |                   | 6.83/2.59              | 2.79    | 220     | 8           | reference:postflop        |
| 280 | e6b9dc5d | spin/plo4/river/3p         | -/-                             | yes         | reproduced |                   | 16.47/5.99             | 6.17    | 220     | 8           | reference:postflop        |
| 281 | e6b9dc5d | spin/plo4/river/3p         | -/-                             | yes         | reproduced |                   | 15.15/4.29             | 4.78    | 220     | 8           | reference:postflop        |
| 282 | e6b9dc5d | spin/plo6/river/2p         | -/-                             | yes         | reproduced |                   | 22.29/5.65             | 5.85    | 120     | 8           | reference:postflop        |
| 283 | e6b9dc5d | spin/plo6/river/2p         | -/-                             | yes         | reproduced |                   | 27.50/5.47             | 5.67    | 120     | 8           | reference:postflop        |
| 284 | e6b9dc5d | spin/plo6/turn/2p          | -/-                             | yes         | reproduced |                   | 15.80/7.32             | 7.60    | 120     | 8           | reference:postflop        |
| 285 | e6b9dc5d | mtt/plo6/flop/3p           | -/-                             | yes         | reproduced |                   | 13.79/5.50             | 5.71    | 120     | 8           | reference:postflop        |
| 286 | e6b9dc5d | spin/plo6/river/3p         | -/-                             | yes         | reproduced |                   | 19.96/8.56             | 8.79    | 120     | 8           | reference:postflop        |
| 287 | e6b9dc5d | mtt/plo6/turn/3p           | -/-                             | yes         | reproduced |                   | 12.88/4.82             | 5.04    | 72      | 8           | reference:postflop        |
| 288 | e6b9dc5d | mtt/plo6/turn/3p           | -/-                             | yes         | reproduced | rng_after_differs | 19.31/4.41             | 4.89    | 72      | 8           | reference:postflop        |
| 289 | e6b9dc5d | mtt/plo6/flop/3p           | -/-                             | yes         | reproduced |                   | 15.30/6.12             | 6.32    | 120     | 8           | reference:postflop        |
| 290 | e6b9dc5d | mtt/plo6/flop/3p           | -/-                             | yes         | reproduced |                   | 14.37/5.81             | 6.02    | 120     | 8           | reference:postflop        |
| 291 | e6b9dc5d | cash/pineapple/flop/6p     | -/-                             | yes         | reproduced |                   | 11.62/7.46             | 7.72    | 450     | 8           | reference:postflop        |
| 292 | e6b9dc5d | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.76/19.86             | 20.02   | 0       | 8           | reference:intent_engine   |
| 293 | e6b9dc5d | cash/flh/river/3p          | -/-                             | yes         | reproduced |                   | 2.76/0.86              | 1.42    | 270     | 8           | reference:postflop        |
| 294 | e6b9dc5d | cash/pineapple/flop/6p     | -/-                             | yes         | reproduced |                   | 8.15/4.08              | 4.22    | 157     | 8           | reference:postflop        |
| 295 | e6b9dc5d | cash/plo8/river/2p         | -/-                             | yes         | reproduced |                   | 7.52/3.12              | 3.36    | 220     | 8           | reference:postflop        |
| 296 | e6b9dc5d | cash/plo8/river/2p         | -/-                             | yes         | reproduced |                   | 18.65/4.82             | 4.97    | 220     | 8           | reference:postflop        |
| 297 | e6b9dc5d | cash/pineapple/preflop/6p  | intent_engine/intent_engine     | yes         | reproduced |                   | 3.55/9.17              | 9.32    | 0       | 8           | reference:intent_engine   |
| 298 | e6b9dc5d | cash/plo8/turn/2p          | -/-                             | yes         | reproduced |                   | 11.90/5.89             | 6.05    | 220     | 8           | reference:postflop        |
| 299 | e6b9dc5d | mtt/plo6/turn/3p           | -/-                             | yes         | reproduced |                   | 15.71/6.60             | 6.84    | 72      | 8           | reference:postflop        |
| 300 | e6b9dc5d | cash/pineapple/preflop/6p  | intent_engine/intent_engine     | yes         | reproduced |                   | 3.70/2.46              | 2.66    | 0       | 8           | reference:intent_engine   |
| 301 | e6b9dc5d | cash/pineapple/preflop/6p  | intent_engine/intent_engine     | yes         | reproduced |                   | 5.64/2.47              | 2.98    | 0       | 8           | reference:intent_engine   |
| 302 | e6b9dc5d | cash/pineapple/preflop/6p  | intent_engine/intent_engine     | yes         | reproduced |                   | 3.58/2.53              | 2.70    | 0       | 8           | reference:intent_engine   |
| 303 | e6b9dc5d | cash/plo8/flop/2p          | -/-                             | yes         | reproduced | rng_after_differs | 57.71/4.18             | 4.32    | 132     | 8           | reference:postflop        |
| 304 | e6b9dc5d | cash/pineapple/preflop/6p  | intent_engine/intent_engine     | yes         | reproduced |                   | 3.33/2.55              | 2.78    | 0       | 8           | reference:intent_engine   |
| 305 | e6b9dc5d | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 13.93/1.02             | 1.39    | 0       | 8           | reference:intent_engine   |
| 306 | e6b9dc5d | cash/pineapple/flop/6p     | -/-                             | yes         | reproduced |                   | 10.15/2.90             | 3.05    | 270     | 8           | reference:postflop        |
| 307 | e6b9dc5d | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.96/0.19              | 0.31    | 0       | 8           | reference:intent_engine   |
| 308 | e6b9dc5d | cash/flh/river/3p          | -/-                             | yes         | reproduced |                   | 2.70/0.71              | 0.83    | 270     | 8           | reference:postflop        |
| 309 | e6b9dc5d | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.86/0.15              | 0.27    | 0       | 8           | reference:intent_engine   |
| 310 | e6b9dc5d | cash/flh/river/3p          | -/-                             | yes         | reproduced |                   | 6.34/1.80              | 1.92    | 450     | 8           | reference:postflop        |
| 311 | e6b9dc5d | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.82/0.16              | 0.27    | 0       | 8           | reference:intent_engine   |
| 312 | e6b9dc5d | cash/flh/turn/3p           | -/-                             | yes         | reproduced |                   | 10.36/1.08             | 1.20    | 450     | 8           | reference:postflop        |
| 313 | e6b9dc5d | cash/flh/turn/3p           | -/-                             | yes         | reproduced |                   | 4.09/1.19              | 1.31    | 270     | 8           | reference:postflop        |
| 314 | e6b9dc5d | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                   | 0.60/0.16              | 0.27    | 0       | 8           | reference:intent_engine   |
| 315 | e6b9dc5d | cash/flh/flop/3p           | -/-                             | yes         | reproduced |                   | 26.10/1.74             | 1.84    | 450     | 8           | reference:postflop        |
| 316 | e6b9dc5d | cash/pineapple/river/6p    | -/-                             | yes         | reproduced |                   | 5.35/1.78              | 1.95    | 157     | 8           | reference:postflop        |
| 317 | e6b9dc5d | cash/pineapple/river/6p    | -/-                             | yes         | reproduced |                   | 12.99/4.02             | 4.39    | 450     | 8           | reference:postflop        |
| 318 | e6b9dc5d | cash/pineapple/river/6p    | -/-                             | yes         | reproduced |                   | 14.75/3.91             | 4.05    | 450     | 8           | reference:postflop        |
| 319 | e6b9dc5d | cash/flh/flop/3p           | -/-                             | yes         | reproduced |                   | 7.21/1.49              | 1.59    | 450     | 8           | reference:postflop        |
| 320 | e6b9dc5d | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.73/0.17              | 0.31    | 0       | 8           | reference:intent_engine   |
| 321 | e6b9dc5d | cash/pineapple/turn/6p     | -/-                             | yes         | reproduced |                   | 7.55/4.02              | 4.18    | 450     | 8           | reference:postflop        |
| 322 | e6b9dc5d | cash/pineapple/flop/6p     | -/-                             | yes         | reproduced |                   | 8.47/4.06              | 4.47    | 450     | 8           | reference:postflop        |
| 323 | e6b9dc5d | cash/pineapple/flop/6p     | -/-                             | yes         | reproduced |                   | 6.04/2.48              | 2.65    | 270     | 8           | reference:postflop        |
| 324 | e6b9dc5d | mtt/plo6/turn/2p           | -/-                             | yes         | reproduced |                   | 134.85/4.06            | 4.25    | 72      | 8           | reference:postflop        |
| 325 | e6b9dc5d | mtt/plo6/turn/2p           | -/-                             | yes         | reproduced |                   | 42.09/5.70             | 5.89    | 120     | 8           | reference:postflop        |
| 326 | e6b9dc5d | mtt/plo6/flop/3p           | -/-                             | yes         | reproduced |                   | 10.09/3.70             | 4.08    | 72      | 8           | reference:postflop        |
| 327 | e6b9dc5d | cash/flh/turn/3p           | -/-                             | yes         | reproduced |                   | 7.62/1.76              | 1.88    | 450     | 8           | reference:postflop        |
| 328 | e6b9dc5d | cash/pineapple/turn/6p     | -/-                             | yes         | reproduced |                   | 6.64/1.76              | 1.90    | 157     | 8           | reference:postflop        |
| 329 | e6b9dc5d | cash/pineapple/turn/6p     | -/-                             | yes         | reproduced |                   | 10.69/2.68             | 2.83    | 270     | 8           | reference:postflop        |
| 330 | e6b9dc5d | cash/flh/flop/3p           | -/-                             | yes         | reproduced |                   | 8.51/1.42              | 1.53    | 450     | 8           | reference:postflop        |
| 331 | e6b9dc5d | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.86/0.15              | 0.26    | 0       | 8           | reference:intent_engine   |
| 332 | e6b9dc5d | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 0.79/0.11              | 0.22    | 0       | 8           | reference:intent_engine   |
| 333 | e6b9dc5d | cash/plo8/turn/2p          | -/-                             | yes         | reproduced |                   | 41.90/4.91             | 5.04    | 132     | 8           | reference:postflop        |
| 334 | e6b9dc5d | cash/flh/river/3p          | -/-                             | yes         | reproduced |                   | 3.70/0.40              | 0.77    | 157     | 8           | reference:postflop        |
| 335 | e6b9dc5d | cash/flh/river/3p          | -/-                             | yes         | reproduced |                   | 5.10/1.13              | 1.25    | 270     | 8           | reference:postflop        |
| 336 | e6b9dc5d | cash/plo8/turn/2p          | -/-                             | yes         | reproduced |                   | 14.92/3.45             | 3.57    | 132     | 8           | reference:postflop        |
| 337 | e6b9dc5d | cash/flh/flop/3p           | -/-                             | yes         | reproduced |                   | 8.59/1.44              | 1.63    | 450     | 8           | reference:postflop        |
| 338 | e6b9dc5d | cash/plo8/flop/2p          | -/-                             | yes         | reproduced |                   | 16.75/3.54             | 3.68    | 132     | 8           | reference:postflop        |
| 339 | e6b9dc5d | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                   | 8.72/0.68              | 0.80    | 0       | 8           | reference:intent_engine   |
| 340 | e6b9dc5d | cash/plo8/flop/2p          | -/-                             | yes         | reproduced |                   | 11.98/3.64             | 3.78    | 120     | 8           | reference:postflop        |
| 341 | e6b9dc5d | cash/plo8/flop/2p          | -/-                             | yes         | reproduced |                   | 10.35/3.45             | 3.59    | 180     | 8           | reference:postflop        |
| 342 | e6b9dc5d | cash/pineapple/turn/6p     | -/-                             | yes         | reproduced |                   | 8.38/4.26              | 4.61    | 450     | 8           | reference:postflop        |
| 343 | e6b9dc5d | cash/plo8/river/2p         | -/-                             | yes         | reproduced |                   | 5.49/1.95              | 2.19    | 77      | 8           | reference:postflop        |
| 344 | e6b9dc5d | cash/plo8/river/2p         | -/-                             | yes         | reproduced |                   | 22.91/5.69             | 5.87    | 220     | 8           | reference:postflop        |
| 345 | e6b9dc5d | cash/plo8/turn/2p          | -/-                             | yes         | reproduced |                   | 26.23/2.44             | 2.67    | 60      | 8           | reference:postflop        |
| 346 | e6b9dc5d | cash/plo8/turn/2p          | -/-                             | yes         | reproduced |                   | 11.93/3.10             | 3.29    | 132     | 8           | reference:postflop        |
| 347 | e6b9dc5d | cash/flh/flop/3p           | -/-                             | yes         | reproduced |                   | 3.76/1.28              | 1.42    | 270     | 8           | reference:postflop        |
| 348 | e6b9dc5d | cash/plo8/flop/2p          | -/-                             | yes         | reproduced |                   | 37.52/3.16             | 3.60    | 132     | 8           | reference:postflop        |
| 349 | e6b9dc5d | mtt/plo6/flop/3p           | -/-                             | yes         | reproduced |                   | 27.51/5.83             | 6.06    | 120     | 8           | reference:postflop        |
| 350 | e6b9dc5d | cash/plo8/river/2p         | -/-                             | yes         | reproduced |                   | 13.74/2.44             | 2.60    | 132     | 8           | reference:postflop        |
| 351 | e6b9dc5d | cash/flh/turn/3p           | -/-                             | yes         | reproduced |                   | 9.41/1.95              | 2.07    | 270     | 8           | reference:postflop        |
| 352 | e6b9dc5d | cash/flh/turn/3p           | -/-                             | yes         | reproduced |                   | 5.36/1.86              | 1.98    | 450     | 8           | reference:postflop        |
| 353 | e6b9dc5d | mtt/plo6/river/2p          | -/-                             | yes         | reproduced |                   | 20.20/5.84             | 6.03    | 120     | 8           | reference:postflop        |
| 354 | e6b9dc5d | mtt/plo6/river/2p          | -/-                             | yes         | reproduced |                   | 15.99/3.22             | 3.45    | 72      | 8           | reference:postflop        |
| 355 | e6b9dc5d | cash/pineapple/turn/6p     | -/-                             | yes         | reproduced |                   | 9.12/4.19              | 4.37    | 450     | 8           | reference:postflop        |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
