# Phase 6C exact-input replay evidence (2026-09-30T11:26:50.581Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`. Evidence shape: aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position.

## Batch

- Command: `node scripts/phase6c-replay.mjs /Volumes/SmarterArchives/agent-evidence/horse-brain-resume-20260930-01a09144/private/phase6d-f92ef579.ndjson --engine-sha f92ef5798bbc968f19a33f8515a5025a62e840d5 --population /Volumes/SmarterArchives/agent-evidence/horse-brain-resume-20260930-01a09144/population/population-2026-09-30-f92ef579.json --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-chart-store-2c8a2d9f448e.json --store-snapshot /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/p6c-stores/stores/phase6c-store-solver-store-postflop-dff78313b437.json --label serving-f92ef579-population --out /Volumes/SmarterArchives/agent-evidence/horse-brain-resume-20260930-01a09144/replay`
- Batch rule: every decision admitted by the Phase 6D population population-2026-09-30-f92ef579.json (sha256 ece4505681b984b138a38021756d51349b14d77e3283afe046d742c000c1abb9), in its chain order; 0 of them not found in the source
- Source: ndjson copy (198 records)
- Decisions from 2026-09-30T10:02:20.425Z to 2026-09-30T10:03:20.446Z
- Serving engine SHA (declared): `f92ef5798bbc968f19a33f8515a5025a62e840d5`
- Replay engine SHA (code that ran): `a5a70d21457d39a54edf7b26a6c1999b38b00298` (not the serving engine)
- Releases recorded on the replayed rows: `f92ef5798bbc968f19a33f8515a5025a62e840d5`
- Rows for the serving engine in this batch: 198
- Chart store at replay: 240 entries, digest `2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf`, revision 2026-07-19T15:11:48.555537+00:00
- Postflop store at replay: 7747 entries, digest `dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d`, revision 2026-09-03T18:18:13.594197+00:00
- Snapshot chart_store: fetched 2026-09-27T22:18:16.947Z to 2026-09-27T22:18:17.572Z from memory_charts_gold through the production loader, identity recomputed by the store module on load
- Snapshot solver_store:postflop: fetched 2026-09-27T22:18:18.975Z to 2026-09-27T22:18:37.081Z from gto_postflop_compact through the production loader, identity recomputed by the store module on load
- Release `f92ef5798bbc` committed 2026-09-29T22:06:06.000Z (no process running it started earlier)
- Decision-code files that differ, serving engine to replay code: none
- Decision-code files that differ, recorded release `f92ef5798bbc` to replay code: none

## Result

- Total: 198
- reproduced: 196 of 198
- diverged: 0 of 198
- refused: 2 of 198
- Independent qualification: agreed 196, disagreed 0, refused (reference unavailable) 2
- Receipt digest equal to the original: 196 of 196 replayed
- Authority owner identical between original and replay: 196 of 196 replayed

### Status and reason

| status:reason                          | count |
| -------------------------------------- | ----- |
| reproduced:clean                       | 196   |
| refused:replay_unsupported:DECIDE_DEEP | 2     |

### Solver-store references

| reference   | status and detail                    | decisions |
| ----------- | ------------------------------------ | --------- |
| chart_store | available: identity 240@2c8a2d9f448e | 33        |

### Latency and work

- Replay computeMs median 4.79, p95 18.74; original computeMs median 9.75, p95 42.28; replay wall (runtime round trip) median 5.27, p95 19.18
- Equity samples per replay: median 170, max 396; equity calls median 1; policy-graph node visits median 8

### Authority (module that produced the accepted action, original decisions)

| module                    | count |
| ------------------------- | ----- |
| reference:intent_engine   | 144   |
| reference:chart_open_jam  | 21    |
| reference:variant_price   | 18    |
| reference:chart_bb_defend | 11    |
| reference_legality        | 4     |

## Coverage Matrix (format x variant x street x outcome)

180 declared cells (5 formats x 9 registered variants x 4 streets): 16 observed, of which 14 fully replayed, 2 partly unreplayed and 0 unreplayed; 164 unobserved; 0 observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.

### Observed cells

| format | variant    | street  | observed | reproduced | diverged | refused | coverage          | outcomes (route or reason)                                                                                                       | table sizes                  |
| ------ | ---------- | ------- | -------- | ---------- | -------- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| cash   | nlh        | preflop | 18       | 18         | 0        | 0       | replayed          | reproduced:intent_engine 18                                                                                                      | 2 3; 3 3; 4 3; 6 3; 7 3; 9 3 |
| cash   | plo5       | preflop | 3        | 3          | 0        | 0       | replayed          | reproduced:intent_engine 3                                                                                                       | 4 3                          |
| cash   | plo8       | preflop | 6        | 6          | 0        | 0       | replayed          | reproduced:intent_engine 6                                                                                                       | 3 3; 5 3                     |
| cash   | short_deck | preflop | 6        | 6          | 0        | 0       | replayed          | reproduced:intent_engine 6                                                                                                       | 3 3; 4 3                     |
| cash   | flh        | preflop | 3        | 3          | 0        | 0       | replayed          | reproduced:intent_engine 3                                                                                                       | 6 3                          |
| cash   | flo8       | preflop | 6        | 6          | 0        | 0       | replayed          | reproduced:intent_engine 6                                                                                                       | 5 3; 6 3                     |
| mtt    | nlh        | preflop | 36       | 36         | 0        | 0       | replayed          | reproduced:intent_engine 22; reproduced:chart_open_jam 9; reproduced:chart_bb_defend 5                                           | 2 5; 3 18; 6 13              |
| mtt    | plo4       | preflop | 3        | 3          | 0        | 0       | replayed          | reproduced:variant_price 2; reproduced:intent_engine 1                                                                           | 3 3                          |
| mtt    | plo5       | preflop | 10       | 10         | 0        | 0       | replayed          | reproduced:intent_engine 8; reproduced:variant_price 2                                                                           | 2 3; 3 7                     |
| mtt    | plo6       | preflop | 7        | 7          | 0        | 0       | replayed          | reproduced:intent_engine 5; reproduced:variant_price 2                                                                           | 2 5; 3 2                     |
| spin   | nlh        | preflop | 40       | 39         | 0        | 1       | partly unreplayed | reproduced:intent_engine 26; reproduced:chart_open_jam 9; reproduced:chart_bb_defend 4; refused:replay_unsupported:DECIDE_DEEP 1 | 2 12; 3 28                   |
| spin   | plo4       | preflop | 11       | 11         | 0        | 0       | replayed          | reproduced:intent_engine 6; reproduced:variant_price 5                                                                           | 2 2; 3 9                     |
| spin   | plo5       | preflop | 17       | 17         | 0        | 0       | replayed          | reproduced:intent_engine 11; reproduced:variant_price 6                                                                          | 2 4; 3 13                    |
| spin   | plo6       | preflop | 7        | 7          | 0        | 0       | replayed          | reproduced:intent_engine 4; reproduced:variant_price 3                                                                           | 2 5; 3 2                     |
| hu_sng | nlh        | preflop | 15       | 14         | 0        | 1       | partly unreplayed | reproduced:intent_engine 8; reproduced:chart_bb_defend 3; reproduced:chart_open_jam 3; refused:replay_unsupported:DECIDE_DEEP 1  | 2 15                         |
| hu_sng | plo4       | preflop | 10       | 10         | 0        | 0       | replayed          | reproduced:intent_engine 9; reproduced:variant_price 1                                                                           | 2 10                         |

### Unreplayed decisions by cell and named reason

| format | variant | street  | reason                                 | decisions |
| ------ | ------- | ------- | -------------------------------------- | --------- |
| spin   | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP | 1         |
| hu_sng | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP | 1         |

### Unobserved cells

| format | variant    | unobserved streets |
| ------ | ---------- | ------------------ |
| cash   | nlh        | flop, turn, river  |
| cash   | plo4       | all four           |
| cash   | plo5       | flop, turn, river  |
| cash   | plo6       | all four           |
| cash   | plo8       | flop, turn, river  |
| cash   | short_deck | flop, turn, river  |
| cash   | pineapple  | all four           |
| cash   | flh        | flop, turn, river  |
| cash   | flo8       | flop, turn, river  |
| mtt    | nlh        | flop, turn, river  |
| mtt    | plo4       | flop, turn, river  |
| mtt    | plo5       | flop, turn, river  |
| mtt    | plo6       | flop, turn, river  |
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
| spin   | nlh        | flop, turn, river  |
| spin   | plo4       | flop, turn, river  |
| spin   | plo5       | flop, turn, river  |
| spin   | plo6       | flop, turn, river  |
| spin   | plo8       | all four           |
| spin   | short_deck | all four           |
| spin   | pineapple  | all four           |
| spin   | flh        | all four           |
| spin   | flo8       | all four           |
| hu_sng | nlh        | flop, turn, river  |
| hu_sng | plo4       | flop, turn, river  |
| hu_sng | plo5       | all four           |
| hu_sng | plo6       | all four           |
| hu_sng | plo8       | all four           |
| hu_sng | short_deck | all four           |
| hu_sng | pineapple  | all four           |
| hu_sng | flh        | all four           |
| hu_sng | flo8       | all four           |

## Decisions

| #   | release  | format/variant/street/size | route orig/replay               | action same | status     | reason                         | compute orig/replay ms | wall ms | samples | node visits | authority                 |
| --- | -------- | -------------------------- | ------------------------------- | ----------- | ---------- | ------------------------------ | ---------------------- | ------- | ------- | ----------- | ------------------------- |
| 1   | f92ef579 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.17/31.25             | 38.97   | 0       | 8           | reference:intent_engine   |
| 2   | f92ef579 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.25/4.72              | 6.10    | 0       | 8           | reference:intent_engine   |
| 3   | f92ef579 | cash/plo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 2.69/3.55              | 3.97    | 0       | 8           | reference:intent_engine   |
| 4   | f92ef579 | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 14.08/40.10            | 41.25   | 170     | 8           | reference:intent_engine   |
| 5   | f92ef579 | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 12.24/12.87            | 13.86   | 170     | 8           | reference:intent_engine   |
| 6   | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 13.31/33.86            | 34.61   | 220     | 8           | reference:intent_engine   |
| 7   | f92ef579 | spin/plo6/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 18.74/30.14            | 30.54   | 160     | 8           | reference:intent_engine   |
| 8   | f92ef579 | spin/plo6/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 19.51/10.14            | 10.54   | 160     | 8           | reference:intent_engine   |
| 9   | f92ef579 | spin/plo6/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 12.35/8.16             | 8.53    | 160     | 8           | reference:intent_engine   |
| 10  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 14.10/6.92             | 7.67    | 220     | 8           | reference:intent_engine   |
| 11  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 13.47/10.41            | 10.87   | 220     | 8           | reference:intent_engine   |
| 12  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 17.97/9.90             | 10.21   | 220     | 8           | reference:intent_engine   |
| 13  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 24.87/18.83            | 19.75   | 170     | 8           | reference:intent_engine   |
| 14  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 11.78/9.52             | 9.85    | 170     | 8           | reference:intent_engine   |
| 15  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 11.47/6.75             | 7.49    | 320     | 8           | reference:intent_engine   |
| 16  | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 10.55/6.37             | 6.88    | 320     | 8           | reference:intent_engine   |
| 17  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 40.06/15.68            | 15.98   | 170     | 8           | reference:intent_engine   |
| 18  | f92ef579 | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 18.44/12.42            | 12.69   | 330     | 8           | reference:variant_price   |
| 19  | f92ef579 | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 19.46/13.36            | 14.09   | 330     | 8           | reference:variant_price   |
| 20  | f92ef579 | spin/plo5/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                                | 15.57/10.29            | 10.73   | 330     | 8           | reference:variant_price   |
| 21  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 24.88/15.76            | 16.11   | 170     | 8           | reference:intent_engine   |
| 22  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 24.81/17.95            | 18.23   | 170     | 8           | reference:intent_engine   |
| 23  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 24.08/19.33            | 19.61   | 170     | 8           | reference:intent_engine   |
| 24  | f92ef579 | spin/plo6/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 13.80/9.78             | 10.10   | 160     | 8           | reference:intent_engine   |
| 25  | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.06/2.16              | 2.48    | 0       | 8           | reference:intent_engine   |
| 26  | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.67/0.42              | 0.83    | 0       | 8           | reference:intent_engine   |
| 27  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 11.41/7.07             | 7.44    | 320     | 8           | reference:intent_engine   |
| 28  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 9.67/9.00              | 9.58    | 320     | 8           | reference:intent_engine   |
| 29  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 7.16/5.68              | 6.07    | 320     | 8           | reference:intent_engine   |
| 30  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/-                 | n/a         | refused    | replay_unsupported:DECIDE_DEEP | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 31  | f92ef579 | cash/flo8/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.84/2.93              | 3.09    | 0       | 8           | reference:intent_engine   |
| 32  | f92ef579 | cash/flo8/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                                | 2.55/2.28              | 2.58    | 0       | 8           | reference:intent_engine   |
| 33  | f92ef579 | cash/flo8/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.31/1.71              | 2.02    | 0       | 8           | reference:intent_engine   |
| 34  | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 13.17/7.41             | 7.72    | 320     | 8           | reference:intent_engine   |
| 35  | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 13.26/8.30             | 8.55    | 320     | 8           | reference:intent_engine   |
| 36  | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 9.00/7.13              | 7.41    | 320     | 8           | reference:intent_engine   |
| 37  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 0.76/0.55              | 0.98    | 0       | 8           | reference:intent_engine   |
| 38  | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 24.31/16.90            | 17.31   | 220     | 8           | reference:intent_engine   |
| 39  | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 23.79/17.92            | 18.32   | 220     | 8           | reference:intent_engine   |
| 40  | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 26.08/9.20             | 9.59    | 220     | 8           | reference:intent_engine   |
| 41  | f92ef579 | spin/nlh/preflop/2p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 8.51/5.11              | 5.76    | 320     | 8           | reference:chart_open_jam  |
| 42  | f92ef579 | spin/nlh/preflop/2p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 6.37/4.36              | 4.74    | 320     | 8           | reference:chart_bb_defend |
| 43  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 9.75/6.52              | 7.23    | 170     | 8           | reference:intent_engine   |
| 44  | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 14.71/9.09             | 9.52    | 170     | 8           | reference:intent_engine   |
| 45  | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 6.08/2.36              | 2.67    | 0       | 8           | reference:intent_engine   |
| 46  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 32.17/13.23            | 13.51   | 320     | 8           | reference:intent_engine   |
| 47  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 16.29/7.05             | 7.29    | 320     | 8           | reference:intent_engine   |
| 48  | f92ef579 | cash/plo5/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.81/2.45              | 2.58    | 0       | 8           | reference:intent_engine   |
| 49  | f92ef579 | cash/plo5/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.03/2.96              | 3.27    | 0       | 8           | reference:intent_engine   |
| 50  | f92ef579 | cash/plo5/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.15/2.90              | 3.19    | 0       | 8           | reference:intent_engine   |
| 51  | f92ef579 | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 8.55/4.98              | 5.61    | 320     | 8           | reference:chart_open_jam  |
| 52  | f92ef579 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 5.80/3.16              | 3.55    | 320     | 8           | reference:chart_bb_defend |
| 53  | f92ef579 | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.85/3.71              | 4.05    | 0       | 8           | reference:intent_engine   |
| 54  | f92ef579 | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.56/2.59              | 2.80    | 0       | 8           | reference:intent_engine   |
| 55  | f92ef579 | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.38/2.23              | 2.44    | 0       | 8           | reference:intent_engine   |
| 56  | f92ef579 | mtt/plo6/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.90/0.41              | 0.81    | 0       | 8           | reference:intent_engine   |
| 57  | f92ef579 | mtt/plo6/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.80/0.37              | 0.76    | 0       | 8           | reference:intent_engine   |
| 58  | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 10.24/6.71             | 7.08    | 220     | 8           | reference:intent_engine   |
| 59  | f92ef579 | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 24.51/13.51            | 13.80   | 330     | 8           | reference:variant_price   |
| 60  | f92ef579 | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 28.07/13.27            | 13.70   | 330     | 8           | reference:variant_price   |
| 61  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 25.88/12.49            | 13.31   | 320     | 8           | reference:intent_engine   |
| 62  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 37.08/10.82            | 11.09   | 192     | 8           | reference:intent_engine   |
| 63  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 1.12/0.31              | 0.55    | 0       | 8           | reference:intent_engine   |
| 64  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 0.72/0.43              | 0.81    | 0       | 8           | reference:intent_engine   |
| 65  | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 11.15/4.94             | 5.31    | 320     | 8           | reference:intent_engine   |
| 66  | f92ef579 | mtt/nlh/preflop/2p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.62/0.27              | 0.89    | 0       | 8           | reference:chart_open_jam  |
| 67  | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.75/2.13              | 2.44    | 0       | 8           | reference:intent_engine   |
| 68  | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.99/0.35              | 0.62    | 0       | 8           | reference:intent_engine   |
| 69  | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.87/0.29              | 0.54    | 0       | 8           | reference:intent_engine   |
| 70  | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 12.41/5.32             | 5.57    | 320     | 8           | reference:intent_engine   |
| 71  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 32.03/11.18            | 11.58   | 320     | 8           | reference:intent_engine   |
| 72  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 8.64/5.26              | 5.84    | 320     | 8           | reference:intent_engine   |
| 73  | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.96/2.21              | 2.63    | 0       | 8           | reference:intent_engine   |
| 74  | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 38.08/0.25             | 0.60    | 0       | 8           | reference:intent_engine   |
| 75  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.46/2.16              | 2.65    | 0       | 8           | reference:intent_engine   |
| 76  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.99/1.98              | 2.60    | 0       | 8           | reference:intent_engine   |
| 77  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.43/1.94              | 2.31    | 0       | 8           | reference:intent_engine   |
| 78  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 34.68/18.74            | 19.18   | 320     | 8           | reference:intent_engine   |
| 79  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 19.08/5.88             | 6.16    | 320     | 8           | reference:intent_engine   |
| 80  | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 16.86/8.07             | 8.49    | 320     | 8           | reference:intent_engine   |
| 81  | f92ef579 | spin/plo4/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                                | 19.36/10.92            | 11.32   | 396     | 8           | reference:variant_price   |
| 82  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 16.55/8.44             | 9.30    | 220     | 8           | reference:intent_engine   |
| 83  | f92ef579 | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 17.20/8.52             | 8.93    | 220     | 8           | reference:intent_engine   |
| 84  | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 27.83/11.82            | 12.25   | 320     | 8           | reference:chart_open_jam  |
| 85  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 10.91/5.82             | 6.09    | 320     | 8           | reference:intent_engine   |
| 86  | f92ef579 | cash/nlh/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.75/2.84              | 3.35    | 0       | 8           | reference:intent_engine   |
| 87  | f92ef579 | cash/nlh/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                                | 7.58/3.34              | 3.67    | 0       | 8           | reference:intent_engine   |
| 88  | f92ef579 | cash/nlh/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                                | 6.61/1.92              | 2.13    | 0       | 8           | reference:intent_engine   |
| 89  | f92ef579 | mtt/plo6/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.96/0.37              | 0.75    | 0       | 8           | reference:intent_engine   |
| 90  | f92ef579 | mtt/plo6/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.98/0.32              | 0.69    | 0       | 8           | reference:intent_engine   |
| 91  | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 10.82/1.93             | 2.27    | 0       | 8           | reference:intent_engine   |
| 92  | f92ef579 | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 1.34/0.37              | 0.99    | 0       | 8           | reference:intent_engine   |
| 93  | f92ef579 | mtt/plo5/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 1.02/0.37              | 0.62    | 0       | 8           | reference:intent_engine   |
| 94  | f92ef579 | mtt/plo5/preflop/2p        | variant_price/variant_price     | yes         | reproduced |                                | 8.05/3.37              | 3.65    | 160     | 8           | reference:variant_price   |
| 95  | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 16.03/7.47             | 7.82    | 320     | 8           | reference:chart_open_jam  |
| 96  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 19.62/8.75             | 9.44    | 320     | 8           | reference:intent_engine   |
| 97  | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 16.58/8.07             | 8.73    | 320     | 8           | reference:intent_engine   |
| 98  | f92ef579 | cash/plo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.73/3.07              | 3.54    | 0       | 8           | reference:intent_engine   |
| 99  | f92ef579 | cash/plo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.76/2.59              | 3.16    | 0       | 8           | reference:intent_engine   |
| 100 | f92ef579 | cash/plo8/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 1.10/0.33              | 0.59    | 0       | 8           | reference:intent_engine   |
| 101 | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 7.71/5.10              | 5.52    | 320     | 8           | reference:chart_open_jam  |
| 102 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 29.62/12.31            | 12.71   | 320     | 8           | reference:intent_engine   |
| 103 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 10.53/4.62             | 4.87    | 320     | 8           | reference:intent_engine   |
| 104 | f92ef579 | spin/plo4/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 28.15/11.19            | 11.49   | 396     | 8           | reference:variant_price   |
| 105 | f92ef579 | spin/plo4/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 12.32/7.63             | 8.05    | 396     | 8           | reference:variant_price   |
| 106 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 4.17/1.84              | 2.35    | 0       | 8           | reference:chart_open_jam  |
| 107 | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 14.06/5.83             | 6.59    | 320     | 8           | reference:chart_open_jam  |
| 108 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 21.08/12.51            | 12.93   | 320     | 8           | reference:intent_engine   |
| 109 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 13.47/6.03             | 6.79    | 320     | 8           | reference:intent_engine   |
| 110 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 11.74/7.42             | 7.88    | 320     | 8           | reference:intent_engine   |
| 111 | f92ef579 | spin/plo4/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                                | 21.89/10.27            | 10.52   | 396     | 8           | reference:variant_price   |
| 112 | f92ef579 | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.96/0.40              | 1.25    | 0       | 8           | reference:intent_engine   |
| 113 | f92ef579 | cash/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.50/0.15              | 0.34    | 0       | 8           | reference:intent_engine   |
| 114 | f92ef579 | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 18.11/6.89             | 7.12    | 320     | 8           | reference:chart_open_jam  |
| 115 | f92ef579 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 9.48/5.09              | 5.41    | 320     | 8           | reference:chart_bb_defend |
| 116 | f92ef579 | spin/plo6/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 52.67/20.74            | 21.00   | 320     | 8           | reference:variant_price   |
| 117 | f92ef579 | spin/plo6/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 54.82/22.84            | 23.20   | 320     | 8           | reference:variant_price   |
| 118 | f92ef579 | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                                | 5.77/2.14              | 2.31    | 0       | 8           | reference:intent_engine   |
| 119 | f92ef579 | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                                | 0.71/0.46              | 0.77    | 0       | 8           | reference:intent_engine   |
| 120 | f92ef579 | cash/short_deck/preflop/3p | intent_engine/intent_engine     | yes         | reproduced |                                | 1.92/0.30              | 0.54    | 0       | 8           | reference:intent_engine   |
| 121 | f92ef579 | spin/nlh/preflop/2p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 10.05/5.01             | 5.27    | 320     | 8           | reference:chart_open_jam  |
| 122 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 75.53/18.42            | 19.09   | 320     | 8           | reference:intent_engine   |
| 123 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 42.66/16.60            | 16.91   | 192     | 8           | reference:intent_engine   |
| 124 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 44.19/13.04            | 13.77   | 320     | 8           | reference:intent_engine   |
| 125 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 27.79/6.87             | 7.69    | 192     | 8           | reference:intent_engine   |
| 126 | f92ef579 | spin/plo4/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 17.40/7.64             | 8.07    | 396     | 8           | reference:variant_price   |
| 127 | f92ef579 | cash/nlh/preflop/7p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.96/2.03              | 2.25    | 0       | 8           | reference:intent_engine   |
| 128 | f92ef579 | cash/nlh/preflop/7p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.94/0.20              | 0.73    | 0       | 8           | reference:intent_engine   |
| 129 | f92ef579 | cash/nlh/preflop/7p        | intent_engine/intent_engine     | yes         | reproduced |                                | 8.48/2.08              | 2.38    | 0       | 8           | reference:intent_engine   |
| 130 | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 14.66/6.74             | 7.06    | 320     | 8           | reference:intent_engine   |
| 131 | f92ef579 | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 11.97/5.10             | 5.79    | 320     | 8           | reference:chart_open_jam  |
| 132 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 37.87/20.30            | 20.65   | 320     | 8           | reference:intent_engine   |
| 133 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 73.23/17.00            | 17.29   | 320     | 8           | reference:intent_engine   |
| 134 | f92ef579 | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 99.09/9.62             | 9.94    | 320     | 8           | reference:intent_engine   |
| 135 | f92ef579 | cash/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.48/1.67              | 1.85    | 0       | 8           | reference:intent_engine   |
| 136 | f92ef579 | cash/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.68/2.08              | 2.59    | 0       | 8           | reference:intent_engine   |
| 137 | f92ef579 | cash/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.87/0.29              | 0.63    | 0       | 8           | reference:intent_engine   |
| 138 | f92ef579 | spin/nlh/preflop/2p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 11.88/5.32             | 5.63    | 320     | 8           | reference:chart_open_jam  |
| 139 | f92ef579 | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 4.61/2.43              | 2.70    | 320     | 8           | reference:chart_bb_defend |
| 140 | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 28.27/7.06             | 7.81    | 320     | 8           | reference:intent_engine   |
| 141 | f92ef579 | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.76/2.32              | 2.67    | 0       | 8           | reference:intent_engine   |
| 142 | f92ef579 | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 3.56/2.02              | 2.54    | 0       | 8           | reference:intent_engine   |
| 143 | f92ef579 | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.97/1.75              | 2.10    | 0       | 8           | reference:intent_engine   |
| 144 | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 24.76/6.96             | 7.37    | 320     | 8           | reference:intent_engine   |
| 145 | f92ef579 | cash/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.57/0.16              | 0.69    | 0       | 8           | reference:intent_engine   |
| 146 | f92ef579 | cash/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.57/0.20              | 0.47    | 0       | 8           | reference:intent_engine   |
| 147 | f92ef579 | cash/flo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.65/2.83              | 3.17    | 0       | 8           | reference:intent_engine   |
| 148 | f92ef579 | cash/flo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.61/1.83              | 2.19    | 0       | 8           | reference:intent_engine   |
| 149 | f92ef579 | cash/flo8/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 3.22/1.58              | 1.87    | 0       | 8           | reference:intent_engine   |
| 150 | f92ef579 | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 19.45/11.89            | 12.22   | 170     | 8           | reference:intent_engine   |
| 151 | f92ef579 | cash/flh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 18.10/1.76             | 1.97    | 0       | 8           | reference:intent_engine   |
| 152 | f92ef579 | cash/flh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 42.28/1.65             | 1.96    | 0       | 8           | reference:intent_engine   |
| 153 | f92ef579 | cash/flh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 3.32/1.39              | 1.66    | 0       | 8           | reference:intent_engine   |
| 154 | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 14.11/9.43             | 9.71    | 220     | 8           | reference:intent_engine   |
| 155 | f92ef579 | mtt/plo5/preflop/3p        | variant_price/variant_price     | yes         | reproduced |                                | 10.01/4.79             | 5.05    | 160     | 8           | reference:variant_price   |
| 156 | f92ef579 | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 18.15/7.70             | 8.11    | 320     | 8           | reference:intent_engine   |
| 157 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.62/2.13              | 2.85    | 0       | 8           | reference:chart_open_jam  |
| 158 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.75/0.19              | 0.43    | 0       | 8           | reference:chart_open_jam  |
| 159 | f92ef579 | mtt/nlh/preflop/3p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.99/0.21              | 0.52    | 0       | 8           | reference:chart_bb_defend |
| 160 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 23.21/7.87             | 8.16    | 320     | 8           | reference:intent_engine   |
| 161 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 22.23/7.46             | 8.27    | 320     | 8           | reference:intent_engine   |
| 162 | f92ef579 | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 35.28/7.85             | 8.30    | 132     | 8           | reference:intent_engine   |
| 163 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 33.74/5.10             | 5.34    | 112     | 8           | reference:intent_engine   |
| 164 | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 56.16/6.28             | 6.68    | 192     | 8           | reference:chart_open_jam  |
| 165 | f92ef579 | mtt/nlh/preflop/2p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.56/0.32              | 0.58    | 0       | 8           | reference:chart_open_jam  |
| 166 | f92ef579 | mtt/nlh/preflop/2p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.73/0.26              | 0.70    | 0       | 8           | reference:chart_bb_defend |
| 167 | f92ef579 | spin/nlh/preflop/3p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 28.88/5.46             | 5.68    | 192     | 8           | reference:chart_open_jam  |
| 168 | f92ef579 | mtt/plo6/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 1.04/0.33              | 0.87    | 0       | 8           | reference:intent_engine   |
| 169 | f92ef579 | hu_sng/plo4/preflop/2p     | variant_price/variant_price     | yes         | reproduced |                                | 22.97/10.59            | 11.01   | 396     | 8           | reference:variant_price   |
| 170 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 3.05/1.43              | 1.77    | 0       | 8           | reference:chart_open_jam  |
| 171 | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.51/0.78              | 1.17    | 0       | 8           | reference:intent_engine   |
| 172 | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 9.58/0.28              | 0.64    | 0       | 8           | reference:intent_engine   |
| 173 | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 2.19/1.00              | 1.71    | 0       | 8           | reference:intent_engine   |
| 174 | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.77/0.92              | 1.26    | 0       | 8           | reference:intent_engine   |
| 175 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 14.35/7.75             | 8.11    | 320     | 8           | reference:intent_engine   |
| 176 | f92ef579 | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 0.89/0.18              | 0.69    | 0       | 8           | reference:intent_engine   |
| 177 | f92ef579 | mtt/nlh/preflop/3p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.53/0.34              | 0.70    | 0       | 8           | reference_legality        |
| 178 | f92ef579 | mtt/nlh/preflop/2p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.56/0.21              | 0.53    | 0       | 8           | reference:chart_open_jam  |
| 179 | f92ef579 | mtt/nlh/preflop/2p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.51/0.20              | 0.47    | 0       | 8           | reference:chart_bb_defend |
| 180 | f92ef579 | mtt/plo4/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 3.25/1.72              | 1.98    | 0       | 8           | reference:intent_engine   |
| 181 | f92ef579 | mtt/plo6/preflop/3p        | variant_price/variant_price     | yes         | reproduced |                                | 28.16/4.30             | 4.59    | 160     | 8           | reference_legality        |
| 182 | f92ef579 | mtt/plo6/preflop/2p        | variant_price/variant_price     | yes         | reproduced |                                | 7.95/4.13              | 4.62    | 160     | 8           | reference:variant_price   |
| 183 | f92ef579 | mtt/plo4/preflop/3p        | variant_price/variant_price     | yes         | reproduced |                                | 16.38/3.68             | 4.07    | 176     | 8           | reference_legality        |
| 184 | f92ef579 | mtt/plo4/preflop/3p        | variant_price/variant_price     | yes         | reproduced |                                | 12.68/3.67             | 4.07    | 176     | 8           | reference_legality        |
| 185 | f92ef579 | spin/plo5/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                                | 51.02/14.01            | 14.31   | 330     | 8           | reference:variant_price   |
| 186 | f92ef579 | spin/nlh/preflop/3p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 8.69/3.15              | 3.43    | 320     | 8           | reference:chart_bb_defend |
| 187 | f92ef579 | cash/short_deck/preflop/4p | intent_engine/intent_engine     | yes         | reproduced |                                | 4.96/3.20              | 3.51    | 0       | 8           | reference:intent_engine   |
| 188 | f92ef579 | cash/short_deck/preflop/4p | intent_engine/intent_engine     | yes         | reproduced |                                | 8.15/3.75              | 4.00    | 0       | 8           | reference:intent_engine   |
| 189 | f92ef579 | cash/short_deck/preflop/4p | intent_engine/intent_engine     | yes         | reproduced |                                | 4.98/2.98              | 3.18    | 0       | 8           | reference:intent_engine   |
| 190 | f92ef579 | spin/plo6/preflop/2p       | variant_price/variant_price     | yes         | reproduced |                                | 23.16/10.73            | 11.12   | 320     | 8           | reference:variant_price   |
| 191 | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 5.90/3.19              | 3.49    | 320     | 8           | reference:intent_engine   |
| 192 | f92ef579 | hu_sng/nlh/preflop/2p      | intent_engine/-                 | n/a         | refused    | replay_unsupported:DECIDE_DEEP | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 193 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.92/0.20              | 0.54    | 0       | 8           | reference:chart_open_jam  |
| 194 | f92ef579 | mtt/nlh/preflop/3p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.95/0.27              | 0.65    | 0       | 8           | reference:chart_bb_defend |
| 195 | f92ef579 | mtt/nlh/preflop/3p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 3.40/0.20              | 0.95    | 0       | 8           | reference:chart_open_jam  |
| 196 | f92ef579 | spin/nlh/preflop/3p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 9.15/3.13              | 3.49    | 320     | 8           | reference:chart_bb_defend |
| 197 | f92ef579 | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 7.16/3.12              | 3.58    | 192     | 8           | reference:intent_engine   |
| 198 | f92ef579 | spin/nlh/preflop/3p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 11.15/4.56             | 4.96    | 320     | 8           | reference:chart_bb_defend |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
