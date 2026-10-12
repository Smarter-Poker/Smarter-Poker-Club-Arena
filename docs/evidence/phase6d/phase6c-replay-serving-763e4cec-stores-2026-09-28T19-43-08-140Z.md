# Phase 6C exact-input replay evidence (2026-09-28T19:43:08.140Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`. Evidence shape: aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position.

## Batch

- Command: `node scripts/phase6c-replay.mjs /Volumes/SmarterArchives/agent-evidence/p6-g8-correction-private/chains.ndjson --engine-sha 763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f --population /Volumes/SmarterArchives/agent-evidence/agent-trees/club-arena/p6-g8-correction/docs/evidence/phase6d/population-2026-09-28-763e4cec.json --out /Volumes/SmarterArchives/agent-evidence/p6-g8-correction-private/out763 --label serving-763e4cec-stores --store-snapshot /Volumes/SmarterArchives/agent-evidence/p6-g8-correction-private/snap/phase6c-store-chart-store-2c8a2d9f448e.json --store-snapshot /Volumes/SmarterArchives/agent-evidence/p6-g8-correction-private/snap/phase6c-store-solver-store-postflop-dff78313b437.json --negative-controls 3 --note 'correction 2026-09-28: stores loaded offline by journaled identity (chart 2c8a2d9f448e, postflop dff78313b437), snapshot rows exported 2026-09-28T19:38Z inside club-arena-engine; replay code is the serving release 763e4cec itself'`
- Batch rule: every decision admitted by the Phase 6D population population-2026-09-28-763e4cec.json (sha256 183852d99bc902576a60e8411b97e9b734aaa6583d1f318271f8de3bac9c59b2), in its chain order; 0 of them not found in the source
- Source: ndjson copy (137 records)
- Decisions from 2026-09-28T14:12:00.018Z to 2026-09-28T14:12:30.659Z
- Serving engine SHA (declared): `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
- Replay engine SHA (code that ran): `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
- Releases recorded on the replayed rows: `763e4cec8cdc21b61957e0a16dd6b4278f0a7f4f`
- Rows for the serving engine in this batch: 137
- Chart store at replay: 240 entries, digest `2c8a2d9f448e5dd22f4433faeb40f70ac6a111d6c7e7bacae89e4fbf106a5dbf`, revision 2026-07-19T15:11:48.555537+00:00
- Postflop store at replay: 7747 entries, digest `dff78313b437357d3657fe256fc3b3b82cd4740afffe9125e530dfcc79f57c1d`, revision 2026-09-03T18:18:13.594197+00:00
- Snapshot chart_store: fetched 2026-09-28T19:38:44.394Z to 2026-09-28T19:38:45.131Z from memory_charts_gold through the production loader, identity recomputed by the store module on load
- Snapshot solver_store:postflop: fetched 2026-09-28T19:38:46.923Z to 2026-09-28T19:39:26.019Z from gto_postflop_compact through the production loader, identity recomputed by the store module on load
- Release `763e4cec8cdc` committed 2026-09-28T05:51:14.000Z (no process running it started earlier)
- Decision-code files that differ, serving engine to replay code: none
- Decision-code files that differ, recorded release `763e4cec8cdc` to replay code: none
- Note: correction 2026-09-28: stores loaded offline by journaled identity (chart 2c8a2d9f448e, postflop dff78313b437), snapshot rows exported 2026-09-28T19:38Z inside club-arena-engine; replay code is the serving release 763e4cec itself

## Result

- Total: 137
- reproduced: 134 of 137
- diverged: 0 of 137
- refused: 3 of 137
- Independent qualification: agreed 134, disagreed 0, refused (reference unavailable) 3
- Receipt digest equal to the original: 134 of 134 replayed
- Authority owner identical between original and replay: 134 of 134 replayed

### Status and reason

| status:reason                          | count |
| -------------------------------------- | ----- |
| reproduced:clean                       | 134   |
| refused:replay_unsupported:DECIDE_DEEP | 3     |

### Solver-store references

| reference   | status and detail                    | decisions |
| ----------- | ------------------------------------ | --------- |
| chart_store | available: identity 240@2c8a2d9f448e | 28        |

### Negative controls (the batch records, changed)

| control                                    | expectation                                                                                                                                                                     | attempted | passed | outcomes                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ | ------------------------------------------------------------------------------------------- |
| substituted_action                         | a re-signed record whose recorded action was changed replays to the true action and is diverged with reason action                                                              | 3         | 3      | diverged:action 3                                                                           |
| substituted_rng                            | a re-signed record whose RNG stream was changed is refused as rng_stream_mismatch                                                                                               | 3         | 3      | refused:rng_stream_mismatch 3                                                               |
| stale_m_state                              | M evidence changed and re-signed under a valid decision key is disagreed by the independent m_state check and never reproduced                                                  | 3         | 3      | refused:runtime_rejected:Phase 6 tournament M state does not match the canonical snapshot 3 |
| chart_store:journaled_identity_substituted | a re-signed record whose journaled chart_store digest names a different store of the same size is refused as reference_unavailable:chart_store, even with the true store loaded | 3         | 3      | refused:reference_unavailable:chart_store 3                                                 |
| chart_store:journaled_identity_without_pin | a record that journaled its store identity reproduces against the loaded store by digest alone, with no pin                                                                     | 3         | 3      | reproduced:clean 3                                                                          |
| chart_store:same_count_tampered            | a store with the same 240 entries and one changed frequency (digest c202612f0c72) is refused as reference_unavailable:chart_store                                               | 3         | 3      | refused:reference_unavailable:chart_store 3                                                 |
| chart_store:restored                       | the untampered snapshot reloaded through the store module reproduces the same decisions again                                                                                   | 3         | 3      | reproduced:clean 3                                                                          |

### Latency and work

- Replay computeMs median 3.33, p95 18.35; original computeMs median 5.62, p95 45.62; replay wall (runtime round trip) median 3.58, p95 18.57
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

180 declared cells (5 formats x 9 registered variants x 4 streets): 14 observed, of which 12 fully replayed, 2 partly unreplayed and 0 unreplayed; 166 unobserved; 0 observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.

### Observed cells

| format | variant    | street  | observed | reproduced | diverged | refused | coverage          | outcomes (route or reason)                                                                                                        | table sizes                         |
| ------ | ---------- | ------- | -------- | ---------- | -------- | ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| cash   | nlh        | preflop | 12       | 12         | 0        | 0       | replayed          | reproduced:intent_engine 12                                                                                                       | 4 1; 5 3; 6 5; 9 3                  |
| cash   | plo4       | preflop | 4        | 4          | 0        | 0       | replayed          | reproduced:intent_engine 4                                                                                                        | 5 3; 6 1                            |
| cash   | plo5       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                                                                                        | 3 3; 4 2                            |
| cash   | short_deck | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                                        | 2 1                                 |
| cash   | pineapple  | preflop | 3        | 3          | 0        | 0       | replayed          | reproduced:intent_engine 3                                                                                                        | 4 3                                 |
| mtt    | nlh        | preflop | 55       | 53         | 0        | 2       | partly unreplayed | reproduced:intent_engine 36; reproduced:chart_open_jam 13; reproduced:chart_bb_defend 4; refused:replay_unsupported:DECIDE_DEEP 2 | 3 2; 4 3; 5 11; 6 9; 7 9; 8 15; 9 6 |
| mtt    | plo4       | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                                        | 2 1                                 |
| mtt    | plo5       | preflop | 2        | 2          | 0        | 0       | replayed          | reproduced:intent_engine 2                                                                                                        | 3 2                                 |
| spin   | nlh        | preflop | 15       | 14         | 0        | 1       | partly unreplayed | reproduced:intent_engine 9; reproduced:chart_bb_defend 3; reproduced:chart_open_jam 2; refused:replay_unsupported:DECIDE_DEEP 1   | 2 6; 3 9                            |
| spin   | plo4       | preflop | 6        | 6          | 0        | 0       | replayed          | reproduced:intent_engine 6                                                                                                        | 2 2; 3 4                            |
| spin   | plo5       | preflop | 13       | 13         | 0        | 0       | replayed          | reproduced:intent_engine 11; reproduced:variant_price 2                                                                           | 2 3; 3 10                           |
| spin   | plo6       | preflop | 1        | 1          | 0        | 0       | replayed          | reproduced:intent_engine 1                                                                                                        | 2 1                                 |
| hu_sng | nlh        | preflop | 14       | 14         | 0        | 0       | replayed          | reproduced:intent_engine 8; reproduced:chart_bb_defend 3; reproduced:chart_open_jam 3                                             | 2 14                                |
| hu_sng | plo4       | preflop | 5        | 5          | 0        | 0       | replayed          | reproduced:intent_engine 5                                                                                                        | 2 5                                 |

### Unreplayed decisions by cell and named reason

| format | variant | street  | reason                                 | decisions |
| ------ | ------- | ------- | -------------------------------------- | --------- |
| mtt    | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP | 2         |
| spin   | nlh     | preflop | refused:replay_unsupported:DECIDE_DEEP | 1         |

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

| #   | release  | format/variant/street/size | route orig/replay               | action same | status     | reason                         | compute orig/replay ms | wall ms | samples | node visits | authority                 |
| --- | -------- | -------------------------- | ------------------------------- | ----------- | ---------- | ------------------------------ | ---------------------- | ------- | ------- | ----------- | ------------------------- |
| 1   | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.29/7.76              | 17.93   | 0       | 8           | reference:intent_engine   |
| 2   | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 9.98/3.62              | 3.99    | 0       | 8           | reference:intent_engine   |
| 3   | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                                | 1.27/0.43              | 1.42    | 0       | 8           | reference:intent_engine   |
| 4   | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 0.58/0.68              | 1.47    | 0       | 8           | reference:intent_engine   |
| 5   | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 0.73/0.40              | 0.81    | 0       | 8           | reference:intent_engine   |
| 6   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.80/37.96             | 38.20   | 0       | 8           | reference:intent_engine   |
| 7   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.01/3.46              | 3.92    | 0       | 8           | reference:intent_engine   |
| 8   | 763e4cec | cash/plo4/preflop/5p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.21/3.97              | 4.17    | 0       | 8           | reference:intent_engine   |
| 9   | 763e4cec | spin/plo6/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 18.69/39.15            | 40.29   | 60      | 8           | reference:intent_engine   |
| 10  | 763e4cec | cash/plo4/preflop/6p       | intent_engine/intent_engine     | yes         | reproduced |                                | 0.87/0.48              | 0.70    | 0       | 8           | reference:intent_engine   |
| 11  | 763e4cec | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.01/27.78             | 28.08   | 0       | 8           | reference:intent_engine   |
| 12  | 763e4cec | mtt/plo5/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.63/0.74              | 1.02    | 0       | 8           | reference:intent_engine   |
| 13  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 20.77/12.70            | 12.94   | 220     | 8           | reference:intent_engine   |
| 14  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 13.90/12.71            | 12.98   | 220     | 8           | reference:intent_engine   |
| 15  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 29.45/14.34            | 15.00   | 220     | 8           | reference:intent_engine   |
| 16  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.11/0.35              | 1.08    | 0       | 8           | reference:intent_engine   |
| 17  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 17.44/8.88             | 9.25    | 220     | 8           | reference:intent_engine   |
| 18  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 20.88/9.78             | 10.10   | 170     | 8           | reference:intent_engine   |
| 19  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 17.90/10.51            | 10.75   | 320     | 8           | reference:intent_engine   |
| 20  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 24.15/11.05            | 11.36   | 192     | 8           | reference:intent_engine   |
| 21  | 763e4cec | cash/short_deck/preflop/2p | intent_engine/intent_engine     | yes         | reproduced |                                | 0.40/1.16              | 1.36    | 0       | 8           | reference:intent_engine   |
| 22  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 25.47/12.18            | 12.44   | 320     | 8           | reference:intent_engine   |
| 23  | 763e4cec | spin/nlh/preflop/2p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 15.54/8.16             | 8.41    | 320     | 8           | reference:chart_open_jam  |
| 24  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 10.60/4.38             | 4.59    | 320     | 8           | reference:chart_bb_defend |
| 25  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 18.24/13.22            | 13.58   | 220     | 8           | reference:intent_engine   |
| 26  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |                                | 11.74/1.56             | 2.24    | 0       | 8           | reference:intent_engine   |
| 27  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.31/0.27              | 0.52    | 0       | 8           | reference:intent_engine   |
| 28  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 16.77/10.61            | 10.80   | 220     | 8           | reference:intent_engine   |
| 29  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 20.12/7.66             | 7.90    | 132     | 8           | reference:intent_engine   |
| 30  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 38.52/16.19            | 16.46   | 320     | 8           | reference:intent_engine   |
| 31  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 34.76/18.23            | 18.47   | 320     | 8           | reference:intent_engine   |
| 32  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 30.23/11.35            | 11.92   | 320     | 8           | reference:intent_engine   |
| 33  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 27.39/8.79             | 9.02    | 170     | 8           | reference:intent_engine   |
| 34  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 16.51/6.23             | 6.76    | 320     | 8           | reference:intent_engine   |
| 35  | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                                | 24.61/1.98             | 2.13    | 0       | 8           | reference:intent_engine   |
| 36  | 763e4cec | cash/nlh/preflop/5p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.94/0.19              | 0.37    | 0       | 8           | reference_legality        |
| 37  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 161.93/16.40           | 16.59   | 170     | 8           | reference:intent_engine   |
| 38  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 31.37/7.06             | 7.27    | 320     | 8           | reference:intent_engine   |
| 39  | 763e4cec | hu_sng/nlh/preflop/2p      | intent_engine/intent_engine     | yes         | reproduced |                                | 22.91/7.64             | 8.34    | 320     | 8           | reference:intent_engine   |
| 40  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 25.31/8.78             | 8.98    | 170     | 8           | reference:intent_engine   |
| 41  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.17/2.46              | 2.63    | 0       | 8           | reference:intent_engine   |
| 42  | 763e4cec | spin/plo4/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 17.12/5.84             | 6.10    | 220     | 8           | reference:intent_engine   |
| 43  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.10/1.53              | 1.80    | 0       | 8           | reference:intent_engine   |
| 44  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.06/0.25              | 0.51    | 0       | 8           | reference:intent_engine   |
| 45  | 763e4cec | hu_sng/plo4/preflop/2p     | intent_engine/intent_engine     | yes         | reproduced |                                | 26.77/9.46             | 10.03   | 220     | 8           | reference:intent_engine   |
| 46  | 763e4cec | mtt/plo4/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.86/0.32              | 0.52    | 0       | 8           | reference:intent_engine   |
| 47  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 14.72/6.15             | 6.36    | 102     | 8           | reference:intent_engine   |
| 48  | 763e4cec | mtt/nlh/preflop/8p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 1.18/0.25              | 0.52    | 0       | 8           | reference:chart_bb_defend |
| 49  | 763e4cec | cash/plo5/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |                                | 4.88/3.45              | 3.58    | 0       | 8           | reference:intent_engine   |
| 50  | 763e4cec | cash/plo5/preflop/4p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.27/3.33              | 3.58    | 0       | 8           | reference:intent_engine   |
| 51  | 763e4cec | spin/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 21.59/8.43             | 8.62    | 220     | 8           | reference:intent_engine   |
| 52  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 56.15/17.22            | 17.42   | 170     | 8           | reference:intent_engine   |
| 53  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.21/2.67              | 2.83    | 0       | 8           | reference:intent_engine   |
| 54  | 763e4cec | cash/nlh/preflop/9p        | intent_engine/intent_engine     | yes         | reproduced |                                | 6.67/2.66              | 3.46    | 0       | 8           | reference:intent_engine   |
| 55  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 68.14/29.74            | 30.07   | 320     | 8           | reference:intent_engine   |
| 56  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 39.41/21.04            | 21.30   | 320     | 8           | reference:intent_engine   |
| 57  | 763e4cec | spin/plo5/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 27.95/9.73             | 9.96    | 170     | 8           | reference:intent_engine   |
| 58  | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 22.59/9.23             | 9.46    | 320     | 8           | reference:chart_bb_defend |
| 59  | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 28.26/5.99             | 6.22    | 320     | 8           | reference:chart_open_jam  |
| 60  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 12.91/2.85             | 3.03    | 320     | 8           | reference_legality        |
| 61  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.39/1.80              | 2.06    | 0       | 8           | reference:intent_engine   |
| 62  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.19/0.98              | 1.20    | 0       | 8           | reference:intent_engine   |
| 63  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.59/0.27              | 0.64    | 0       | 8           | reference:intent_engine   |
| 64  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 0.79/0.17              | 0.31    | 0       | 8           | reference:intent_engine   |
| 65  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 45.62/18.35            | 18.57   | 320     | 8           | reference:intent_engine   |
| 66  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 61.71/22.72            | 22.98   | 320     | 8           | reference:intent_engine   |
| 67  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/intent_engine     | yes         | reproduced |                                | 35.96/11.75            | 12.00   | 320     | 8           | reference:intent_engine   |
| 68  | 763e4cec | spin/plo4/preflop/2p       | intent_engine/intent_engine     | yes         | reproduced |                                | 30.96/9.81             | 10.47   | 220     | 8           | reference:intent_engine   |
| 69  | 763e4cec | mtt/nlh/preflop/9p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.84/0.28              | 0.55    | 0       | 8           | reference:chart_open_jam  |
| 70  | 763e4cec | mtt/nlh/preflop/9p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 1.54/0.25              | 0.50    | 0       | 8           | reference:chart_bb_defend |
| 71  | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 0.93/0.23              | 0.43    | 0       | 8           | reference:chart_open_jam  |
| 72  | 763e4cec | mtt/nlh/preflop/5p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.80/0.24              | 0.44    | 0       | 8           | reference:chart_bb_defend |
| 73  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.42/2.03              | 2.67    | 0       | 8           | reference:intent_engine   |
| 74  | 763e4cec | mtt/nlh/preflop/9p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.39/0.25              | 0.48    | 0       | 8           | reference:intent_engine   |
| 75  | 763e4cec | cash/nlh/preflop/4p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.85/1.74              | 1.86    | 0       | 8           | reference:intent_engine   |
| 76  | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 29.25/10.22            | 10.54   | 102     | 8           | reference:intent_engine   |
| 77  | 763e4cec | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.29/1.57              | 1.82    | 0       | 8           | reference:intent_engine   |
| 78  | 763e4cec | mtt/nlh/preflop/3p         | intent_engine/intent_engine     | yes         | reproduced |                                | 2.71/0.20              | 0.42    | 0       | 8           | reference:intent_engine   |
| 79  | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 4.80/2.41              | 2.64    | 0       | 8           | reference:chart_open_jam  |
| 80  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 7.84/1.86              | 2.49    | 0       | 8           | reference:intent_engine   |
| 81  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.57/0.98              | 1.19    | 0       | 8           | reference:intent_engine   |
| 82  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.11/0.19              | 0.41    | 0       | 8           | reference:intent_engine   |
| 83  | 763e4cec | mtt/nlh/preflop/4p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 7.95/1.87              | 2.08    | 0       | 8           | reference:chart_open_jam  |
| 84  | 763e4cec | mtt/nlh/preflop/4p         | intent_engine/intent_engine     | yes         | reproduced |                                | 0.69/0.24              | 1.06    | 0       | 8           | reference:intent_engine   |
| 85  | 763e4cec | mtt/nlh/preflop/4p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.73/0.20              | 0.53    | 0       | 8           | reference:intent_engine   |
| 86  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 28.46/4.25             | 4.45    | 192     | 8           | reference:intent_engine   |
| 87  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.82/1.03              | 1.25    | 0       | 8           | reference:intent_engine   |
| 88  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 4.95/2.29              | 2.87    | 0       | 8           | reference:intent_engine   |
| 89  | 763e4cec | cash/nlh/preflop/6p        | intent_engine/intent_engine     | yes         | reproduced |                                | 5.26/1.96              | 2.09    | 0       | 8           | reference:intent_engine   |
| 90  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.40/1.19              | 1.45    | 0       | 8           | reference:intent_engine   |
| 91  | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.85/1.17              | 1.45    | 0       | 8           | reference:intent_engine   |
| 92  | 763e4cec | spin/nlh/preflop/2p        | intent_engine/intent_engine     | yes         | reproduced |                                | 22.23/6.31             | 6.52    | 320     | 8           | reference:intent_engine   |
| 93  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 2.75/1.09              | 1.33    | 0       | 8           | reference:intent_engine   |
| 94  | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 0.94/0.21              | 0.44    | 0       | 8           | reference:intent_engine   |
| 95  | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 47.79/14.63            | 14.82   | 320     | 8           | reference:intent_engine   |
| 96  | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 2.90/1.08              | 1.33    | 0       | 8           | reference:intent_engine   |
| 97  | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/-                 | n/a         | refused    | replay_unsupported:DECIDE_DEEP | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 98  | 763e4cec | mtt/nlh/preflop/8p         | intent_engine/-                 | n/a         | refused    | replay_unsupported:DECIDE_DEEP | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 99  | 763e4cec | spin/nlh/preflop/2p        | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 15.91/6.84             | 7.03    | 320     | 8           | reference:chart_bb_defend |
| 100 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |                                | 3.28/10.96             | 11.20   | 0       | 8           | reference:intent_engine   |
| 101 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |                                | 3.41/4.36              | 4.51    | 0       | 8           | reference:intent_engine   |
| 102 | 763e4cec | cash/pineapple/preflop/4p  | intent_engine/intent_engine     | yes         | reproduced |                                | 3.33/4.41              | 4.91    | 0       | 8           | reference:intent_engine   |
| 103 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 15.30/6.61             | 6.83    | 320     | 8           | reference:intent_engine   |
| 104 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/-                 | n/a         | refused    | replay_unsupported:DECIDE_DEEP | n/a/n/a                | n/a     | n/a     | n/a         | reference:intent_engine   |
| 105 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 11.31/5.07             | 5.27    | 320     | 8           | reference:intent_engine   |
| 106 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 42.79/14.97            | 15.19   | 102     | 8           | reference:intent_engine   |
| 107 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.00/3.54              | 3.81    | 0       | 8           | reference:chart_open_jam  |
| 108 | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.03/0.27              | 0.53    | 0       | 8           | reference_legality        |
| 109 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 12.52/7.93             | 8.15    | 192     | 8           | reference:chart_open_jam  |
| 110 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 17.36/9.80             | 12.04   | 170     | 8           | reference:intent_engine   |
| 111 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 10.00/2.49             | 2.74    | 192     | 8           | reference:chart_bb_defend |
| 112 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 13.93/4.20             | 4.91    | 320     | 8           | reference:chart_bb_defend |
| 113 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.96/2.61              | 3.38    | 0       | 8           | reference:intent_engine   |
| 114 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 4.95/2.12              | 2.34    | 0       | 8           | reference:intent_engine   |
| 115 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 3.03/0.98              | 1.29    | 0       | 8           | reference:intent_engine   |
| 116 | 763e4cec | mtt/nlh/preflop/5p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 4.86/2.01              | 2.56    | 0       | 8           | reference:chart_open_jam  |
| 117 | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 5.79/1.56              | 1.81    | 0       | 8           | reference:intent_engine   |
| 118 | 763e4cec | mtt/nlh/preflop/5p         | intent_engine/intent_engine     | yes         | reproduced |                                | 0.83/0.20              | 0.44    | 0       | 8           | reference:intent_engine   |
| 119 | 763e4cec | spin/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 93.73/9.08             | 9.26    | 170     | 8           | reference:intent_engine   |
| 120 | 763e4cec | spin/nlh/preflop/2p        | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 24.20/4.45             | 5.09    | 320     | 8           | reference:chart_open_jam  |
| 121 | 763e4cec | mtt/nlh/preflop/6p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.28/2.29              | 2.87    | 0       | 8           | reference:chart_open_jam  |
| 122 | 763e4cec | mtt/nlh/preflop/6p         | chart_bb_defend/chart_bb_defend | yes         | reproduced |                                | 0.75/0.21              | 0.45    | 0       | 8           | reference:chart_bb_defend |
| 123 | 763e4cec | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 21.63/7.81             | 7.99    | 198     | 8           | reference:variant_price   |
| 124 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 6.13/2.39              | 2.61    | 0       | 8           | reference:chart_open_jam  |
| 125 | 763e4cec | mtt/nlh/preflop/7p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.10/2.02              | 2.26    | 0       | 8           | reference:chart_open_jam  |
| 126 | 763e4cec | mtt/nlh/preflop/7p         | intent_engine/intent_engine     | yes         | reproduced |                                | 1.42/0.20              | 0.75    | 0       | 8           | reference:intent_engine   |
| 127 | 763e4cec | mtt/nlh/preflop/6p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.00/1.85              | 2.05    | 0       | 8           | reference:chart_open_jam  |
| 128 | 763e4cec | hu_sng/nlh/preflop/2p      | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 11.59/5.32             | 5.50    | 320     | 8           | reference:chart_open_jam  |
| 129 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.00/3.46              | 3.72    | 0       | 8           | reference:chart_open_jam  |
| 130 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.13/2.80              | 3.04    | 0       | 8           | reference:chart_open_jam  |
| 131 | 763e4cec | mtt/nlh/preflop/8p         | chart_open_jam/chart_open_jam   | yes         | reproduced |                                | 5.90/3.02              | 3.28    | 0       | 8           | reference:chart_open_jam  |
| 132 | 763e4cec | spin/nlh/preflop/3p        | intent_engine/intent_engine     | yes         | reproduced |                                | 34.72/13.63            | 13.82   | 320     | 8           | reference:intent_engine   |
| 133 | 763e4cec | mtt/nlh/preflop/6p         | intent_engine/intent_engine     | yes         | reproduced |                                | 0.89/0.27              | 0.57    | 0       | 8           | reference:intent_engine   |
| 134 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.62/2.91              | 3.04    | 0       | 8           | reference:intent_engine   |
| 135 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 5.36/1.72              | 1.86    | 0       | 8           | reference:intent_engine   |
| 136 | 763e4cec | cash/plo5/preflop/3p       | intent_engine/intent_engine     | yes         | reproduced |                                | 0.77/0.25              | 0.38    | 0       | 8           | reference:intent_engine   |
| 137 | 763e4cec | spin/plo5/preflop/3p       | variant_price/variant_price     | yes         | reproduced |                                | 22.11/8.02             | 8.24    | 198     | 8           | reference:variant_price   |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
