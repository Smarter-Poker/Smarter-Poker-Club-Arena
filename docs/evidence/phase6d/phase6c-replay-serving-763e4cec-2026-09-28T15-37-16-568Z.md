# Phase 6C exact-input replay evidence (2026-09-28T15:37:16.568Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`. Evidence shape: aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position.

## Batch

- Command: `node scripts/phase6c-replay.mjs /tmp/p6d-export-763e4cec.ndjson --engine-sha 763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f --population docs/evidence/phase6d/population-2026-09-28-763e4cec.json --out docs/evidence/phase6d --label serving-763e4cec --negative-controls 3 --note 'journal capture read 2026-09-28T15:08:26Z: mode=ready, 2 of 2 decision-shard publishers running'`
- Batch rule: every decision admitted by the Phase 6D population population-2026-09-28-763e4cec.json (sha256 183852d99bc902576a60e8411b97e9b734aaa6583d1f318271f8de3bac9c59b2), in its chain order; 0 of them not found in the source
- Source: ndjson copy (137 records)
- Decisions from 2026-09-28T14:12:00.018Z to 2026-09-28T14:12:30.659Z
- Serving engine SHA (declared): `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
- Replay engine SHA (code that ran): `c8c40525ed0022098aba76344c7588bdb1ce4bc9` (not the serving engine)
- Releases recorded on the replayed rows: `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
- Rows for the serving engine in this batch: 137
- Chart store at replay: 0 entries, digest `a05a0d431a7b0f4890179645b2d771d8b2779505d4c3edc13d6b01f1666133f6`, revision null
- Postflop store at replay: 0 entries, digest `a05a0d431a7b0f4890179645b2d771d8b2779505d4c3edc13d6b01f1666133f6`, revision null
- Release `763e4cec8cdc` committed 2026-09-28T05:51:14.000Z (no process running it started earlier)
- Decision-code files that differ, serving engine to replay code: none
- Decision-code files that differ, recorded release `763e4cec8cdc` to replay code: none
- Note: journal capture read 2026-09-28T15:08:26Z: mode=ready, 2 of 2 decision-shard publishers running

## Result

- Total: 137
- reproduced: 106 of 137
- diverged: 0 of 137
- refused: 31 of 137
- Independent qualification: agreed 106, disagreed 0, refused (reference unavailable) 31
- Receipt digest equal to the original: 106 of 106 replayed
- Authority owner identical between original and replay: 106 of 106 replayed

### Status and reason

| status:reason                             | count |
| ----------------------------------------- | ----- |
| reproduced:clean                          | 106   |
| refused:reference_unavailable:chart_store | 28    |
| refused:replay_unsupported:DECIDE_DEEP    | 3     |

### Solver-store references

| reference   | status and detail                                                      | decisions |
| ----------- | ---------------------------------------------------------------------- | --------- |
| chart_store | unavailable: original identity 240@2c8a2d9f448e, replay 0@a05a0d431a7b | 28        |

### Negative controls (the batch records, changed)

| control            | expectation                                                                                                                    | attempted | passed | outcomes                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------- | ------ | ------------------------------------------------------------------------------------------- |
| substituted_action | a re-signed record whose recorded action was changed replays to the true action and is diverged with reason action             | 3         | 3      | diverged:action 3                                                                           |
| substituted_rng    | a re-signed record whose RNG stream was changed is refused as rng_stream_mismatch                                              | 3         | 3      | refused:rng_stream_mismatch 3                                                               |
| stale_m_state      | M evidence changed and re-signed under a valid decision key is disagreed by the independent m_state check and never reproduced | 3         | 3      | refused:runtime_rejected:Phase 6 tournament M state does not match the canonical snapshot 3 |

### Latency and work

- Replay computeMs median 3.90, p95 19.79; original computeMs median 5.62, p95 45.62; replay wall (runtime round trip) median 4.48, p95 20.05
- Equity samples per replay: median 0, max 320; equity calls median 0; policy-graph node visits median 8

### Authority (module that produced the accepted action, original decisions)

| module                    | count |
| ------------------------- | ----- |
| reference:intent_engine   | 105   |
| reference:chart_open_jam  | 18    |
| reference:chart_bb_defend | 9     |
| reference_legality        | 3     |
| reference:variant_price   | 2     |

## Coverage Matrix (format x variant x street x outcome)

180 declared cells (5 formats x 9 registered variants x 4 streets): 14 observed, of which 11 fully replayed, 3 partly unreplayed and 0 unreplayed; 166 unobserved; 0 observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.

### Observed cells

| format | variant    | street  | observed | reproduced | diverged | refused | coverage          | outcomes (route or reason)                                                                                          | table sizes                         |
| ------ | ---------- | ------- | -------- | ---------- | -------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| cash   | nlh        | preflop | 12       | 12         | 0        | 0       | replayed          | reproduced:intent_engine 12                                                                                         | 4 1; 5 3; 6 5; 9 3                  |
| cash   | plo4       | preflop | 4        | 4          | 0        | 0       | replayed          | reproduced:intent_engine 4                                                                                          | 5 3; 6 1                            |
| cash   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                                                                          | 3 3; 4 2                            |
| cash   | short_deck | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                          | 2 1                                 |
| cash   | pineapple  | preflop | 3        | 3          | 0        | 0       | replayed          | reproduced:intent_engine 3                                                                                          | 4 3                                 |
| mtt    | nlh        | preflop | 55       | 36         | 0        | 19      | partly unreplayed | reproduced:intent_engine 36; refused:reference_unavailable:chart_store 17; refused:replay_unsupported:DECIDE_DEEP 2 | 3 2; 4 3; 5 11; 6 9; 7 9; 8 15; 9 6 |
| mtt    | plo4       | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                          | 2 1                                 |
| mtt    | plo5       | preflop | 2        | 2          | 0        | 0       | replayed          | reproduced:intent_engine 2                                                                                          | 3 2                                 |
| spin   | nlh        | preflop | 15       | 9          | 0        | 6       | partly unreplayed | reproduced:intent_engine 9; refused:reference_unavailable:chart_store 5; refused:replay_unsupported:DECIDE_DEEP 1   | 2 6; 3 9                            |
| spin   | plo4       | preflop | 6        | 6          | 0        | 0       | replayed          | reproduced:intent_engine 6                                                                                          | 2 2; 3 4                            |
| spin   | plo5       | preflop | 13       | 13         | 0        | 0       | replayed          | reproduced:intent_engine 11; reproduced:variant_price 2                                                             | 2 3; 3 10                           |
| spin   | plo6       | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                          | 2 1                                 |
| hu_sng | nlh        | preflop | 14       | 8          | 0        | 6       | partly unreplayed | reproduced:intent_engine 8; refused:reference_unavailable:chart_store 6                                             | 2 14                                |
| hu_sng | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                                                                          | 2 5                                 |

### Unreplayed decisions by cell and named reason

| format | variant | street  | reason                                    | decisions |
| ------ | ------- | ------- | ----------------------------------------- | --------- |
| mtt    | nlh     | preflop | refused:reference_unavailable:chart_store | 17        |
| mtt    | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP    | 2         |
| spin   | nlh     | preflop | refused:reference_unavailable:chart_store | 5         |
| spin   | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP    | 1         |
| hu_sng | nlh     | preflop | refused:reference_unavailable:chart_store | 6         |

### Unobserved cells

| format | variant    | unobserved streets |
| ------ | ---------- | ------------------ |
| cash   | nlh        | flop, turn, river  |
| cash   | plo4       | flop, turn, river  |
| cash   | plo5       | flop, turn, river  |
| cash   | plo6       | all four           |
| cash   | plo8       | all four           |
| cash   | short_deck | flop, turn, river  |
| cash   | pineapple  | flop, turn, river  |
| cash   | flh        | all four           |
| cash   | flo8       | all four           |
| mtt    | nlh        | flop, turn, river  |
| mtt    | plo4       | flop, turn, river  |
| mtt    | plo5       | flop, turn, river  |
| mtt    | plo6       | all four           |
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

| #   | release  | format/variant/street/size | route orig/replay           | action same | status     | reason                            | compute orig/replay ms | wall ms | samples | node visits | authority                 |
| --- | -------- | -------------------------- | --------------------------- | ----------- | ---------- | --------------------------------- | ---------------------- | ------- | ------- | ----------- | ------------------------- |
| 1   | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.29/8.11              | 19.05   | 0       | 8           | reference:intent_engine   |
| 2   | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine | yes         | reproduced |                                   | 9.98/3.90              | 4.96    | 0       | 8           | reference:intent_engine   |
| 3   | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine | yes         | reproduced |                                   | 1.27/0.44              | 0.68    | 0       | 8           | reference:intent_engine   |
| 4   | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 0.58/0.76              | 1.62    | 0       | 8           | reference:intent_engine   |
| 5   | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 0.73/0.45              | 0.87    | 0       | 8           | reference:intent_engine   |
| 6   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine | yes         | reproduced |                                   | 4.80/38.63             | 38.89   | 0       | 8           | reference:intent_engine   |
| 7   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine | yes         | reproduced |                                   | 5.01/3.47              | 3.91    | 0       | 8           | reference:intent_engine   |
| 8   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine | yes         | reproduced |                                   | 5.21/4.07              | 4.55    | 0       | 8           | reference:intent_engine   |
| 9   | 763e4cec | spin/plo6/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 18.69/38.80            | 39.53   | 60      | 8           | reference:intent_engine   |
| 10  | 763e4cec | cash/plo4/preflop/6p       | intent_engine/intent_engine | yes         | reproduced |                                   | 0.87/0.47              | 0.71    | 0       | 8           | reference:intent_engine   |
| 11  | 763e4cec | mtt/plo5/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.01/27.41             | 27.73   | 0       | 8           | reference:intent_engine   |
| 12  | 763e4cec | mtt/plo5/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 0.63/0.77              | 1.09    | 0       | 8           | reference:intent_engine   |
| 13  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine | yes         | reproduced |                                   | 20.77/12.42            | 12.66   | 220     | 8           | reference:intent_engine   |
| 14  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 13.90/12.80            | 13.25   | 220     | 8           | reference:intent_engine   |
| 15  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 29.45/12.90            | 13.17   | 220     | 8           | reference:intent_engine   |
| 16  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.11/0.34              | 1.04    | 0       | 8           | reference:intent_engine   |
| 17  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine | yes         | reproduced |                                   | 17.44/8.84             | 9.13    | 220     | 8           | reference:intent_engine   |
| 18  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 20.88/9.72             | 10.19   | 170     | 8           | reference:intent_engine   |
| 19  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 17.90/10.30            | 10.55   | 320     | 8           | reference:intent_engine   |
| 20  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 24.15/11.96            | 12.24   | 192     | 8           | reference:intent_engine   |
| 21  | 763e4cec | cash/short_deck/preflop/2p | intent_engine/intent_engine | yes         | reproduced |                                   | 0.40/1.19              | 1.45    | 0       | 8           | reference:intent_engine   |
| 22  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 25.47/18.58            | 19.06   | 320     | 8           | reference:intent_engine   |
| 23  | 763e4cec | spin/nlh/preflop/2p        | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 15.54/n/a              | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 24  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 10.60/n/a              | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 25  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 18.24/14.00            | 17.17   | 220     | 8           | reference:intent_engine   |
| 26  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine | yes         | reproduced |                                   | 11.74/1.69             | 2.01    | 0       | 8           | reference:intent_engine   |
| 27  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.31/0.33              | 0.64    | 0       | 8           | reference:intent_engine   |
| 28  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine | yes         | reproduced |                                   | 16.77/10.76            | 10.97   | 220     | 8           | reference:intent_engine   |
| 29  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine | yes         | reproduced |                                   | 20.12/7.15             | 7.38    | 132     | 8           | reference:intent_engine   |
| 30  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 38.52/16.09            | 16.32   | 320     | 8           | reference:intent_engine   |
| 31  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 34.76/18.86            | 19.30   | 320     | 8           | reference:intent_engine   |
| 32  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 30.23/11.09            | 11.62   | 320     | 8           | reference:intent_engine   |
| 33  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 27.39/8.49             | 8.73    | 170     | 8           | reference:intent_engine   |
| 34  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 16.51/6.38             | 6.75    | 320     | 8           | reference:intent_engine   |
| 35  | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine | yes         | reproduced |                                   | 24.61/1.90             | 2.06    | 0       | 8           | reference:intent_engine   |
| 36  | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine | yes         | reproduced |                                   | 0.94/0.18              | 0.33    | 0       | 8           | reference_legality        |
| 37  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 161.93/17.00           | 17.19   | 170     | 8           | reference:intent_engine   |
| 38  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 31.37/7.04             | 7.25    | 320     | 8           | reference:intent_engine   |
| 39  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine | yes         | reproduced |                                   | 22.91/7.67             | 8.08    | 320     | 8           | reference:intent_engine   |
| 40  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 25.31/8.50             | 8.69    | 170     | 8           | reference:intent_engine   |
| 41  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.17/2.53              | 2.77    | 0       | 8           | reference:intent_engine   |
| 42  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 17.12/6.12             | 6.36    | 220     | 8           | reference:intent_engine   |
| 43  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 5.10/1.56              | 1.83    | 0       | 8           | reference:intent_engine   |
| 44  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.06/0.29              | 0.56    | 0       | 8           | reference:intent_engine   |
| 45  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine | yes         | reproduced |                                   | 26.77/9.20             | 9.74    | 220     | 8           | reference:intent_engine   |
| 46  | 763e4cec | mtt/plo4/preflop/2p        | intent_engine/intent_engine | yes         | reproduced |                                   | 0.86/0.28              | 0.46    | 0       | 8           | reference:intent_engine   |
| 47  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 14.72/5.66             | 5.86    | 102     | 8           | reference:intent_engine   |
| 48  | 763e4cec | mtt/nlh/preflop/8p         | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 1.18/n/a               | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 49  | 763e4cec | cash/plo5/preflop/4p       | intent_engine/intent_engine | yes         | reproduced |                                   | 4.88/3.62              | 3.77    | 0       | 8           | reference:intent_engine   |
| 50  | 763e4cec | cash/plo5/preflop/4p       | intent_engine/intent_engine | yes         | reproduced |                                   | 5.27/3.14              | 3.28    | 0       | 8           | reference:intent_engine   |
| 51  | 763e4cec | spin/plo4/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 21.59/8.06             | 8.56    | 220     | 8           | reference:intent_engine   |
| 52  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 56.15/17.03            | 17.24   | 170     | 8           | reference:intent_engine   |
| 53  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.21/2.86              | 3.04    | 0       | 8           | reference:intent_engine   |
| 54  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine | yes         | reproduced |                                   | 6.67/2.82              | 2.99    | 0       | 8           | reference:intent_engine   |
| 55  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 68.14/29.19            | 29.50   | 320     | 8           | reference:intent_engine   |
| 56  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 39.41/19.79            | 20.05   | 320     | 8           | reference:intent_engine   |
| 57  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 27.95/9.61             | 9.84    | 170     | 8           | reference:intent_engine   |
| 58  | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 22.59/n/a              | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 59  | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 28.26/n/a              | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 60  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 12.91/n/a              | n/a     | n/a     | n/a         | reference_legality        |
| 61  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 5.39/1.88              | 2.17    | 0       | 8           | reference:intent_engine   |
| 62  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 5.19/1.13              | 1.41    | 0       | 8           | reference:intent_engine   |
| 63  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.59/0.26              | 0.55    | 0       | 8           | reference:intent_engine   |
| 64  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine | yes         | reproduced |                                   | 0.79/0.17              | 0.31    | 0       | 8           | reference:intent_engine   |
| 65  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 45.62/17.01            | 17.26   | 320     | 8           | reference:intent_engine   |
| 66  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 61.71/20.86            | 21.11   | 320     | 8           | reference:intent_engine   |
| 67  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine | yes         | reproduced |                                   | 35.96/10.36            | 10.62   | 320     | 8           | reference:intent_engine   |
| 68  | 763e4cec | spin/plo4/preflop/2p       | intent_engine/intent_engine | yes         | reproduced |                                   | 30.96/8.64             | 8.85    | 220     | 8           | reference:intent_engine   |
| 69  | 763e4cec | mtt/nlh/preflop/9p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 0.84/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 70  | 763e4cec | mtt/nlh/preflop/9p         | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 1.54/n/a               | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 71  | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 0.93/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 72  | 763e4cec | mtt/nlh/preflop/5p         | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 0.80/n/a               | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 73  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine | yes         | reproduced |                                   | 5.42/2.27              | 2.53    | 0       | 8           | reference:intent_engine   |
| 74  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.39/0.32              | 0.59    | 0       | 8           | reference:intent_engine   |
| 75  | 763e4cec | cash/nlh/preflop/4p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.85/1.80              | 1.93    | 0       | 8           | reference:intent_engine   |
| 76  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 29.25/9.35             | 9.75    | 102     | 8           | reference:intent_engine   |
| 77  | 763e4cec | mtt/nlh/preflop/3p         | intent_engine/intent_engine | yes         | reproduced |                                   | 4.29/1.49              | 1.72    | 0       | 8           | reference:intent_engine   |
| 78  | 763e4cec | mtt/nlh/preflop/3p         | intent_engine/intent_engine | yes         | reproduced |                                   | 2.71/0.21              | 0.49    | 0       | 8           | reference:intent_engine   |
| 79  | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 4.80/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 80  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 7.84/2.35              | 2.59    | 0       | 8           | reference:intent_engine   |
| 81  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.57/1.00              | 1.24    | 0       | 8           | reference:intent_engine   |
| 82  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.11/0.29              | 0.52    | 0       | 8           | reference:intent_engine   |
| 83  | 763e4cec | mtt/nlh/preflop/4p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 7.95/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 84  | 763e4cec | mtt/nlh/preflop/4p         | intent_engine/intent_engine | yes         | reproduced |                                   | 0.69/0.19              | 0.41    | 0       | 8           | reference:intent_engine   |
| 85  | 763e4cec | mtt/nlh/preflop/4p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.73/0.18              | 0.38    | 0       | 8           | reference:intent_engine   |
| 86  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 28.46/5.30             | 5.49    | 192     | 8           | reference:intent_engine   |
| 87  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.82/1.22              | 1.47    | 0       | 8           | reference:intent_engine   |
| 88  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine | yes         | reproduced |                                   | 4.95/2.46              | 2.61    | 0       | 8           | reference:intent_engine   |
| 89  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine | yes         | reproduced |                                   | 5.26/2.04              | 2.38    | 0       | 8           | reference:intent_engine   |
| 90  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.40/1.11              | 1.36    | 0       | 8           | reference:intent_engine   |
| 91  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.85/1.24              | 1.46    | 0       | 8           | reference:intent_engine   |
| 92  | 763e4cec | spin/nlh/preflop/2p        | intent_engine/intent_engine | yes         | reproduced |                                   | 22.23/6.51             | 6.97    | 320     | 8           | reference:intent_engine   |
| 93  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 2.75/1.01              | 1.23    | 0       | 8           | reference:intent_engine   |
| 94  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 0.94/0.19              | 0.40    | 0       | 8           | reference:intent_engine   |
| 95  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 47.79/14.09            | 14.28   | 320     | 8           | reference:intent_engine   |
| 96  | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine | yes         | reproduced |                                   | 2.90/1.10              | 1.57    | 0       | 8           | reference:intent_engine   |
| 97  | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/-             | n/a         | refused    | replay_unsupported:DECIDE_DEEP    | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 98  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/-             | n/a         | refused    | replay_unsupported:DECIDE_DEEP    | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 99  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 15.91/n/a              | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 100 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine | yes         | reproduced |                                   | 3.28/11.64             | 11.91   | 0       | 8           | reference:intent_engine   |
| 101 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine | yes         | reproduced |                                   | 3.41/4.33              | 4.48    | 0       | 8           | reference:intent_engine   |
| 102 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine | yes         | reproduced |                                   | 3.33/4.35              | 4.48    | 0       | 8           | reference:intent_engine   |
| 103 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 15.30/6.54             | 6.76    | 320     | 8           | reference:intent_engine   |
| 104 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/-             | n/a         | refused    | replay_unsupported:DECIDE_DEEP    | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 105 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 11.31/4.77             | 4.95    | 320     | 8           | reference:intent_engine   |
| 106 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 42.79/14.92            | 15.35   | 102     | 8           | reference:intent_engine   |
| 107 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.00/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 108 | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.03/0.31              | 1.00    | 0       | 8           | reference_legality        |
| 109 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 12.52/n/a              | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 110 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 17.36/11.11            | 11.40   | 170     | 8           | reference:intent_engine   |
| 111 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 10.00/n/a              | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 112 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 13.93/n/a              | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 113 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine | yes         | reproduced |                                   | 4.96/2.60              | 2.86    | 0       | 8           | reference:intent_engine   |
| 114 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine | yes         | reproduced |                                   | 4.95/2.21              | 2.48    | 0       | 8           | reference:intent_engine   |
| 115 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine | yes         | reproduced |                                   | 3.03/0.89              | 1.13    | 0       | 8           | reference:intent_engine   |
| 116 | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 4.86/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 117 | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 5.79/1.80              | 2.13    | 0       | 8           | reference:intent_engine   |
| 118 | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine | yes         | reproduced |                                   | 0.83/0.22              | 0.67    | 0       | 8           | reference:intent_engine   |
| 119 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 93.73/9.46             | 9.65    | 170     | 8           | reference:intent_engine   |
| 120 | 763e4cec | spin/nlh/preflop/2p        | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 24.20/n/a              | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 121 | 763e4cec | mtt/nlh/preflop/6p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.28/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 122 | 763e4cec | mtt/nlh/preflop/6p         | chart_bb_defend/-           | n/a         | refused    | reference_unavailable:chart_store | 0.75/n/a               | n/a     | n/a     | n/a         | reference:chart_bb_defend |
| 123 | 763e4cec | spin/plo5/preflop/3p       | variant_price/variant_price | yes         | reproduced |                                   | 21.63/7.61             | 7.81    | 198     | 8           | reference:variant_price   |
| 124 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 6.13/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 125 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.10/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 126 | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine | yes         | reproduced |                                   | 1.42/0.27              | 0.53    | 0       | 8           | reference:intent_engine   |
| 127 | 763e4cec | mtt/nlh/preflop/6p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.00/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 128 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 11.59/n/a              | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 129 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.00/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 130 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.13/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 131 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/-            | n/a         | refused    | reference_unavailable:chart_store | 5.90/n/a               | n/a     | n/a     | n/a         | reference:chart_open_jam  |
| 132 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine | yes         | reproduced |                                   | 34.72/13.81            | 14.02   | 320     | 8           | reference:intent_engine   |
| 133 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine | yes         | reproduced |                                   | 0.89/0.23              | 0.45    | 0       | 8           | reference:intent_engine   |
| 134 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 5.62/2.52              | 2.64    | 0       | 8           | reference:intent_engine   |
| 135 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 5.36/1.72              | 1.85    | 0       | 8           | reference:intent_engine   |
| 136 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine | yes         | reproduced |                                   | 0.77/0.24              | 0.37    | 0       | 8           | reference:intent_engine   |
| 137 | 763e4cec | spin/plo5/preflop/3p       | variant_price/variant_price | yes         | reproduced |                                   | 22.11/7.98             | 8.43    | 198     | 8           | reference:variant_price   |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
