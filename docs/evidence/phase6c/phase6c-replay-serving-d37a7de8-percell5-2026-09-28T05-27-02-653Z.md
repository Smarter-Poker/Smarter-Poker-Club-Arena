# Phase 6C exact-input replay evidence (2026-09-28T05:27:02.653Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`. Evidence shape: aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position.

## Batch

- Command: `node scripts/phase6c-replay.mjs /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-d37a/journal-copy-d37a7de8-percell5.ndjson --engine-sha d37a7de834ce4cd3f95701d2e098814e01d4fe7c --limit 376 --since 2026-09-28T05:00:00Z --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-chart-store-2c8a2d9f448e.json --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-solver-store-postflop-dff78313b437.json --label serving-d37a7de8-percell5 --out ../docs/evidence/phase6c --full-verdicts /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-d37a/full-verdicts-percell.json --note 'predeclared coverage batch: from the same 20318-record d37a7de8 window copy (2026-09-28T05:00:00Z to 05:16:00Z), the newest 5 DECIDE_FAST records of every (format, variant, street) cell observed in the window, 76 cells and 376 records; DECIDE_DEEP records are not selected (they are counted and refused by name in the newest-2000 batch)' --note 'every record journals solverStoreIdentity equal to the loaded snapshots (charts 2c8a2d9f, postflop dff78313); no pin file is passed'`
- Batch rule: newest 376 journaled decision records at or after 2026-09-28T05:00:00Z, in journal order
- Source: ndjson copy (376 records)
- Decisions from 2026-09-28T05:04:15.439Z to 2026-09-28T05:15:09.690Z
- Serving engine SHA (declared): `d37a7de834ce4cd3f95701d2e098814e01d4fe7c`
- Replay engine SHA (code that ran): `c28ea6008c8fd30b022e03284e936bb542e2a730` (not the serving engine)
- Releases recorded on the replayed rows: `d37a7de834ce4cd3f95701d2e098814e01d4fe7c`
- Rows for the serving engine in this batch: 376
- Chart store at replay: 240 entries, digest `2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf`, revision 2026-07-19T15:11:48.555537+00:00
- Postflop store at replay: 7747 entries, digest `dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d`, revision 2026-09-03T18:18:13.594197+00:00
- Snapshot chart_store: fetched 2026-09-27T22:18:16.947Z to 2026-09-27T22:18:17.572Z from memory_charts_gold through the production loader, identity recomputed by the store module on load
- Snapshot solver_store:postflop: fetched 2026-09-27T22:18:18.975Z to 2026-09-27T22:18:37.081Z from gto_postflop_compact through the production loader, identity recomputed by the store module on load
- Release `d37a7de834ce` committed 2026-09-28T04:39:17.000Z (no process running it started earlier)
- Decision-code files that differ, serving engine to replay code: none
- Decision-code files that differ, recorded release `d37a7de834ce` to replay code: none
- Note: predeclared coverage batch: from the same 20318-record d37a7de8 window copy (2026-09-28T05:00:00Z to 05:16:00Z), the newest 5 DECIDE_FAST records of every (format, variant, street) cell observed in the window, 76 cells and 376 records; DECIDE_DEEP records are not selected (they are counted and refused by name in the newest-2000 batch)
- Note: every record journals solverStoreIdentity equal to the loaded snapshots (charts 2c8a2d9f, postflop dff78313); no pin file is passed

## Result

- Total: 376
- reproduced: 376 of 376
- diverged: 0 of 376
- refused: 0 of 376
- Independent qualification: agreed 376, disagreed 0, refused (reference unavailable) 0
- Receipt digest equal to the original: 376 of 376 replayed
- Authority owner identical between original and replay: 376 of 376 replayed

### Status and reason

| status:reason    | count |
| ---------------- | ----- |
| reproduced:clean | 376   |

### Solver-store references

| reference             | status and detail                     | decisions |
| --------------------- | ------------------------------------- | --------- |
| chart_store           | available: identity 240@2c8a2d9f448e  | 4         |
| solver_store:postflop | available: identity 7747@dff78313b437 | 57        |

### Latency and work

- Replay computeMs median 4.68, p95 33.36; original computeMs median 14.00, p95 74.98; replay wall (runtime round trip) median 4.96, p95 33.88
- Equity samples per replay: median 157, max 450; equity calls median 1; policy-graph node visits median 8

### Authority (module that produced the accepted action, original decisions)

| module                    | count |
| ------------------------- | ----- |
| reference:postflop        | 271   |
| reference:intent_engine   | 86    |
| reference_legality        | 10    |
| reference:chart_bb_defend | 4     |
| reference:variant_price   | 4     |
| tournament_utility        | 1     |

## Coverage Matrix (format x variant x street x outcome)

180 declared cells (5 formats x 9 registered variants x 4 streets): 76 observed, of which 76 fully replayed, 0 partly unreplayed and 0 unreplayed; 104 unobserved; 0 observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.

### Observed cells

| format | variant    | street  | observed | reproduced | diverged | refused | coverage | outcomes (route or reason)                                       | table sizes   |
| ------ | ---------- | ------- | -------- | ---------- | -------- | ------- | -------- | ---------------------------------------------------------------- | ------------- |
| cash   | nlh        | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 1; 5 3; 6 1 |
| cash   | nlh        | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 1; 5 1; 6 3 |
| cash   | nlh        | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 1; 5 1; 6 3 |
| cash   | nlh        | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 1; 6 2; 9 2 |
| cash   | plo4       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 3; 6 2      |
| cash   | plo4       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 3; 6 2      |
| cash   | plo4       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 2; 4 1; 6 2 |
| cash   | plo4       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 2; 6 3      |
| cash   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 3; 5 2      |
| cash   | plo5       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| cash   | plo5       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 3; 5 2      |
| cash   | plo5       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| cash   | plo6       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 3; 5 2      |
| cash   | plo6       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 3 3; 5 2      |
| cash   | plo6       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 3; 5 2      |
| cash   | plo6       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 1; 5 2 |
| cash   | plo8       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 1; 3 1; 5 3 |
| cash   | plo8       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 1; 4 1; 5 3 |
| cash   | plo8       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 3; 4 2      |
| cash   | plo8       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 3; 4 2      |
| cash   | short_deck | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 3; 3 1; 6 1 |
| cash   | short_deck | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 3; 6 1 |
| cash   | short_deck | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 4 1; 6 2 |
| cash   | short_deck | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 2; 6 2 |
| cash   | pineapple  | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 1; 4 4      |
| cash   | pineapple  | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 2; 4 2 |
| cash   | pineapple  | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 1; 4 2 |
| cash   | pineapple  | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 3; 4 2      |
| cash   | flh        | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 2; 3 3      |
| cash   | flh        | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 3; 3 2      |
| cash   | flh        | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 3; 3 2      |
| cash   | flh        | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| cash   | flo8       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 2; 4 3      |
| cash   | flo8       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| cash   | flo8       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 4; 4 1      |
| cash   | flo8       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| mtt    | nlh        | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 9 5           |
| mtt    | nlh        | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 9 5           |
| mtt    | nlh        | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 7 2; 9 3      |
| mtt    | nlh        | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 9 5           |
| mtt    | plo4       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 1; 3 4      |
| mtt    | plo4       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference_legality 3; reproduced:reference:postflop 2 | 2 1; 3 4      |
| mtt    | plo4       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| mtt    | plo4       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 3; 3 2      |
| mtt    | plo5       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 3; 3 2      |
| mtt    | plo5       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| mtt    | plo5       | turn    | 2        | 2          | 0        | 0       | replayed | reproduced:reference:postflop 2                                  | 3 2           |
| mtt    | plo5       | river   | 4        | 4          | 0        | 0       | replayed | reproduced:reference:postflop 4                                  | 2 4           |
| mtt    | plo6       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 1; 6 4      |
| mtt    | plo6       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 1; 5 1; 6 3 |
| mtt    | plo6       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 3; 6 2      |
| mtt    | plo6       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 4 3; 5 1; 6 1 |
| spin   | nlh        | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 4; reproduced:chart_bb_defend 1         | 3 5           |
| spin   | nlh        | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 5           |
| spin   | nlh        | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 3 5           |
| spin   | nlh        | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 3 5           |
| spin   | plo4       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 3 5           |
| spin   | plo4       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| spin   | plo4       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 3 5           |
| spin   | plo4       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 3; 3 2      |
| spin   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 5                                       | 2 2; 3 3      |
| spin   | plo5       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| spin   | plo5       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| spin   | plo5       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 2; 3 3      |
| spin   | plo6       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:variant_price 3; reproduced:intent_engine 2           | 3 5           |
| spin   | plo6       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 3; reproduced:reference_legality 2 | 3 5           |
| spin   | plo6       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 4; reproduced:reference_legality 1 | 2 1; 3 4      |
| spin   | plo6       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 1; 3 4      |
| hu_sng | nlh        | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:chart_bb_defend 3; reproduced:intent_engine 2         | 2 5           |
| hu_sng | nlh        | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | nlh        | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 4; reproduced:tournament_utility 1 | 2 5           |
| hu_sng | nlh        | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | plo4       | preflop | 5        | 5          | 0        | 0       | replayed | reproduced:intent_engine 4; reproduced:variant_price 1           | 2 5           |
| hu_sng | plo4       | flop    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | plo4       | turn    | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |
| hu_sng | plo4       | river   | 5        | 5          | 0        | 0       | replayed | reproduced:reference:postflop 5                                  | 2 5           |

### Unreplayed decisions by cell and named reason

| format | variant | street | reason | decisions |
| ------ | ------- | ------ | ------ | --------- |

### Unobserved cells

| format | variant    | unobserved streets |
| ------ | ---------- | ------------------ |
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

| #   | release  | format/variant/street/size | route orig/replay               | action same | status     | reason | compute orig/replay ms | wall ms | samples | node visits | authority                 |
| --- | -------- | -------------------------- | ------------------------------- | ----------- | ---------- | ------ | ---------------------- | ------- | ------- | ----------- | ------------------------- |
| 1   | d37a7de8 | mtt/nlh/river/9p           | -/-                             | yes         | reproduced |        | 72.85/65.14            | 78.16   | 450     | 8           | reference:postflop        |
| 2   | d37a7de8 | mtt/nlh/river/9p           | -/-                             | yes         | reproduced |        | 79.47/44.70            | 45.37   | 450     | 8           | reference:postflop        |
| 3   | d37a7de8 | mtt/nlh/river/9p           | -/-                             | yes         | reproduced |        | 70.10/31.48            | 32.16   | 450     | 8           | reference:postflop        |
| 4   | d37a7de8 | mtt/nlh/river/9p           | -/-                             | yes         | reproduced |        | 76.09/40.19            | 40.75   | 450     | 8           | reference:postflop        |
| 5   | d37a7de8 | mtt/nlh/river/9p           | -/-                             | yes         | reproduced |        | 61.92/33.36            | 33.88   | 450     | 8           | reference:postflop        |
| 6   | d37a7de8 | mtt/nlh/turn/9p            | -/-                             | yes         | reproduced |        | 87.55/45.28            | 45.97   | 450     | 8           | reference:postflop        |
| 7   | d37a7de8 | mtt/nlh/turn/9p            | -/-                             | yes         | reproduced |        | 95.79/43.30            | 43.77   | 450     | 8           | reference:postflop        |
| 8   | d37a7de8 | mtt/nlh/turn/7p            | -/-                             | yes         | reproduced |        | 31.35/17.47            | 17.82   | 450     | 8           | reference:postflop        |
| 9   | d37a7de8 | mtt/nlh/turn/7p            | -/-                             | yes         | reproduced |        | 56.47/23.98            | 25.30   | 450     | 8           | reference:postflop        |
| 10  | d37a7de8 | mtt/nlh/turn/9p            | -/-                             | yes         | reproduced |        | 84.41/35.23            | 35.71   | 450     | 8           | reference:postflop        |
| 11  | d37a7de8 | mtt/nlh/flop/9p            | -/-                             | yes         | reproduced |        | 66.71/37.25            | 37.61   | 450     | 8           | reference:postflop        |
| 12  | d37a7de8 | mtt/nlh/flop/9p            | -/-                             | yes         | reproduced |        | 95.75/49.12            | 49.48   | 450     | 8           | reference:postflop        |
| 13  | d37a7de8 | mtt/nlh/flop/9p            | -/-                             | yes         | reproduced |        | 77.83/42.06            | 42.48   | 450     | 8           | reference:postflop        |
| 14  | d37a7de8 | mtt/nlh/flop/9p            | -/-                             | yes         | reproduced |        | 85.74/37.67            | 38.00   | 450     | 8           | reference:postflop        |
| 15  | d37a7de8 | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |        | 14.50/8.00             | 8.26    | 450     | 8           | reference_legality        |
| 16  | d37a7de8 | cash/plo5/river/3p         | -/-                             | yes         | reproduced |        | 10.99/46.68            | 47.44   | 170     | 8           | reference:postflop        |
| 17  | d37a7de8 | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |        | 30.21/33.68            | 33.96   | 220     | 8           | reference:postflop        |
| 18  | d37a7de8 | mtt/nlh/flop/9p            | -/-                             | yes         | reproduced |        | 93.75/46.71            | 47.05   | 450     | 8           | reference:postflop        |
| 19  | d37a7de8 | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |        | 76.38/35.25            | 35.60   | 320     | 8           | reference:intent_engine   |
| 20  | d37a7de8 | cash/plo5/river/3p         | -/-                             | yes         | reproduced |        | 12.99/6.73             | 6.92    | 170     | 8           | reference:postflop        |
| 21  | d37a7de8 | cash/plo4/river/4p         | -/-                             | yes         | reproduced |        | 7.86/4.78              | 4.96    | 220     | 8           | reference:postflop        |
| 22  | d37a7de8 | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |        | 10.27/7.04             | 7.75    | 450     | 8           | reference:postflop        |
| 23  | d37a7de8 | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |        | 19.23/12.33            | 12.97   | 220     | 8           | reference:postflop        |
| 24  | d37a7de8 | cash/plo6/river/5p         | -/-                             | yes         | reproduced |        | 16.05/31.02            | 31.30   | 120     | 8           | reference:postflop        |
| 25  | d37a7de8 | cash/plo6/river/5p         | -/-                             | yes         | reproduced |        | 26.99/6.74             | 6.93    | 120     | 8           | reference:postflop        |
| 26  | d37a7de8 | spin/nlh/river/3p          | -/-                             | yes         | reproduced |        | 22.85/20.03            | 20.30   | 450     | 8           | reference:postflop        |
| 27  | d37a7de8 | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |        | 24.25/13.56            | 13.83   | 220     | 8           | reference:postflop        |
| 28  | d37a7de8 | cash/plo4/river/6p         | -/-                             | yes         | reproduced |        | 10.01/5.61             | 5.80    | 220     | 8           | reference:postflop        |
| 29  | d37a7de8 | cash/plo6/turn/5p          | -/-                             | yes         | reproduced |        | 17.19/10.98            | 11.23   | 120     | 8           | reference:postflop        |
| 30  | d37a7de8 | cash/plo4/river/6p         | -/-                             | yes         | reproduced |        | 9.31/4.26              | 4.89    | 220     | 8           | reference:postflop        |
| 31  | d37a7de8 | spin/nlh/river/3p          | -/-                             | yes         | reproduced |        | 17.10/18.02            | 18.28   | 450     | 8           | reference:postflop        |
| 32  | d37a7de8 | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |        | 25.93/13.33            | 13.60   | 220     | 8           | reference:postflop        |
| 33  | d37a7de8 | cash/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 10.50/3.21             | 4.78    | 60      | 8           | reference:postflop        |
| 34  | d37a7de8 | cash/nlh/river/6p          | -/-                             | yes         | reproduced |        | 1.75/0.65              | 0.85    | 90      | 8           | reference:postflop        |
| 35  | d37a7de8 | cash/nlh/river/6p          | -/-                             | yes         | reproduced |        | 1.35/0.33              | 0.49    | 90      | 8           | reference:postflop        |
| 36  | d37a7de8 | cash/nlh/turn/6p           | -/-                             | yes         | reproduced |        | 21.23/8.81             | 8.98    | 450     | 8           | reference:postflop        |
| 37  | d37a7de8 | spin/plo4/river/3p         | -/-                             | yes         | reproduced |        | 14.07/5.48             | 5.71    | 132     | 8           | reference:postflop        |
| 38  | d37a7de8 | cash/plo4/river/6p         | -/-                             | yes         | reproduced |        | 8.09/3.03              | 3.17    | 220     | 8           | reference:postflop        |
| 39  | d37a7de8 | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |        | 71.08/34.39            | 34.67   | 192     | 8           | reference:intent_engine   |
| 40  | d37a7de8 | cash/pineapple/river/4p    | -/-                             | yes         | reproduced |        | 5.44/4.58              | 4.96    | 450     | 8           | reference:postflop        |
| 41  | d37a7de8 | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |        | 76.49/38.56            | 38.94   | 320     | 8           | reference:intent_engine   |
| 42  | d37a7de8 | cash/plo6/river/2p         | -/-                             | yes         | reproduced |        | 9.37/4.37              | 5.07    | 72      | 8           | reference:postflop        |
| 43  | d37a7de8 | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |        | 43.72/9.51             | 9.74    | 132     | 8           | reference:postflop        |
| 44  | d37a7de8 | cash/plo4/river/4p         | -/-                             | yes         | reproduced |        | 16.94/3.02             | 3.21    | 220     | 8           | reference:postflop        |
| 45  | d37a7de8 | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |        | 161.37/15.80           | 16.08   | 450     | 8           | reference:postflop        |
| 46  | d37a7de8 | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |        | 110.19/35.55           | 35.86   | 320     | 8           | reference:intent_engine   |
| 47  | d37a7de8 | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |        | 103.66/50.02           | 50.30   | 320     | 8           | reference:intent_engine   |
| 48  | d37a7de8 | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |        | 30.74/9.07             | 9.64    | 450     | 8           | reference:postflop        |
| 49  | d37a7de8 | cash/plo4/turn/6p          | -/-                             | yes         | reproduced |        | 12.73/4.66             | 4.84    | 220     | 8           | reference:postflop        |
| 50  | d37a7de8 | cash/nlh/river/9p          | -/-                             | yes         | reproduced |        | 7.08/1.52              | 1.77    | 450     | 8           | reference:postflop        |
| 51  | d37a7de8 | cash/plo6/river/2p         | -/-                             | yes         | reproduced |        | 13.14/6.02             | 6.57    | 120     | 8           | reference:postflop        |
| 52  | d37a7de8 | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |        | 33.07/12.56            | 12.80   | 450     | 8           | reference:postflop        |
| 53  | d37a7de8 | spin/nlh/turn/3p           | -/-                             | yes         | reproduced |        | 25.31/16.31            | 16.58   | 450     | 8           | reference:postflop        |
| 54  | d37a7de8 | cash/pineapple/river/2p    | -/-                             | yes         | reproduced |        | 3.31/2.49              | 2.66    | 450     | 8           | reference:postflop        |
| 55  | d37a7de8 | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 15.38/10.90            | 11.13   | 120     | 8           | reference_legality        |
| 56  | d37a7de8 | cash/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 11.82/6.52             | 6.70    | 170     | 8           | reference:postflop        |
| 57  | d37a7de8 | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |        | 3.81/1.14              | 1.88    | 450     | 8           | reference:postflop        |
| 58  | d37a7de8 | cash/nlh/turn/6p           | -/-                             | yes         | reproduced |        | 2.96/2.12              | 2.31    | 450     | 8           | reference:postflop        |
| 59  | d37a7de8 | cash/pineapple/river/2p    | -/-                             | yes         | reproduced |        | 3.56/2.01              | 2.16    | 450     | 8           | reference:postflop        |
| 60  | d37a7de8 | cash/pineapple/river/4p    | -/-                             | yes         | reproduced |        | 4.28/3.40              | 3.55    | 450     | 8           | reference:postflop        |
| 61  | d37a7de8 | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |        | 15.89/8.69             | 9.35    | 450     | 8           | reference:postflop        |
| 62  | d37a7de8 | cash/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 17.25/11.64            | 11.81   | 120     | 8           | reference:postflop        |
| 63  | d37a7de8 | cash/plo4/turn/6p          | -/-                             | yes         | reproduced |        | 9.05/5.53              | 5.69    | 220     | 8           | reference:postflop        |
| 64  | d37a7de8 | cash/plo5/turn/5p          | -/-                             | yes         | reproduced |        | 16.12/7.61             | 7.76    | 170     | 8           | reference:postflop        |
| 65  | d37a7de8 | cash/short_deck/river/2p   | -/-                             | yes         | reproduced |        | 3.46/1.75              | 1.90    | 270     | 8           | reference:postflop        |
| 66  | d37a7de8 | cash/plo6/turn/5p          | -/-                             | yes         | reproduced |        | 13.36/6.38             | 6.54    | 72      | 8           | reference:postflop        |
| 67  | d37a7de8 | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |        | 15.86/9.20             | 9.77    | 132     | 8           | reference:postflop        |
| 68  | d37a7de8 | cash/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 16.45/9.48             | 9.67    | 120     | 8           | reference:postflop        |
| 69  | d37a7de8 | cash/plo5/river/2p         | -/-                             | yes         | reproduced |        | 20.84/9.02             | 9.24    | 300     | 8           | reference:postflop        |
| 70  | d37a7de8 | spin/plo4/river/3p         | -/-                             | yes         | reproduced |        | 15.80/6.50             | 6.76    | 132     | 8           | reference:postflop        |
| 71  | d37a7de8 | cash/short_deck/river/6p   | -/-                             | yes         | reproduced |        | 5.62/3.00              | 3.16    | 450     | 8           | reference:postflop        |
| 72  | d37a7de8 | cash/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 16.50/10.25            | 10.44   | 120     | 8           | reference:postflop        |
| 73  | d37a7de8 | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |        | 15.69/9.22             | 9.44    | 132     | 8           | reference:postflop        |
| 74  | d37a7de8 | cash/nlh/turn/5p           | -/-                             | yes         | reproduced |        | 4.92/1.98              | 2.15    | 450     | 8           | reference:postflop        |
| 75  | d37a7de8 | cash/pineapple/turn/4p     | -/-                             | yes         | reproduced |        | 5.76/4.20              | 4.86    | 450     | 8           | reference:postflop        |
| 76  | d37a7de8 | spin/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 17.99/10.66            | 10.90   | 220     | 8           | reference:postflop        |
| 77  | d37a7de8 | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |        | 20.45/11.23            | 11.46   | 220     | 8           | reference:postflop        |
| 78  | d37a7de8 | cash/plo4/flop/6p          | -/-                             | yes         | reproduced |        | 14.20/4.02             | 4.21    | 220     | 8           | reference:postflop        |
| 79  | d37a7de8 | cash/nlh/turn/4p           | -/-                             | yes         | reproduced |        | 12.65/5.82             | 6.02    | 450     | 8           | reference:postflop        |
| 80  | d37a7de8 | spin/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 24.49/6.14             | 6.79    | 220     | 8           | reference_legality        |
| 81  | d37a7de8 | cash/pineapple/turn/4p     | -/-                             | yes         | reproduced |        | 6.74/4.18              | 4.65    | 450     | 8           | reference:postflop        |
| 82  | d37a7de8 | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |        | 14.36/4.06             | 4.20    | 102     | 8           | reference:postflop        |
| 83  | d37a7de8 | cash/plo8/river/4p         | -/-                             | yes         | reproduced |        | 12.06/27.29            | 27.51   | 180     | 8           | reference:postflop        |
| 84  | d37a7de8 | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |        | 18.62/12.16            | 12.43   | 270     | 8           | reference:postflop        |
| 85  | d37a7de8 | hu_sng/plo4/river/2p       | -/-                             | yes         | reproduced |        | 14.31/5.91             | 6.14    | 220     | 8           | reference:postflop        |
| 86  | d37a7de8 | cash/pineapple/river/2p    | -/-                             | yes         | reproduced |        | 4.86/1.88              | 2.43    | 450     | 8           | reference:postflop        |
| 87  | d37a7de8 | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 14.80/9.26             | 9.58    | 120     | 8           | reference_legality        |
| 88  | d37a7de8 | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |        | 6.41/4.12              | 4.35    | 450     | 8           | reference:postflop        |
| 89  | d37a7de8 | cash/pineapple/turn/2p     | -/-                             | yes         | reproduced |        | 3.85/1.92              | 2.10    | 270     | 8           | reference:postflop        |
| 90  | d37a7de8 | cash/plo5/river/3p         | -/-                             | yes         | reproduced |        | 8.23/3.79              | 4.13    | 102     | 8           | reference:postflop        |
| 91  | d37a7de8 | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |        | 20.98/10.37            | 11.08   | 450     | 8           | tournament_utility        |
| 92  | d37a7de8 | cash/plo5/turn/5p          | -/-                             | yes         | reproduced |        | 14.94/6.33             | 6.49    | 170     | 8           | reference:postflop        |
| 93  | d37a7de8 | cash/pineapple/flop/4p     | -/-                             | yes         | reproduced |        | 13.72/3.66             | 3.82    | 450     | 8           | reference:postflop        |
| 94  | d37a7de8 | cash/pineapple/turn/2p     | -/-                             | yes         | reproduced |        | 3.69/1.04              | 1.17    | 270     | 8           | reference:postflop        |
| 95  | d37a7de8 | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |        | 8.04/3.46              | 3.62    | 270     | 8           | reference:postflop        |
| 96  | d37a7de8 | cash/short_deck/river/6p   | -/-                             | yes         | reproduced |        | 4.57/1.92              | 2.74    | 450     | 8           | reference:postflop        |
| 97  | d37a7de8 | cash/plo5/river/2p         | -/-                             | yes         | reproduced |        | 18.50/6.03             | 6.20    | 300     | 8           | reference:postflop        |
| 98  | d37a7de8 | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |        | 16.54/10.73            | 10.93   | 450     | 8           | reference:postflop        |
| 99  | d37a7de8 | cash/nlh/turn/6p           | -/-                             | yes         | reproduced |        | 3.04/1.08              | 1.23    | 270     | 8           | reference:postflop        |
| 100 | d37a7de8 | cash/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 10.67/2.60             | 2.73    | 132     | 8           | reference:postflop        |
| 101 | d37a7de8 | cash/pineapple/flop/2p     | -/-                             | yes         | reproduced |        | 11.65/1.55             | 1.67    | 270     | 8           | reference:postflop        |
| 102 | d37a7de8 | cash/plo8/flop/5p          | -/-                             | yes         | reproduced |        | 15.03/7.05             | 7.55    | 220     | 8           | reference:postflop        |
| 103 | d37a7de8 | cash/plo6/flop/5p          | -/-                             | yes         | reproduced |        | 8.37/5.51              | 5.72    | 72      | 8           | reference:postflop        |
| 104 | d37a7de8 | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |        | 29.31/11.15            | 11.37   | 450     | 8           | reference:postflop        |
| 105 | d37a7de8 | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |        | 3.75/1.33              | 2.08    | 270     | 8           | reference:postflop        |
| 106 | d37a7de8 | spin/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 17.45/6.81             | 7.06    | 132     | 8           | reference:postflop        |
| 107 | d37a7de8 | cash/plo6/river/3p         | -/-                             | yes         | reproduced |        | 10.57/4.76             | 4.92    | 72      | 8           | reference:postflop        |
| 108 | d37a7de8 | hu_sng/plo4/turn/2p        | -/-                             | yes         | reproduced |        | 20.48/8.15             | 8.34    | 132     | 8           | reference:postflop        |
| 109 | d37a7de8 | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |        | 13.29/12.90            | 13.11   | 270     | 8           | reference:postflop        |
| 110 | d37a7de8 | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |        | 19.09/11.65            | 11.87   | 270     | 8           | reference:postflop        |
| 111 | d37a7de8 | hu_sng/nlh/turn/2p         | -/-                             | yes         | reproduced |        | 22.64/11.59            | 11.81   | 450     | 8           | reference:postflop        |
| 112 | d37a7de8 | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |        | 81.65/19.52            | 19.75   | 270     | 8           | reference:postflop        |
| 113 | d37a7de8 | spin/nlh/river/3p          | -/-                             | yes         | reproduced |        | 35.15/13.13            | 13.78   | 450     | 8           | reference:postflop        |
| 114 | d37a7de8 | cash/plo4/turn/4p          | -/-                             | yes         | reproduced |        | 13.57/3.55             | 3.71    | 220     | 8           | reference:postflop        |
| 115 | d37a7de8 | spin/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 61.40/6.48             | 6.69    | 220     | 8           | reference:postflop        |
| 116 | d37a7de8 | cash/plo8/river/4p         | -/-                             | yes         | reproduced |        | 9.89/4.30              | 4.49    | 180     | 8           | reference:postflop        |
| 117 | d37a7de8 | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 11.46/6.19             | 6.74    | 72      | 8           | reference:postflop        |
| 118 | d37a7de8 | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |        | 20.94/9.87             | 10.13   | 450     | 8           | reference:postflop        |
| 119 | d37a7de8 | cash/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 7.90/2.75              | 2.91    | 132     | 8           | reference:postflop        |
| 120 | d37a7de8 | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |        | 21.43/11.06            | 11.26   | 450     | 8           | reference:postflop        |
| 121 | d37a7de8 | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |        | 19.77/12.69            | 12.91   | 270     | 8           | reference:postflop        |
| 122 | d37a7de8 | cash/short_deck/river/3p   | -/-                             | yes         | reproduced |        | 3.18/0.68              | 0.82    | 270     | 8           | reference:postflop        |
| 123 | d37a7de8 | cash/nlh/river/3p          | -/-                             | yes         | reproduced |        | 2.14/0.76              | 1.30    | 450     | 8           | reference:postflop        |
| 124 | d37a7de8 | cash/nlh/flop/4p           | -/-                             | yes         | reproduced |        | 10.47/2.89             | 3.09    | 270     | 8           | reference:postflop        |
| 125 | d37a7de8 | spin/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 16.28/6.45             | 6.69    | 132     | 8           | reference:postflop        |
| 126 | d37a7de8 | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 25.64/15.91            | 16.16   | 120     | 8           | reference:postflop        |
| 127 | d37a7de8 | spin/plo4/turn/3p          | -/-                             | yes         | reproduced |        | 26.01/8.81             | 9.06    | 220     | 8           | reference:postflop        |
| 128 | d37a7de8 | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |        | 26.96/12.69            | 12.94   | 270     | 8           | reference:postflop        |
| 129 | d37a7de8 | cash/nlh/river/9p          | -/-                             | yes         | reproduced |        | 4.31/1.00              | 1.82    | 270     | 8           | reference:postflop        |
| 130 | d37a7de8 | cash/nlh/flop/6p           | -/-                             | yes         | reproduced |        | 20.78/7.62             | 7.80    | 270     | 8           | reference:postflop        |
| 131 | d37a7de8 | mtt/plo6/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |        | 23.98/12.26            | 12.52   | 160     | 8           | reference:intent_engine   |
| 132 | d37a7de8 | spin/nlh/river/3p          | -/-                             | yes         | reproduced |        | 27.85/11.17            | 11.41   | 450     | 8           | reference:postflop        |
| 133 | d37a7de8 | cash/flo8/river/3p         | -/-                             | yes         | reproduced |        | 12.45/5.62             | 5.79    | 220     | 8           | reference:postflop        |
| 134 | d37a7de8 | cash/nlh/flop/5p           | -/-                             | yes         | reproduced |        | 28.49/8.55             | 8.82    | 450     | 8           | reference:postflop        |
| 135 | d37a7de8 | spin/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 25.45/12.17            | 12.41   | 220     | 8           | reference:postflop        |
| 136 | d37a7de8 | cash/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 15.67/5.55             | 5.71    | 102     | 8           | reference:postflop        |
| 137 | d37a7de8 | hu_sng/nlh/river/2p        | -/-                             | yes         | reproduced |        | 26.96/12.78            | 13.00   | 270     | 8           | reference:postflop        |
| 138 | d37a7de8 | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |        | 37.03/14.51            | 14.76   | 270     | 8           | reference:postflop        |
| 139 | d37a7de8 | cash/plo8/river/3p         | -/-                             | yes         | reproduced |        | 10.53/3.54             | 3.70    | 132     | 8           | reference:postflop        |
| 140 | d37a7de8 | cash/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 11.22/4.30             | 4.82    | 102     | 8           | reference:postflop        |
| 141 | d37a7de8 | cash/pineapple/flop/4p     | -/-                             | yes         | reproduced |        | 5.01/2.01              | 2.18    | 270     | 8           | reference:postflop        |
| 142 | d37a7de8 | mtt/plo6/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |        | 41.37/13.75            | 13.97   | 96      | 8           | reference:intent_engine   |
| 143 | d37a7de8 | cash/short_deck/turn/2p    | -/-                             | yes         | reproduced |        | 14.92/1.01             | 1.13    | 270     | 8           | reference:postflop        |
| 144 | d37a7de8 | cash/flh/river/2p          | -/-                             | yes         | reproduced |        | 3.56/1.20              | 1.66    | 450     | 8           | reference:postflop        |
| 145 | d37a7de8 | cash/short_deck/turn/6p    | -/-                             | yes         | reproduced |        | 7.47/1.94              | 2.11    | 450     | 8           | reference:postflop        |
| 146 | d37a7de8 | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |        | 31.14/10.04            | 10.24   | 132     | 8           | reference:postflop        |
| 147 | d37a7de8 | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |        | 41.92/12.45            | 12.68   | 270     | 8           | reference:postflop        |
| 148 | d37a7de8 | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |        | 19.21/9.28             | 9.49    | 132     | 8           | reference:postflop        |
| 149 | d37a7de8 | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |        | 4.78/2.34              | 3.02    | 0       | 8           | reference:intent_engine   |
| 150 | d37a7de8 | cash/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 21.93/6.43             | 6.58    | 72      | 8           | reference_legality        |
| 151 | d37a7de8 | spin/nlh/flop/3p           | -/-                             | yes         | reproduced |        | 31.26/12.22            | 12.82   | 270     | 8           | reference:postflop        |
| 152 | d37a7de8 | cash/plo8/turn/4p          | -/-                             | yes         | reproduced |        | 18.73/5.93             | 6.10    | 180     | 8           | reference:postflop        |
| 153 | d37a7de8 | cash/flh/flop/3p           | -/-                             | yes         | reproduced |        | 2.49/1.32              | 1.46    | 270     | 8           | reference:postflop        |
| 154 | d37a7de8 | cash/plo6/flop/5p          | -/-                             | yes         | reproduced |        | 8.03/4.27              | 4.80    | 72      | 8           | reference:postflop        |
| 155 | d37a7de8 | spin/plo6/preflop/3p       | variant_price/variant_price     | yes         | reproduced |        | 24.63/10.07            | 10.32   | 192     | 8           | reference:variant_price   |
| 156 | d37a7de8 | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |        | 25.12/10.17            | 10.38   | 132     | 8           | reference:postflop        |
| 157 | d37a7de8 | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |        | 7.70/3.68              | 3.87    | 102     | 8           | reference:postflop        |
| 158 | d37a7de8 | mtt/plo5/river/2p          | -/-                             | yes         | reproduced |        | 5.65/1.83              | 2.49    | 102     | 8           | reference:postflop        |
| 159 | d37a7de8 | spin/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 15.54/6.29             | 6.54    | 72      | 8           | reference:postflop        |
| 160 | d37a7de8 | cash/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 7.40/2.47              | 2.93    | 132     | 8           | reference:postflop        |
| 161 | d37a7de8 | spin/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 36.75/7.43             | 7.63    | 132     | 8           | reference:postflop        |
| 162 | d37a7de8 | cash/plo8/flop/5p          | -/-                             | yes         | reproduced |        | 8.59/3.67              | 3.82    | 132     | 8           | reference:postflop        |
| 163 | d37a7de8 | cash/plo4/flop/6p          | -/-                             | yes         | reproduced |        | 5.76/2.26              | 2.49    | 132     | 8           | reference:postflop        |
| 164 | d37a7de8 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 8.18/3.58              | 3.77    | 192     | 8           | reference:intent_engine   |
| 165 | d37a7de8 | cash/plo8/river/3p         | -/-                             | yes         | reproduced |        | 9.20/3.19              | 3.36    | 132     | 8           | reference:postflop        |
| 166 | d37a7de8 | cash/flo8/river/3p         | -/-                             | yes         | reproduced |        | 7.87/2.89              | 3.06    | 132     | 8           | reference:postflop        |
| 167 | d37a7de8 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 14.89/8.43             | 8.72    | 132     | 8           | reference:intent_engine   |
| 168 | d37a7de8 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 8.19/2.31              | 2.51    | 192     | 8           | reference:intent_engine   |
| 169 | d37a7de8 | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |        | 4.79/2.34              | 2.48    | 0       | 8           | reference:intent_engine   |
| 170 | d37a7de8 | cash/flo8/river/2p         | -/-                             | yes         | reproduced |        | 8.24/2.53              | 2.66    | 132     | 8           | reference:postflop        |
| 171 | d37a7de8 | mtt/plo6/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |        | 71.06/24.33            | 24.54   | 96      | 8           | reference:intent_engine   |
| 172 | d37a7de8 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 8.20/3.58              | 3.81    | 192     | 8           | reference:intent_engine   |
| 173 | d37a7de8 | cash/short_deck/turn/2p    | -/-                             | yes         | reproduced |        | 3.56/1.21              | 1.34    | 270     | 8           | reference:postflop        |
| 174 | d37a7de8 | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |        | 14.68/6.91             | 7.11    | 77      | 8           | reference:postflop        |
| 175 | d37a7de8 | cash/pineapple/turn/3p     | -/-                             | yes         | reproduced |        | 1.92/0.76              | 0.91    | 157     | 8           | reference:postflop        |
| 176 | d37a7de8 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 28.50/11.28            | 11.49   | 192     | 8           | reference:intent_engine   |
| 177 | d37a7de8 | hu_sng/plo4/flop/2p        | -/-                             | yes         | reproduced |        | 25.00/8.12             | 8.34    | 132     | 8           | reference:postflop        |
| 178 | d37a7de8 | mtt/plo6/river/4p          | -/-                             | yes         | reproduced |        | 25.71/8.41             | 8.80    | 72      | 8           | reference:postflop        |
| 179 | d37a7de8 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |        | 19.81/7.03             | 7.29    | 132     | 8           | reference:intent_engine   |
| 180 | d37a7de8 | cash/flo8/river/3p         | -/-                             | yes         | reproduced |        | 19.05/1.62             | 2.24    | 77      | 8           | reference:postflop        |
| 181 | d37a7de8 | spin/plo6/preflop/3p       | variant_price/variant_price     | yes         | reproduced |        | 27.03/6.88             | 7.09    | 192     | 8           | reference:variant_price   |
| 182 | d37a7de8 | cash/plo8/flop/5p          | -/-                             | yes         | reproduced |        | 7.01/2.49              | 2.64    | 77      | 8           | reference:postflop        |
| 183 | d37a7de8 | cash/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 17.75/6.03             | 6.60    | 60      | 8           | reference:postflop        |
| 184 | d37a7de8 | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 9.85/4.68              | 4.93    | 60      | 8           | reference:intent_engine   |
| 185 | d37a7de8 | spin/plo6/preflop/3p       | variant_price/variant_price     | yes         | reproduced |        | 9.60/3.98              | 4.17    | 120     | 8           | reference:variant_price   |
| 186 | d37a7de8 | cash/short_deck/turn/6p    | -/-                             | yes         | reproduced |        | 2.37/1.00              | 1.17    | 157     | 8           | reference:postflop        |
| 187 | d37a7de8 | cash/flo8/river/3p         | -/-                             | yes         | reproduced |        | 8.61/2.55              | 2.71    | 132     | 8           | reference:postflop        |
| 188 | d37a7de8 | cash/flh/river/2p          | -/-                             | yes         | reproduced |        | 6.85/1.50              | 1.65    | 270     | 8           | reference:postflop        |
| 189 | d37a7de8 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 220.58/12.98           | 13.15   | 132     | 8           | reference:intent_engine   |
| 190 | d37a7de8 | spin/nlh/preflop/3p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |        | 15.08/4.66             | 5.29    | 320     | 8           | reference:chart_bb_defend |
| 191 | d37a7de8 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |        | 21.63/7.56             | 8.25    | 320     | 8           | reference:intent_engine   |
| 192 | d37a7de8 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 43.37/7.10             | 7.31    | 220     | 8           | reference:intent_engine   |
| 193 | d37a7de8 | mtt/plo4/river/2p          | -/-                             | yes         | reproduced |        | 5.62/1.83              | 2.08    | 220     | 8           | reference:postflop        |
| 194 | d37a7de8 | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 4.97/0.36              | 0.59    | 0       | 8           | reference:intent_engine   |
| 195 | d37a7de8 | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |        | 4.83/2.10              | 2.24    | 0       | 8           | reference:intent_engine   |
| 196 | d37a7de8 | hu_sng/nlh/flop/2p         | -/-                             | yes         | reproduced |        | 17.75/8.60             | 8.80    | 270     | 8           | reference:postflop        |
| 197 | d37a7de8 | mtt/plo5/turn/3p           | -/-                             | yes         | reproduced |        | 17.97/6.84             | 7.45    | 170     | 8           | reference:postflop        |
| 198 | d37a7de8 | spin/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 30.18/13.20            | 13.51   | 96      | 8           | reference:intent_engine   |
| 199 | d37a7de8 | cash/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.61/0.15              | 0.29    | 0       | 8           | reference:intent_engine   |
| 200 | d37a7de8 | mtt/plo5/river/2p          | -/-                             | yes         | reproduced |        | 10.24/3.11             | 3.32    | 102     | 8           | reference:postflop        |
| 201 | d37a7de8 | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |        | 0.88/7.20              | 7.41    | 0       | 8           | reference:intent_engine   |
| 202 | d37a7de8 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |        | 15.37/4.93             | 5.50    | 192     | 8           | reference:chart_bb_defend |
| 203 | d37a7de8 | cash/plo6/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.14/0.30              | 0.43    | 0       | 8           | reference:intent_engine   |
| 204 | d37a7de8 | cash/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 7.41/2.36              | 2.57    | 132     | 8           | reference:postflop        |
| 205 | d37a7de8 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 18.45/5.16             | 5.37    | 132     | 8           | reference:intent_engine   |
| 206 | d37a7de8 | cash/plo4/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |        | 2.11/0.26              | 0.40    | 0       | 8           | reference:intent_engine   |
| 207 | d37a7de8 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |        | 24.29/6.00             | 6.17    | 192     | 8           | reference:intent_engine   |
| 208 | d37a7de8 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 32.53/4.79             | 4.99    | 102     | 8           | reference:intent_engine   |
| 209 | d37a7de8 | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.66/0.19              | 0.32    | 0       | 8           | reference:intent_engine   |
| 210 | d37a7de8 | cash/plo6/flop/3p          | -/-                             | yes         | reproduced |        | 16.37/6.17             | 6.29    | 72      | 8           | reference:postflop        |
| 211 | d37a7de8 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 16.32/4.82             | 5.34    | 132     | 8           | reference:intent_engine   |
| 212 | d37a7de8 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |        | 24.91/5.68             | 6.15    | 132     | 8           | reference:intent_engine   |
| 213 | d37a7de8 | mtt/plo6/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |        | 74.98/15.22            | 15.88   | 96      | 8           | reference:intent_engine   |
| 214 | d37a7de8 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 6.11/1.89              | 2.01    | 0       | 8           | reference:intent_engine   |
| 215 | d37a7de8 | cash/short_deck/flop/6p    | -/-                             | yes         | reproduced |        | 8.93/1.87              | 2.30    | 450     | 8           | reference:postflop        |
| 216 | d37a7de8 | hu_sng/plo4/preflop/2p     | variant_price/variant_price     | yes         | reproduced |        | 35.35/9.10             | 9.31    | 396     | 8           | reference:variant_price   |
| 217 | d37a7de8 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |        | 8.18/2.70              | 2.90    | 192     | 8           | reference:chart_bb_defend |
| 218 | d37a7de8 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |        | 26.62/8.12             | 8.32    | 220     | 8           | reference:intent_engine   |
| 219 | d37a7de8 | cash/short_deck/turn/4p    | -/-                             | yes         | reproduced |        | 5.33/1.72              | 1.85    | 450     | 8           | reference:postflop        |
| 220 | d37a7de8 | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 25.36/7.70             | 7.88    | 170     | 8           | reference:intent_engine   |
| 221 | d37a7de8 | cash/flo8/turn/3p          | -/-                             | yes         | reproduced |        | 20.65/4.73             | 4.85    | 220     | 8           | reference:postflop        |
| 222 | d37a7de8 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |        | 7.61/2.48              | 2.73    | 320     | 8           | reference:chart_bb_defend |
| 223 | d37a7de8 | cash/plo4/flop/3p          | -/-                             | yes         | reproduced |        | 12.60/3.27             | 3.44    | 220     | 8           | reference:postflop        |
| 224 | d37a7de8 | mtt/plo6/river/4p          | -/-                             | yes         | reproduced |        | 20.21/5.95             | 6.19    | 120     | 8           | reference:postflop        |
| 225 | d37a7de8 | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.92/0.18              | 0.69    | 0       | 8           | reference:intent_engine   |
| 226 | d37a7de8 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |        | 19.20/6.30             | 6.48    | 220     | 8           | reference:intent_engine   |
| 227 | d37a7de8 | cash/plo8/river/3p         | -/-                             | yes         | reproduced |        | 12.18/5.12             | 5.67    | 220     | 8           | reference:postflop        |
| 228 | d37a7de8 | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 3.28/0.26              | 0.50    | 0       | 8           | reference:intent_engine   |
| 229 | d37a7de8 | cash/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 0.80/0.18              | 0.30    | 0       | 8           | reference:intent_engine   |
| 230 | d37a7de8 | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |        | 13.58/4.89             | 5.00    | 170     | 8           | reference:postflop        |
| 231 | d37a7de8 | spin/plo4/river/2p         | -/-                             | yes         | reproduced |        | 6.09/1.83              | 2.02    | 220     | 8           | reference:postflop        |
| 232 | d37a7de8 | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 4.89/2.32              | 2.90    | 0       | 8           | reference:intent_engine   |
| 233 | d37a7de8 | cash/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 0.86/0.19              | 0.32    | 0       | 8           | reference:intent_engine   |
| 234 | d37a7de8 | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |        | 0.76/0.17              | 0.29    | 0       | 8           | reference:intent_engine   |
| 235 | d37a7de8 | cash/plo4/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.28/0.33              | 0.47    | 0       | 8           | reference:intent_engine   |
| 236 | d37a7de8 | cash/pineapple/flop/3p     | -/-                             | yes         | reproduced |        | 3.56/1.09              | 1.24    | 270     | 8           | reference:postflop        |
| 237 | d37a7de8 | cash/plo8/turn/4p          | -/-                             | yes         | reproduced |        | 30.70/11.53            | 11.68   | 254     | 8           | reference:postflop        |
| 238 | d37a7de8 | cash/pineapple/preflop/2p  | intent_engine/intent_engine     | yes         | reproduced |        | 16.72/0.16             | 0.26    | 0       | 8           | reference:intent_engine   |
| 239 | d37a7de8 | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 7.90/1.78              | 1.95    | 0       | 8           | reference:intent_engine   |
| 240 | d37a7de8 | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.66/0.18              | 0.33    | 0       | 8           | reference:intent_engine   |
| 241 | d37a7de8 | cash/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.82/0.20              | 0.32    | 0       | 8           | reference:intent_engine   |
| 242 | d37a7de8 | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |        | 24.06/8.46             | 8.66    | 102     | 8           | reference:postflop        |
| 243 | d37a7de8 | cash/plo6/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 5.09/2.42              | 2.57    | 0       | 8           | reference:intent_engine   |
| 244 | d37a7de8 | cash/plo5/flop/3p          | -/-                             | yes         | reproduced |        | 13.64/2.86             | 3.00    | 60      | 8           | reference:postflop        |
| 245 | d37a7de8 | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |        | 3.92/0.78              | 0.96    | 157     | 8           | reference:postflop        |
| 246 | d37a7de8 | mtt/plo4/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 1.20/0.22              | 0.38    | 0       | 8           | reference:intent_engine   |
| 247 | d37a7de8 | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 12.20/2.84             | 3.00    | 60      | 8           | reference:intent_engine   |
| 248 | d37a7de8 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 47.20/15.20            | 15.78   | 170     | 8           | reference:intent_engine   |
| 249 | d37a7de8 | cash/plo8/turn/3p          | -/-                             | yes         | reproduced |        | 17.09/4.84             | 4.97    | 220     | 8           | reference:postflop        |
| 250 | d37a7de8 | cash/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 0.80/0.19              | 0.31    | 0       | 8           | reference:intent_engine   |
| 251 | d37a7de8 | cash/plo5/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 7.36/1.80              | 1.92    | 0       | 8           | reference:intent_engine   |
| 252 | d37a7de8 | cash/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.89/0.22              | 0.66    | 0       | 8           | reference:intent_engine   |
| 253 | d37a7de8 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 31.01/9.57             | 9.83    | 170     | 8           | reference:intent_engine   |
| 254 | d37a7de8 | cash/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 4.78/2.67              | 2.80    | 0       | 8           | reference:intent_engine   |
| 255 | d37a7de8 | mtt/plo6/river/6p          | -/-                             | yes         | reproduced |        | 36.00/12.74            | 13.05   | 72      | 8           | reference:postflop        |
| 256 | d37a7de8 | cash/short_deck/flop/2p    | -/-                             | yes         | reproduced |        | 4.49/0.88              | 1.47    | 270     | 8           | reference:postflop        |
| 257 | d37a7de8 | mtt/plo6/river/4p          | -/-                             | yes         | reproduced |        | 24.37/7.74             | 7.96    | 72      | 8           | reference:postflop        |
| 258 | d37a7de8 | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |        | 3.67/2.91              | 3.36    | 0       | 8           | reference:intent_engine   |
| 259 | d37a7de8 | cash/pineapple/flop/3p     | -/-                             | yes         | reproduced |        | 6.44/0.48              | 0.61    | 157     | 8           | reference:postflop        |
| 260 | d37a7de8 | mtt/plo6/river/5p          | -/-                             | yes         | reproduced |        | 36.05/14.59            | 14.82   | 72      | 8           | reference:postflop        |
| 261 | d37a7de8 | cash/flo8/turn/3p          | -/-                             | yes         | reproduced |        | 14.00/2.68             | 2.84    | 77      | 8           | reference:postflop        |
| 262 | d37a7de8 | cash/plo8/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.15/0.20              | 0.32    | 0       | 8           | reference:intent_engine   |
| 263 | d37a7de8 | cash/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |        | 0.95/0.18              | 0.29    | 0       | 8           | reference:intent_engine   |
| 264 | d37a7de8 | cash/flo8/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |        | 4.63/0.15              | 0.26    | 0       | 8           | reference:intent_engine   |
| 265 | d37a7de8 | cash/flh/river/2p          | -/-                             | yes         | reproduced |        | 5.21/1.64              | 1.78    | 270     | 8           | reference:postflop        |
| 266 | d37a7de8 | mtt/plo5/turn/3p           | -/-                             | yes         | reproduced |        | 33.04/4.29             | 4.51    | 102     | 8           | reference:postflop        |
| 267 | d37a7de8 | cash/short_deck/preflop/2p | intent_engine/intent_engine     | yes         | reproduced |        | 0.43/0.43              | 0.57    | 0       | 8           | reference:intent_engine   |
| 268 | d37a7de8 | cash/plo8/flop/4p          | -/-                             | yes         | reproduced |        | 23.20/7.17             | 7.32    | 180     | 8           | reference:postflop        |
| 269 | d37a7de8 | cash/flh/turn/2p           | -/-                             | yes         | reproduced |        | 3.02/0.91              | 1.05    | 157     | 8           | reference:postflop        |
| 270 | d37a7de8 | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |        | 8.27/1.17              | 1.36    | 270     | 8           | reference:postflop        |
| 271 | d37a7de8 | cash/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 4.84/1.59              | 1.77    | 0       | 8           | reference:intent_engine   |
| 272 | d37a7de8 | cash/flh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 8.51/0.94              | 1.07    | 0       | 8           | reference:intent_engine   |
| 273 | d37a7de8 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 54.01/1.54             | 2.10    | 0       | 8           | reference:intent_engine   |
| 274 | d37a7de8 | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |        | 3.89/2.93              | 3.05    | 0       | 8           | reference:intent_engine   |
| 275 | d37a7de8 | cash/plo8/flop/3p          | -/-                             | yes         | reproduced |        | 10.33/3.00             | 3.11    | 132     | 8           | reference:postflop        |
| 276 | d37a7de8 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 8.46/1.61              | 2.11    | 0       | 8           | reference:intent_engine   |
| 277 | d37a7de8 | cash/flo8/turn/3p          | -/-                             | yes         | reproduced |        | 17.72/3.26             | 3.43    | 132     | 8           | reference:postflop        |
| 278 | d37a7de8 | cash/flh/river/2p          | -/-                             | yes         | reproduced |        | 52.29/1.31             | 1.48    | 270     | 8           | reference:postflop        |
| 279 | d37a7de8 | cash/plo6/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 4.29/1.16              | 1.28    | 0       | 8           | reference_legality        |
| 280 | d37a7de8 | mtt/plo5/flop/3p           | -/-                             | yes         | reproduced |        | 52.79/3.68             | 4.21    | 102     | 8           | reference:postflop        |
| 281 | d37a7de8 | cash/plo8/turn/3p          | -/-                             | yes         | reproduced |        | 18.59/3.63             | 3.76    | 132     | 8           | reference:postflop        |
| 282 | d37a7de8 | spin/nlh/river/3p          | -/-                             | yes         | reproduced |        | 50.27/17.61            | 17.84   | 270     | 8           | reference:postflop        |
| 283 | d37a7de8 | cash/short_deck/flop/3p    | -/-                             | yes         | reproduced |        | 3.56/1.10              | 1.26    | 270     | 8           | reference:postflop        |
| 284 | d37a7de8 | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 26.28/9.06             | 9.28    | 102     | 8           | reference:postflop        |
| 285 | d37a7de8 | cash/flo8/turn/3p          | -/-                             | yes         | reproduced |        | 8.65/3.47              | 3.62    | 132     | 8           | reference:postflop        |
| 286 | d37a7de8 | cash/short_deck/preflop/2p | intent_engine/intent_engine     | yes         | reproduced |        | 1.51/0.25              | 1.02    | 0       | 8           | reference:intent_engine   |
| 287 | d37a7de8 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |        | 7.32/1.68              | 1.82    | 0       | 8           | reference:intent_engine   |
| 288 | d37a7de8 | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 3.49/0.20              | 0.38    | 0       | 8           | reference:intent_engine   |
| 289 | d37a7de8 | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.87/0.18              | 0.33    | 0       | 8           | reference:intent_engine   |
| 290 | d37a7de8 | cash/short_deck/preflop/6p | intent_engine/intent_engine     | yes         | reproduced |        | 4.83/1.91              | 2.03    | 0       | 8           | reference:intent_engine   |
| 291 | d37a7de8 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 6.41/1.45              | 1.64    | 0       | 8           | reference:intent_engine   |
| 292 | d37a7de8 | cash/flo8/flop/3p          | -/-                             | yes         | reproduced |        | 9.36/2.29              | 2.80    | 60      | 8           | reference:postflop        |
| 293 | d37a7de8 | cash/flo8/flop/2p          | -/-                             | yes         | reproduced |        | 10.82/4.63             | 4.76    | 220     | 8           | reference:postflop        |
| 294 | d37a7de8 | mtt/plo6/turn/4p           | -/-                             | yes         | reproduced |        | 66.56/25.14            | 25.47   | 120     | 8           | reference:postflop        |
| 295 | d37a7de8 | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 21.74/5.50             | 5.71    | 102     | 8           | reference:postflop        |
| 296 | d37a7de8 | cash/flh/turn/2p           | -/-                             | yes         | reproduced |        | 4.05/0.89              | 1.15    | 270     | 8           | reference:postflop        |
| 297 | d37a7de8 | cash/flo8/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |        | 4.80/2.61              | 2.74    | 0       | 8           | reference:intent_engine   |
| 298 | d37a7de8 | cash/flh/river/2p          | -/-                             | yes         | reproduced |        | 8.53/2.25              | 2.40    | 450     | 8           | reference:postflop        |
| 299 | d37a7de8 | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.94/0.25              | 0.44    | 0       | 8           | reference:intent_engine   |
| 300 | d37a7de8 | cash/flo8/flop/3p          | -/-                             | yes         | reproduced |        | 22.11/3.39             | 3.51    | 132     | 8           | reference:postflop        |
| 301 | d37a7de8 | mtt/plo5/flop/3p           | -/-                             | yes         | reproduced |        | 10.34/2.76             | 2.96    | 60      | 8           | reference:postflop        |
| 302 | d37a7de8 | cash/plo8/turn/3p          | -/-                             | yes         | reproduced |        | 15.58/5.35             | 5.92    | 220     | 8           | reference:postflop        |
| 303 | d37a7de8 | cash/flo8/flop/3p          | -/-                             | yes         | reproduced |        | 17.26/3.03             | 3.15    | 132     | 8           | reference:postflop        |
| 304 | d37a7de8 | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 11.67/2.94             | 3.11    | 60      | 8           | reference:postflop        |
| 305 | d37a7de8 | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 31.16/6.58             | 6.78    | 60      | 8           | reference:postflop        |
| 306 | d37a7de8 | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |        | 0.79/0.20              | 0.33    | 0       | 8           | reference:intent_engine   |
| 307 | d37a7de8 | spin/plo4/river/2p         | -/-                             | yes         | reproduced |        | 25.11/8.60             | 8.78    | 132     | 8           | reference:postflop        |
| 308 | d37a7de8 | mtt/plo6/turn/6p           | -/-                             | yes         | reproduced |        | 59.62/16.65            | 16.96   | 72      | 8           | reference:postflop        |
| 309 | d37a7de8 | cash/short_deck/preflop/2p | intent_engine/intent_engine     | yes         | reproduced |        | 0.56/0.18              | 0.29    | 0       | 8           | reference:intent_engine   |
| 310 | d37a7de8 | mtt/plo6/turn/4p           | -/-                             | yes         | reproduced |        | 68.12/11.39            | 11.75   | 72      | 8           | reference:postflop        |
| 311 | d37a7de8 | cash/flh/flop/2p           | -/-                             | yes         | reproduced |        | 9.93/1.28              | 1.40    | 270     | 8           | reference:postflop        |
| 312 | d37a7de8 | cash/plo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 0.81/0.21              | 0.33    | 0       | 8           | reference:intent_engine   |
| 313 | d37a7de8 | spin/plo5/flop/2p          | -/-                             | yes         | reproduced |        | 32.91/7.09             | 7.30    | 102     | 8           | reference:postflop        |
| 314 | d37a7de8 | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |        | 8.78/2.21              | 2.40    | 77      | 8           | reference:postflop        |
| 315 | d37a7de8 | mtt/plo5/flop/3p           | -/-                             | yes         | reproduced |        | 7.48/2.36              | 2.82    | 60      | 8           | reference:postflop        |
| 316 | d37a7de8 | spin/plo4/flop/2p          | -/-                             | yes         | reproduced |        | 20.08/4.44             | 4.60    | 60      | 8           | reference:postflop        |
| 317 | d37a7de8 | spin/plo4/river/2p         | -/-                             | yes         | reproduced |        | 12.85/2.18             | 2.34    | 60      | 8           | reference:postflop        |
| 318 | d37a7de8 | cash/flh/flop/2p           | -/-                             | yes         | reproduced |        | 4.14/1.29              | 1.41    | 450     | 8           | reference:postflop        |
| 319 | d37a7de8 | cash/flh/turn/3p           | -/-                             | yes         | reproduced |        | 6.60/0.52              | 0.64    | 90      | 8           | reference:postflop        |
| 320 | d37a7de8 | mtt/plo6/turn/6p           | -/-                             | yes         | reproduced |        | 42.66/11.57            | 11.81   | 60      | 8           | reference:postflop        |
| 321 | d37a7de8 | cash/flo8/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |        | 3.05/0.20              | 0.32    | 0       | 8           | reference:intent_engine   |
| 322 | d37a7de8 | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 3.38/1.21              | 1.37    | 0       | 8           | reference:intent_engine   |
| 323 | d37a7de8 | cash/flo8/flop/2p          | -/-                             | yes         | reproduced |        | 57.87/1.70             | 1.80    | 60      | 8           | reference:postflop        |
| 324 | d37a7de8 | cash/flo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 2.12/0.16              | 0.27    | 0       | 8           | reference:intent_engine   |
| 325 | d37a7de8 | cash/flo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |        | 1.26/0.15              | 0.26    | 0       | 8           | reference:intent_engine   |
| 326 | d37a7de8 | mtt/plo6/turn/4p           | -/-                             | yes         | reproduced |        | 58.07/9.54             | 9.75    | 60      | 8           | reference:postflop        |
| 327 | d37a7de8 | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |        | 0.93/0.29              | 0.48    | 0       | 8           | reference:intent_engine   |
| 328 | d37a7de8 | cash/flh/turn/3p           | -/-                             | yes         | reproduced |        | 3.72/0.67              | 0.78    | 270     | 8           | reference:postflop        |
| 329 | d37a7de8 | spin/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 55.93/10.89            | 11.50   | 102     | 8           | reference:postflop        |
| 330 | d37a7de8 | cash/flh/turn/2p           | -/-                             | yes         | reproduced |        | 3.55/1.13              | 1.28    | 156     | 8           | reference:postflop        |
| 331 | d37a7de8 | cash/flh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 1.86/0.18              | 0.30    | 0       | 8           | reference:intent_engine   |
| 332 | d37a7de8 | spin/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 21.49/10.70            | 10.91   | 102     | 8           | reference:postflop        |
| 333 | d37a7de8 | cash/flh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |        | 10.92/0.17             | 0.27    | 0       | 8           | reference:intent_engine   |
| 334 | d37a7de8 | mtt/plo6/flop/6p           | -/-                             | yes         | reproduced |        | 99.92/15.67            | 15.90   | 72      | 8           | reference:postflop        |
| 335 | d37a7de8 | cash/flh/flop/3p           | -/-                             | yes         | reproduced |        | 3.61/0.92              | 1.05    | 270     | 8           | reference:postflop        |
| 336 | d37a7de8 | cash/flh/flop/2p           | -/-                             | yes         | reproduced |        | 6.85/1.66              | 1.90    | 270     | 8           | reference:postflop        |
| 337 | d37a7de8 | mtt/plo6/flop/6p           | -/-                             | yes         | reproduced |        | 53.04/17.06            | 17.79   | 72      | 8           | reference:postflop        |
| 338 | d37a7de8 | mtt/plo6/flop/5p           | -/-                             | yes         | reproduced |        | 48.97/23.97            | 25.03   | 72      | 8           | reference:postflop        |
| 339 | d37a7de8 | spin/plo6/river/3p         | -/-                             | yes         | reproduced |        | 111.12/12.02           | 12.28   | 120     | 8           | reference:postflop        |
| 340 | d37a7de8 | mtt/plo6/flop/6p           | -/-                             | yes         | reproduced |        | 38.73/13.83            | 14.09   | 72      | 8           | reference:postflop        |
| 341 | d37a7de8 | mtt/plo6/flop/4p           | -/-                             | yes         | reproduced |        | 39.79/16.70            | 16.95   | 60      | 8           | reference:postflop        |
| 342 | d37a7de8 | spin/plo6/river/3p         | -/-                             | yes         | reproduced |        | 15.68/3.56             | 3.78    | 72      | 8           | reference:postflop        |
| 343 | d37a7de8 | mtt/plo4/flop/2p           | -/-                             | yes         | reproduced |        | 6.21/3.67              | 3.91    | 220     | 8           | reference_legality        |
| 344 | d37a7de8 | spin/plo6/river/3p         | -/-                             | yes         | reproduced |        | 36.80/11.18            | 11.84   | 120     | 8           | reference:postflop        |
| 345 | d37a7de8 | spin/plo6/river/3p         | -/-                             | yes         | reproduced |        | 16.87/7.26             | 7.48    | 120     | 8           | reference:postflop        |
| 346 | d37a7de8 | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 26.76/9.56             | 9.80    | 72      | 8           | reference:postflop        |
| 347 | d37a7de8 | cash/flo8/turn/4p          | -/-                             | yes         | reproduced |        | 22.09/9.81             | 9.97    | 220     | 8           | reference:postflop        |
| 348 | d37a7de8 | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 55.62/11.62            | 11.85   | 120     | 8           | reference:postflop        |
| 349 | d37a7de8 | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 23.24/10.84            | 11.05   | 120     | 8           | reference:postflop        |
| 350 | d37a7de8 | spin/plo6/turn/3p          | -/-                             | yes         | reproduced |        | 36.80/8.67             | 8.90    | 72      | 8           | reference:postflop        |
| 351 | d37a7de8 | spin/plo5/river/2p         | -/-                             | yes         | reproduced |        | 43.35/8.26             | 8.46    | 170     | 8           | reference:postflop        |
| 352 | d37a7de8 | spin/plo5/turn/2p          | -/-                             | yes         | reproduced |        | 42.08/12.19            | 12.40   | 170     | 8           | reference:postflop        |
| 353 | d37a7de8 | spin/plo5/river/3p         | -/-                             | yes         | reproduced |        | 18.23/6.67             | 6.87    | 170     | 8           | reference:postflop        |
| 354 | d37a7de8 | spin/plo5/river/3p         | -/-                             | yes         | reproduced |        | 39.77/11.36            | 11.56   | 170     | 8           | reference:postflop        |
| 355 | d37a7de8 | spin/plo5/turn/3p          | -/-                             | yes         | reproduced |        | 25.42/12.34            | 12.82   | 170     | 8           | reference:postflop        |
| 356 | d37a7de8 | spin/plo5/river/2p         | -/-                             | yes         | reproduced |        | 12.44/5.45             | 5.97    | 102     | 8           | reference:postflop        |
| 357 | d37a7de8 | spin/plo5/river/3p         | -/-                             | yes         | reproduced |        | 74.45/11.39            | 11.63   | 170     | 8           | reference:postflop        |
| 358 | d37a7de8 | spin/plo6/turn/2p          | -/-                             | yes         | reproduced |        | 30.21/8.28             | 8.48    | 120     | 8           | reference_legality        |
| 359 | d37a7de8 | mtt/plo4/river/3p          | -/-                             | yes         | reproduced |        | 5.23/1.64              | 1.84    | 132     | 8           | reference:postflop        |
| 360 | d37a7de8 | spin/plo6/river/2p         | -/-                             | yes         | reproduced |        | 22.89/8.06             | 8.25    | 120     | 8           | reference:postflop        |
| 361 | d37a7de8 | mtt/plo4/flop/3p           | -/-                             | yes         | reproduced |        | 10.87/3.28             | 3.47    | 220     | 8           | reference_legality        |
| 362 | d37a7de8 | mtt/plo4/turn/3p           | -/-                             | yes         | reproduced |        | 19.37/1.88             | 2.05    | 77      | 8           | reference:postflop        |
| 363 | d37a7de8 | mtt/plo4/turn/3p           | -/-                             | yes         | reproduced |        | 9.92/2.46              | 2.64    | 132     | 8           | reference:postflop        |
| 364 | d37a7de8 | mtt/plo4/flop/3p           | -/-                             | yes         | reproduced |        | 6.17/2.32              | 2.49    | 132     | 8           | reference_legality        |
| 365 | d37a7de8 | mtt/plo4/flop/3p           | -/-                             | yes         | reproduced |        | 10.40/3.27             | 3.92    | 220     | 8           | reference:postflop        |
| 366 | d37a7de8 | mtt/plo4/flop/3p           | -/-                             | yes         | reproduced |        | 8.89/2.23              | 2.41    | 132     | 8           | reference:postflop        |
| 367 | d37a7de8 | mtt/plo4/river/2p          | -/-                             | yes         | reproduced |        | 43.64/3.12             | 3.27    | 220     | 8           | reference:postflop        |
| 368 | d37a7de8 | mtt/plo4/river/2p          | -/-                             | yes         | reproduced |        | 15.79/0.99             | 1.15    | 77      | 8           | reference:postflop        |
| 369 | d37a7de8 | mtt/plo4/river/3p          | -/-                             | yes         | reproduced |        | 10.71/2.53             | 2.78    | 220     | 8           | reference:postflop        |
| 370 | d37a7de8 | mtt/plo4/turn/2p           | -/-                             | yes         | reproduced |        | 13.29/3.58             | 3.75    | 220     | 8           | reference:postflop        |
| 371 | d37a7de8 | mtt/plo4/turn/3p           | -/-                             | yes         | reproduced |        | 14.86/3.32             | 3.95    | 220     | 8           | reference:postflop        |
| 372 | d37a7de8 | mtt/plo4/turn/3p           | -/-                             | yes         | reproduced |        | 7.63/2.51              | 2.70    | 132     | 8           | reference:postflop        |
| 373 | d37a7de8 | mtt/plo5/river/2p          | -/-                             | yes         | reproduced |        | 8.50/4.32              | 4.56    | 170     | 8           | reference:postflop        |
| 374 | d37a7de8 | mtt/plo5/river/2p          | -/-                             | yes         | reproduced |        | 12.78/4.62             | 4.79    | 170     | 8           | reference:postflop        |
| 375 | d37a7de8 | mtt/plo5/flop/2p           | -/-                             | yes         | reproduced |        | 9.22/4.81              | 5.36    | 170     | 8           | reference:postflop        |
| 376 | d37a7de8 | mtt/plo5/flop/3p           | -/-                             | yes         | reproduced |        | 11.57/4.95             | 5.14    | 170     | 8           | reference:postflop        |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
