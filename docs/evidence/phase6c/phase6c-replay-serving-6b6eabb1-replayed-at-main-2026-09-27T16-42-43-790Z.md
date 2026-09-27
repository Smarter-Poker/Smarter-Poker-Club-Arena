# Phase 6C exact-input replay evidence (2026-09-27T16:42:43.790Z)

Protocol: `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`.

## Batch

- Command: `node scripts/phase6c-replay.mjs /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/phase6c/journal-copy-6b6eabb1.ndjson --engine-sha 6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4 --limit 200 --since 2026-09-27T16:06:00Z --label serving-6b6eabb1-replayed-at-main --note 'same predeclared window and copy as the batch replayed at 6b6eabb1: 2026-09-27T16:06:00Z (inclusive) to 16:41:00Z (exclusive), 2967 decision records by release 6b6eabb1; this batch runs origin/main, which adds Phase 6B (#5417) decision-code changes after the serving release'`
- Batch rule: newest 200 journaled decision records at or after 2026-09-27T16:06:00Z, in journal order
- Source: ndjson copy /Volumes/SmarterArchives/agent-evidence/horse-phase6a-20260920/scratch/phase6c/journal-copy-6b6eabb1.ndjson (2967 records)
- Serving engine SHA (declared): `6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4`
- Replay engine SHA (code that ran): `0c6bda56d5f3e37cd04b58848ee59ca8a16385a0` (not the serving engine)
- Releases recorded on the replayed rows: `6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4`
- Rows for the serving engine in this batch: 200
- Solver stores at replay: charts 0, postflop 0, postflopV31 0
- Decision-code files that differ, serving engine to replay code: `server/src/engine/HorseLogic.ts`, `server/src/engine/HorsePhase6Attribution.ts`, `server/src/engine/HorsePreflop.ts`, `server/src/engine/HorseTournamentPreflop.ts`, `server/src/engine/horseDecision/client.ts`, `server/src/engine/horseDecision/workerRuntime.ts`
- Decision-code files that differ, recorded release `6b6eabb1b169` to replay code: `server/src/engine/HorseLogic.ts`, `server/src/engine/HorsePhase6Attribution.ts`, `server/src/engine/HorsePreflop.ts`, `server/src/engine/HorseTournamentPreflop.ts`, `server/src/engine/horseDecision/client.ts`, `server/src/engine/horseDecision/workerRuntime.ts`
- Note: same predeclared window and copy as the batch replayed at 6b6eabb1: 2026-09-27T16:06:00Z (inclusive) to 16:41:00Z (exclusive), 2967 decision records by release 6b6eabb1; this batch runs origin/main, which adds Phase 6B (#5417) decision-code changes after the serving release

## Result

- Total: 200
- reproduced: 159 of 200
- diverged: 0 of 200
- refused: 41 of 200
- Independent qualification: agreed 159, disagreed 0, refused (reference unavailable) 41
- Authority owner identical between original and replay: 159 of 159 replayed

### Status and reason

| status:reason                                       | count |
| --------------------------------------------------- | ----- |
| reproduced:clean                                    | 159   |
| refused:reference_unavailable:solver_store:postflop | 34    |
| refused:reference_unavailable:chart_store           | 4     |
| refused:replay_unsupported:DECIDE_DEEP              | 3     |

### Latency and work

- Replay computeMs median 2.02, p95 15.87; original computeMs median 5.49, p95 65.67; replay wall (runtime round trip) median 2.42, p95 16.27
- Equity samples per replay: median 0, max 450; equity calls median 0

### Authority (module that produced the accepted action, original decisions)

| module                    | count |
| ------------------------- | ----- |
| reference:intent_engine   | 121   |
| reference:postflop        | 72    |
| reference:chart_bb_defend | 3     |
| reference_legality        | 2     |
| reference:variant_price   | 1     |
| reference:chart_open_jam  | 1     |

### Population

| mode/variant/stage      | count |
| ----------------------- | ----- |
| tournament/nlh/preflop  | 57    |
| tournament/plo4/preflop | 57    |
| tournament/nlh/flop     | 18    |
| tournament/plo4/flop    | 14    |
| tournament/plo4/turn    | 11    |
| tournament/plo4/river   | 10    |
| tournament/nlh/turn     | 9     |
| tournament/plo5/preflop | 8     |
| tournament/nlh/river    | 6     |
| cash/nlh/preflop        | 4     |
| cash/nlh/flop           | 3     |
| tournament/plo6/river   | 1     |
| tournament/plo5/river   | 1     |
| tournament/plo6/preflop | 1     |

## Decisions

| decision     | release  | context                    | original  | replayed  | route orig/replay           | status     | reason                                      | compute orig/replay ms | wall ms | samples | authority                 |
| ------------ | -------- | -------------------------- | --------- | --------- | --------------------------- | ---------- | ------------------------------------------- | ---------------------- | ------- | ------- | ------------------------- |
| 217db557bd63 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 3.81/n/a               | n/a     | n/a     | reference:postflop        |
| a368f48eb470 | 6b6eabb1 | tournament/plo4/river/6p   | check     | check     | -/-                         | reproduced |                                             | 35.21/54.86            | 66.18   | 220     | reference:postflop        |
| 8a4639505275 | 6b6eabb1 | tournament/nlh/preflop/2p  | call 100  | call 100  | intent_engine/intent_engine | reproduced |                                             | 0.84/2.02              | 2.69    | 0       | reference:intent_engine   |
| 6fe0ddf029db | 6b6eabb1 | tournament/nlh/turn/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 40.84/n/a              | n/a     | n/a     | reference:postflop        |
| f19e98b59239 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 24.73/10.43            | 10.90   | 132     | reference:intent_engine   |
| 967ba52269df | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 1.69/0.68              | 1.20    | 0       | reference:intent_engine   |
| f7a9d6b5e25b | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 1.98/0.48              | 0.86    | 0       | reference:intent_engine   |
| 7b57c77abd70 | 6b6eabb1 | tournament/plo5/preflop/3p | raise 66  | raise 66  | intent_engine/intent_engine | reproduced |                                             | 3.39/28.49             | 28.84   | 0       | reference:intent_engine   |
| ab779abda86f | 6b6eabb1 | tournament/nlh/turn/2p     | bet 20    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 5.90/n/a               | n/a     | n/a     | reference:postflop        |
| 6921b83dcde8 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.79/0.50              | 0.90    | 0       | reference:intent_engine   |
| df4eef3bf5fd | 6b6eabb1 | tournament/plo4/river/2p   | check     | check     | -/-                         | reproduced |                                             | 29.37/4.17             | 4.59    | 220     | reference:postflop        |
| cf4d61c872f8 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 3.92/0.48              | 0.99    | 0       | reference:intent_engine   |
| d17228dc69dc | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 200 | raise 200 | intent_engine/intent_engine | reproduced |                                             | 0.49/0.44              | 0.90    | 0       | reference:intent_engine   |
| 0d41c0e9f0f9 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.65/0.39              | 0.82    | 0       | reference:intent_engine   |
| 42eaf5043b7e | 6b6eabb1 | tournament/plo4/turn/2p    | fold      | fold      | -/-                         | reproduced |                                             | 16.83/8.37             | 8.67    | 220     | reference:postflop        |
| b9d63f3397e6 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 90  | raise 90  | intent_engine/intent_engine | reproduced |                                             | 37.62/8.40             | 9.21    | 220     | reference:intent_engine   |
| 43040ae866c8 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 1.25/0.31              | 0.72    | 0       | reference:intent_engine   |
| 2791df47c700 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 50  | raise 50  | intent_engine/intent_engine | reproduced |                                             | 0.47/0.28              | 0.64    | 0       | reference:intent_engine   |
| 16c62908dc76 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.73/0.39              | 0.62    | 0       | reference:intent_engine   |
| 65e20f3905c8 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.87/0.37              | 0.69    | 0       | reference:intent_engine   |
| 593f3cf9e229 | 6b6eabb1 | tournament/nlh/preflop/4p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 7.34/3.30              | 3.62    | 0       | reference:intent_engine   |
| 6822e7043b2f | 6b6eabb1 | tournament/plo4/preflop/6p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 5.05/2.85              | 3.44    | 0       | reference:intent_engine   |
| 622df2b14b96 | 6b6eabb1 | tournament/nlh/preflop/3p  | call 32   | call 32   | intent_engine/intent_engine | reproduced |                                             | 0.64/0.34              | 0.75    | 0       | reference:intent_engine   |
| 8b115c292516 | 6b6eabb1 | tournament/plo4/preflop/3p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.81/0.36              | 0.63    | 0       | reference:intent_engine   |
| bf7f86aba076 | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.81/2.90              | 3.14    | 0       | reference:intent_engine   |
| b247ef8fcab2 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 24.23/8.43             | 8.79    | 220     | reference:intent_engine   |
| 419adac09f0d | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 26.04/7.05             | 7.78    | 220     | reference:intent_engine   |
| 69d5c4aa18ba | 6b6eabb1 | tournament/nlh/preflop/2p  | call 2171 | n/a       | chart_bb_defend/-           | refused    | reference_unavailable:chart_store           | 23.33/n/a              | n/a     | n/a     | reference:chart_bb_defend |
| 61015cd5f295 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 4.81/0.36              | 0.72    | 0       | reference:intent_engine   |
| df0ef08bd511 | 6b6eabb1 | tournament/plo4/turn/2p    | check     | check     | -/-                         | reproduced |                                             | 12.35/5.18             | 5.46    | 220     | reference:postflop        |
| b03dcfa400d3 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 29.12/n/a              | n/a     | n/a     | reference:postflop        |
| 660c3896e4bf | 6b6eabb1 | cash/nlh/flop/5p           | bet 4     | bet 4     | -/-                         | reproduced |                                             | 6.93/5.54              | 6.06    | 450     | reference:postflop        |
| ca9512c93aac | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 29.27/10.38            | 11.13   | 320     | reference:intent_engine   |
| d70d002437d0 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.69/0.40              | 0.75    | 0       | reference:intent_engine   |
| 5fb9a3896f20 | 6b6eabb1 | tournament/plo4/flop/2p    | call 52   | call 52   | -/-                         | reproduced |                                             | 14.70/4.52             | 4.79    | 220     | reference:postflop        |
| c5e55185da04 | 6b6eabb1 | tournament/plo4/turn/2p    | check     | check     | -/-                         | reproduced |                                             | 29.70/4.15             | 4.66    | 220     | reference:postflop        |
| 9993a90eba16 | 6b6eabb1 | tournament/plo4/preflop/7p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 72.84/19.52            | 20.06   | 187     | reference:intent_engine   |
| 8d75339cd581 | 6b6eabb1 | tournament/plo4/turn/2p    | call 222  | call 222  | -/-                         | reproduced |                                             | 14.45/5.67             | 6.45    | 220     | reference:postflop        |
| 84e39db5554f | 6b6eabb1 | tournament/nlh/preflop/9p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 5.26/4.46              | 4.94    | 0       | reference:intent_engine   |
| d9196062d971 | 6b6eabb1 | tournament/plo4/flop/2p    | check     | check     | -/-                         | reproduced |                                             | 23.89/4.02             | 4.48    | 220     | reference:postflop        |
| b4059b60a186 | 6b6eabb1 | tournament/plo4/preflop/2p | call 360  | call 360  | variant_price/variant_price | reproduced |                                             | 9.69/2.70              | 3.09    | 176     | reference:variant_price   |
| f24687ab845a | 6b6eabb1 | tournament/nlh/preflop/9p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 5.19/4.43              | 4.77    | 0       | reference:intent_engine   |
| ead2b0be964e | 6b6eabb1 | tournament/plo4/flop/2p    | bet 52    | bet 52    | -/-                         | reproduced |                                             | 19.75/3.67             | 4.29    | 220     | reference:postflop        |
| 26d041163f72 | 6b6eabb1 | tournament/plo4/preflop/3p | raise 215 | raise 215 | intent_engine/intent_engine | reproduced |                                             | 5.73/2.72              | 3.08    | 0       | reference:intent_engine   |
| fb86389d6633 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 4.61/n/a               | n/a     | n/a     | reference:postflop        |
| c0d87e5f136c | 6b6eabb1 | tournament/nlh/river/2p    | bet 364   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 2.45/n/a               | n/a     | n/a     | reference:postflop        |
| 4b9be7912434 | 6b6eabb1 | tournament/plo4/turn/2p    | bet 222   | bet 222   | -/-                         | reproduced |                                             | 12.98/3.44             | 3.68    | 220     | reference:postflop        |
| 5180182575e5 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 200 | raise 200 | intent_engine/intent_engine | reproduced |                                             | 7.67/0.31              | 0.72    | 0       | reference:intent_engine   |
| 8caf395c348c | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 24.80/8.98             | 9.26    | 220     | reference:intent_engine   |
| 11f7390ee6b9 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.46/0.28              | 0.97    | 0       | reference:intent_engine   |
| ec6f63e47f06 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.68/0.25              | 0.61    | 0       | reference:intent_engine   |
| 2607d00962c7 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 36.11/10.53            | 10.87   | 220     | reference:intent_engine   |
| a092783b7966 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 129 | raise 129 | intent_engine/intent_engine | reproduced |                                             | 0.66/0.31              | 0.78    | 0       | reference:intent_engine   |
| 99e277aa5760 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 19.13/2.45             | 2.81    | 0       | reference:intent_engine   |
| bc2146192132 | 6b6eabb1 | tournament/plo4/preflop/3p | raise 65  | raise 65  | intent_engine/intent_engine | reproduced |                                             | 3.96/2.55              | 3.07    | 0       | reference:intent_engine   |
| 1e6263f5f351 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 87.18/14.86            | 15.18   | 220     | reference:intent_engine   |
| a8bbb90c0946 | 6b6eabb1 | tournament/plo4/preflop/2p | call 10   | call 10   | intent_engine/intent_engine | reproduced |                                             | 48.33/9.48             | 10.55   | 220     | reference:intent_engine   |
| 52838ce9804b | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.72/0.28              | 0.51    | 0       | reference:intent_engine   |
| e2a6ea5e7146 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.68/0.17              | 0.36    | 0       | reference:intent_engine   |
| 1b32218e5923 | 6b6eabb1 | tournament/plo4/river/2p   | all_in    | all_in    | -/-                         | reproduced |                                             | 8.24/1.51              | 1.88    | 220     | reference:postflop        |
| e7ad7142f620 | 6b6eabb1 | tournament/nlh/flop/2p     | fold      | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 9.35/n/a               | n/a     | n/a     | reference:postflop        |
| 30ab1ef0c8ef | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 6.20/2.66              | 3.02    | 0       | reference:intent_engine   |
| 43a7d95a2864 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 3.64/0.24              | 0.67    | 0       | reference:intent_engine   |
| bd81e403959a | 6b6eabb1 | cash/nlh/flop/5p           | check     | check     | -/-                         | reproduced |                                             | 6.73/3.06              | 3.38    | 450     | reference:postflop        |
| e2ec43125960 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.92/2.45              | 2.71    | 0       | reference:intent_engine   |
| fb9786e89d4f | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 1.20/0.30              | 0.93    | 0       | reference:intent_engine   |
| 35063a60e087 | 6b6eabb1 | tournament/plo5/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 25.13/8.84             | 9.11    | 170     | reference:intent_engine   |
| 4bdeb3c14250 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.64/0.34              | 0.73    | 0       | reference:intent_engine   |
| 2a9e175e4c40 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.99/0.23              | 0.46    | 0       | reference:intent_engine   |
| ed237b5cedc3 | 6b6eabb1 | tournament/nlh/river/3p    | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 2.21/n/a               | n/a     | n/a     | reference:postflop        |
| dfc1795c6ad8 | 6b6eabb1 | tournament/nlh/river/2p    | bet 115   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 3.91/n/a               | n/a     | n/a     | reference:postflop        |
| 6a15e8e10c65 | 6b6eabb1 | tournament/nlh/flop/3p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 3.38/n/a               | n/a     | n/a     | reference:postflop        |
| 33904889b199 | 6b6eabb1 | tournament/plo4/flop/2p    | fold      | fold      | -/-                         | reproduced |                                             | 15.79/5.01             | 5.29    | 220     | reference:postflop        |
| c178cb960dec | 6b6eabb1 | tournament/plo5/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 7.15/2.47              | 2.86    | 0       | reference:intent_engine   |
| 787bb10ed329 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 36.72/5.54             | 6.24    | 320     | reference:intent_engine   |
| 24c14fb40c7c | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 33.81/6.06             | 6.48    | 320     | reference:intent_engine   |
| 0c83f323e20c | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | n/a       | intent_engine/-             | refused    | reference_unavailable:chart_store           | 44.03/n/a              | n/a     | n/a     | reference:intent_engine   |
| 0ad040b005d7 | 6b6eabb1 | tournament/plo4/river/2p   | bet 422   | bet 422   | -/-                         | reproduced |                                             | 4.03/1.39              | 1.64    | 220     | reference:postflop        |
| 09591522ad03 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.62/0.26              | 0.69    | 0       | reference:intent_engine   |
| 8b22e1c65809 | 6b6eabb1 | tournament/plo4/preflop/2p | check     | check     | intent_engine/intent_engine | reproduced |                                             | 0.81/0.32              | 0.62    | 0       | reference:intent_engine   |
| b1f2d8cade7a | 6b6eabb1 | tournament/nlh/preflop/3p  | raise 61  | raise 61  | intent_engine/intent_engine | reproduced |                                             | 0.61/0.23              | 0.53    | 0       | reference:intent_engine   |
| f62a89862934 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.58/2.01              | 2.26    | 0       | reference:intent_engine   |
| c2a3742fa2cf | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 46  | raise 46  | intent_engine/intent_engine | reproduced |                                             | 0.57/0.16              | 0.38    | 0       | reference:intent_engine   |
| 65f04a52931c | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.77/0.26              | 0.46    | 0       | reference:intent_engine   |
| 1ff05afd3b0a | 6b6eabb1 | tournament/nlh/flop/2p     | call 39   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 14.52/n/a              | n/a     | n/a     | reference:postflop        |
| de3ba02cd1f3 | 6b6eabb1 | tournament/nlh/preflop/9p  | call 143  | call 143  | intent_engine/intent_engine | reproduced |                                             | 5.12/2.90              | 3.18    | 0       | reference:intent_engine   |
| ebd401d338e2 | 6b6eabb1 | tournament/plo4/turn/2p    | fold      | fold      | -/-                         | reproduced |                                             | 17.14/4.42             | 4.95    | 220     | reference:postflop        |
| cd91a8fb8f9f | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 39.70/8.47             | 8.81    | 220     | reference:intent_engine   |
| 932a6a3b909e | 6b6eabb1 | tournament/plo6/river/2p   | check     | check     | -/-                         | reproduced |                                             | 25.18/31.49            | 31.87   | 120     | reference:postflop        |
| d4da3f5257f7 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.80/0.27              | 0.65    | 0       | reference:intent_engine   |
| fb2a23726bf4 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 2.67/n/a               | n/a     | n/a     | reference:postflop        |
| e1a4618a9535 | 6b6eabb1 | tournament/plo4/river/2p   | bet 229   | bet 229   | -/-                         | reproduced |                                             | 20.57/3.02             | 3.40    | 220     | reference:postflop        |
| 5cd40d028bc4 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.54/0.20              | 0.61    | 0       | reference:intent_engine   |
| 1a587889487f | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.67/0.37              | 0.74    | 0       | reference:intent_engine   |
| 9de263196236 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 41  | raise 41  | intent_engine/intent_engine | reproduced |                                             | 0.49/0.16              | 0.38    | 0       | reference:intent_engine   |
| 41b74a29435a | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 9.21/2.22              | 2.42    | 0       | reference:intent_engine   |
| 4c8a8f776603 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.72/0.26              | 0.52    | 0       | reference:intent_engine   |
| ba5be00f353c | 6b6eabb1 | tournament/nlh/flop/4p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 3.46/n/a               | n/a     | n/a     | reference:postflop        |
| 2ce53fc72263 | 6b6eabb1 | tournament/plo4/turn/3p    | check     | check     | -/-                         | reproduced |                                             | 73.36/12.93            | 13.31   | 220     | reference:postflop        |
| cc1796bbdebc | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.61/0.23              | 0.54    | 0       | reference:intent_engine   |
| 8dcda86e96fa | 6b6eabb1 | tournament/plo4/river/2p   | check     | check     | -/-                         | reproduced |                                             | 20.55/2.96             | 3.30    | 220     | reference:postflop        |
| f214731d61de | 6b6eabb1 | tournament/nlh/turn/2p     | bet 60    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 4.72/n/a               | n/a     | n/a     | reference:postflop        |
| 7a14c961b30c | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 4.38/n/a               | n/a     | n/a     | reference:postflop        |
| 4ecffac2920f | 6b6eabb1 | tournament/nlh/preflop/9p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 128.07/33.57           | 33.91   | 320     | reference:intent_engine   |
| a4615db3fc15 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 25.11/8.25             | 8.53    | 220     | reference:intent_engine   |
| 2c7d597ab6ec | 6b6eabb1 | tournament/nlh/turn/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 24.70/n/a              | n/a     | n/a     | reference:postflop        |
| 394eb63e3a37 | 6b6eabb1 | tournament/plo4/preflop/6p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 55.89/20.30            | 21.02   | 220     | reference:intent_engine   |
| 33562a5487db | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | n/a       | chart_bb_defend/-           | refused    | replay_unsupported:DECIDE_DEEP              | n/a/n/a                | n/a     | n/a     | reference:chart_bb_defend |
| 39c6637f7386 | 6b6eabb1 | tournament/nlh/preflop/3p  | raise 45  | raise 45  | intent_engine/intent_engine | reproduced |                                             | 6.12/2.19              | 2.82    | 0       | reference:intent_engine   |
| cef62a20bb48 | 6b6eabb1 | tournament/plo5/preflop/3p | call 10   | call 10   | intent_engine/intent_engine | reproduced |                                             | 0.94/0.51              | 0.90    | 0       | reference:intent_engine   |
| 400e61b25af7 | 6b6eabb1 | tournament/plo4/flop/2p    | all_in    | all_in    | -/-                         | reproduced |                                             | 11.86/3.93             | 4.33    | 220     | reference:postflop        |
| 46fa104019be | 6b6eabb1 | tournament/plo5/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.99/0.42              | 0.84    | 0       | reference:intent_engine   |
| f5534e99b43a | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.88/2.29              | 2.62    | 0       | reference:intent_engine   |
| 7a4097001cec | 6b6eabb1 | tournament/plo4/turn/2p    | fold      | fold      | -/-                         | reproduced |                                             | 15.03/4.83             | 5.26    | 220     | reference:postflop        |
| bc54f0186c42 | 6b6eabb1 | tournament/plo4/flop/2p    | fold      | fold      | -/-                         | reproduced |                                             | 12.83/5.54             | 5.87    | 220     | reference:postflop        |
| 46f58bd647e7 | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.85/0.34              | 0.71    | 0       | reference:intent_engine   |
| 8784f40a23fd | 6b6eabb1 | cash/nlh/preflop/5p        | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 6.72/1.84              | 2.51    | 0       | reference:intent_engine   |
| d2d4e4cf832b | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | n/a       | intent_engine/-             | refused    | replay_unsupported:DECIDE_DEEP              | n/a/n/a                | n/a     | n/a     | reference:intent_engine   |
| 8de62ef54f8a | 6b6eabb1 | tournament/nlh/turn/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 2.38/n/a               | n/a     | n/a     | reference:postflop        |
| 41f6f87d826a | 6b6eabb1 | tournament/plo4/river/2p   | check     | check     | -/-                         | reproduced |                                             | 94.87/7.58             | 7.98    | 132     | reference:postflop        |
| e81a1cf07377 | 6b6eabb1 | cash/nlh/preflop/5p        | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.64/2.18              | 2.57    | 0       | reference:intent_engine   |
| 9a6b3c583496 | 6b6eabb1 | tournament/plo5/river/2p   | bet 142   | bet 142   | -/-                         | reproduced |                                             | 22.19/5.50             | 6.07    | 170     | reference:postflop        |
| b0c93210a49a | 6b6eabb1 | tournament/plo4/flop/2p    | fold      | fold      | -/-                         | reproduced |                                             | 24.11/5.11             | 5.56    | 220     | reference:postflop        |
| 557aca654c21 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.50/0.28              | 0.73    | 0       | reference:intent_engine   |
| d9b5a37feac7 | 6b6eabb1 | tournament/plo4/turn/2p    | all_in    | all_in    | -/-                         | reproduced |                                             | 10.30/3.49             | 3.81    | 132     | reference_legality        |
| 24b2ad2c6d9a | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 2.59/0.87              | 1.24    | 0       | reference:intent_engine   |
| e30f2645bbd8 | 6b6eabb1 | tournament/plo4/preflop/6p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 78.68/15.27            | 15.70   | 120     | reference:intent_engine   |
| 76434ae48ae1 | 6b6eabb1 | tournament/plo4/river/2p   | check     | check     | -/-                         | reproduced |                                             | 18.14/1.12             | 1.41    | 132     | reference:postflop        |
| 6e4b583637d8 | 6b6eabb1 | tournament/nlh/flop/3p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 5.43/n/a               | n/a     | n/a     | reference:postflop        |
| 9f5796d57210 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.70/0.24              | 0.44    | 0       | reference:intent_engine   |
| 5653edf34eea | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.62/0.34              | 0.68    | 0       | reference:intent_engine   |
| ea9685da3ebd | 6b6eabb1 | tournament/nlh/river/2p    | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 5.31/n/a               | n/a     | n/a     | reference:postflop        |
| 6dee1332a533 | 6b6eabb1 | tournament/plo4/preflop/3p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 7.87/0.28              | 0.62    | 0       | reference:intent_engine   |
| 5a6680697441 | 6b6eabb1 | tournament/nlh/preflop/3p  | all_in    | all_in    | intent_engine/intent_engine | reproduced |                                             | 5.61/2.07              | 2.37    | 0       | reference:intent_engine   |
| 71dfd4ec3ebc | 6b6eabb1 | tournament/plo4/turn/2p    | fold      | n/a       | -/-                         | refused    | replay_unsupported:DECIDE_DEEP              | n/a/n/a                | n/a     | n/a     | reference:postflop        |
| fff18be0d57d | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.76/0.21              | 0.63    | 0       | reference:intent_engine   |
| 8f4201940f60 | 6b6eabb1 | tournament/nlh/flop/2p     | bet 23    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 55.36/n/a              | n/a     | n/a     | reference:postflop        |
| 3da3a1689d53 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 6.51/n/a               | n/a     | n/a     | reference:postflop        |
| 78e837c06481 | 6b6eabb1 | tournament/nlh/turn/2p     | call 39   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 66.36/n/a              | n/a     | n/a     | reference:postflop        |
| b8e6943ee941 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 0.72/0.38              | 0.75    | 0       | reference:intent_engine   |
| a0888013db95 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 63  | raise 63  | intent_engine/intent_engine | reproduced |                                             | 0.54/0.17              | 0.40    | 0       | reference:intent_engine   |
| c1c51c5cebbb | 6b6eabb1 | tournament/plo6/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 3.01/0.25              | 0.43    | 0       | reference:intent_engine   |
| 62b4d1d0b4eb | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.54/0.12              | 0.28    | 0       | reference:intent_engine   |
| 6826fb066329 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 16.55/2.23             | 2.44    | 0       | reference:intent_engine   |
| 8967b80a1509 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.58/0.19              | 0.69    | 0       | reference:intent_engine   |
| e7738f905a11 | 6b6eabb1 | tournament/nlh/turn/3p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 3.54/n/a               | n/a     | n/a     | reference:postflop        |
| 65ff9e352a05 | 6b6eabb1 | tournament/plo4/flop/2p    | check     | check     | -/-                         | reproduced |                                             | 16.41/3.72             | 4.07    | 220     | reference:postflop        |
| 21db7fc9d808 | 6b6eabb1 | tournament/plo4/river/2p   | bet 20    | bet 20    | -/-                         | reproduced |                                             | 22.53/2.91             | 3.32    | 220     | reference:postflop        |
| ffa90c4bd450 | 6b6eabb1 | tournament/nlh/turn/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 6.77/n/a               | n/a     | n/a     | reference:postflop        |
| 02e4625a5b31 | 6b6eabb1 | tournament/plo4/flop/2p    | bet 61    | bet 61    | -/-                         | reproduced |                                             | 28.38/2.70             | 3.16    | 132     | reference:postflop        |
| 4afdb9f0d875 | 6b6eabb1 | tournament/plo4/flop/2p    | check     | check     | -/-                         | reproduced |                                             | 16.56/2.71             | 3.12    | 132     | reference:postflop        |
| fc49c122b7f3 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 3.77/0.32              | 0.66    | 0       | reference:intent_engine   |
| 72d3a92d4fd0 | 6b6eabb1 | tournament/plo4/preflop/2p | call 40   | call 40   | intent_engine/intent_engine | reproduced |                                             | 4.45/0.24              | 0.47    | 0       | reference:intent_engine   |
| b824c382065a | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 33.99/0.41             | 0.73    | 0       | reference:intent_engine   |
| 4c82cc0fe924 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 3.72/0.38              | 0.79    | 0       | reference:intent_engine   |
| 2c156212c64e | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 47  | raise 47  | intent_engine/intent_engine | reproduced |                                             | 1.59/0.18              | 0.43    | 0       | reference:intent_engine   |
| 3c8487e607aa | 6b6eabb1 | tournament/nlh/flop/9p     | bet 224   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 7.04/n/a               | n/a     | n/a     | reference:postflop        |
| 123153d8ab10 | 6b6eabb1 | tournament/nlh/preflop/2p  | check     | check     | intent_engine/intent_engine | reproduced |                                             | 0.81/0.17              | 0.36    | 0       | reference:intent_engine   |
| f3961db46064 | 6b6eabb1 | tournament/nlh/preflop/2p  | raise 53  | raise 53  | intent_engine/intent_engine | reproduced |                                             | 0.42/0.13              | 0.32    | 0       | reference:intent_engine   |
| 0597198e2e69 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 3.12/0.19              | 0.36    | 0       | reference:intent_engine   |
| 23f445c8229a | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | n/a       | chart_open_jam/-            | refused    | reference_unavailable:chart_store           | 7.48/n/a               | n/a     | n/a     | reference:chart_open_jam  |
| 98c092c6e3c0 | 6b6eabb1 | cash/nlh/flop/5p           | call 5    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 65.67/n/a              | n/a     | n/a     | reference:postflop        |
| 84336373d9fd | 6b6eabb1 | tournament/nlh/flop/3p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 5.49/n/a               | n/a     | n/a     | reference:postflop        |
| aa7287809ab9 | 6b6eabb1 | tournament/nlh/turn/2p     | bet 59    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 57.02/n/a              | n/a     | n/a     | reference:postflop        |
| ae285a3057cb | 6b6eabb1 | tournament/plo4/preflop/2p | call 40   | call 40   | intent_engine/intent_engine | reproduced |                                             | 0.70/0.33              | 0.69    | 0       | reference:intent_engine   |
| 94e62a4346f3 | 6b6eabb1 | tournament/nlh/preflop/2p  | call 45   | call 45   | intent_engine/intent_engine | reproduced |                                             | 0.50/0.16              | 0.39    | 0       | reference:intent_engine   |
| 509cec6501b6 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.73/0.14              | 0.31    | 0       | reference:intent_engine   |
| dcc768456876 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 6.14/n/a               | n/a     | n/a     | reference:postflop        |
| f977a7639694 | 6b6eabb1 | tournament/nlh/flop/2p     | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 6.80/n/a               | n/a     | n/a     | reference:postflop        |
| 26883b73bca8 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 44.73/0.20             | 0.37    | 0       | reference:intent_engine   |
| 2e75eecc893c | 6b6eabb1 | cash/nlh/preflop/5p        | call 3    | call 3    | intent_engine/intent_engine | reproduced |                                             | 0.88/0.24              | 0.71    | 0       | reference:intent_engine   |
| 4f561bd443bb | 6b6eabb1 | tournament/plo5/preflop/2p | raise 90  | raise 90  | intent_engine/intent_engine | reproduced |                                             | 28.94/7.27             | 7.60    | 170     | reference:intent_engine   |
| 9313bd1e67b8 | 6b6eabb1 | tournament/plo5/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 45.72/7.25             | 7.70    | 170     | reference:intent_engine   |
| 78727dfed692 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 21.64/6.75             | 7.05    | 220     | reference:intent_engine   |
| 368ee4859259 | 6b6eabb1 | tournament/nlh/flop/2p     | bet 22    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 39.12/n/a              | n/a     | n/a     | reference:postflop        |
| d212fd005c4c | 6b6eabb1 | tournament/plo4/flop/3p    | call 20   | call 20   | -/-                         | reproduced |                                             | 15.55/4.19             | 4.68    | 220     | reference:postflop        |
| 540ec482fb14 | 6b6eabb1 | tournament/plo4/flop/6p    | check     | check     | -/-                         | reproduced |                                             | 14.54/1.56             | 1.97    | 187     | reference:postflop        |
| d64a7f00f023 | 6b6eabb1 | tournament/plo4/preflop/2p | all_in    | all_in    | variant_price/variant_price | reproduced |                                             | 13.90/2.51             | 2.74    | 176     | reference_legality        |
| 12307e9a5b1a | 6b6eabb1 | cash/nlh/preflop/5p        | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.73/0.27              | 0.65    | 0       | reference:intent_engine   |
| ff1a48388360 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 90  | raise 90  | intent_engine/intent_engine | reproduced |                                             | 0.75/0.30              | 0.65    | 0       | reference:intent_engine   |
| 29f256a21381 | 6b6eabb1 | tournament/plo4/flop/2p    | bet 77    | bet 77    | -/-                         | reproduced |                                             | 19.14/3.68             | 4.02    | 220     | reference:postflop        |
| 116d8cd34f33 | 6b6eabb1 | tournament/nlh/preflop/2p  | call 28   | call 28   | intent_engine/intent_engine | reproduced |                                             | 0.61/0.24              | 0.91    | 0       | reference:intent_engine   |
| 82ef556894e1 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.65/0.15              | 0.39    | 0       | reference:intent_engine   |
| 2c974921a633 | 6b6eabb1 | tournament/nlh/preflop/2p  | fold      | n/a       | chart_bb_defend/-           | refused    | reference_unavailable:chart_store           | 0.51/n/a               | n/a     | n/a     | reference:chart_bb_defend |
| 7ff5a1f1e686 | 6b6eabb1 | tournament/plo5/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 19.72/6.06             | 6.41    | 102     | reference:intent_engine   |
| 3aa4d316649a | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.90/0.33              | 0.64    | 0       | reference:intent_engine   |
| 32450a88b1dd | 6b6eabb1 | tournament/nlh/preflop/9p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 87.02/21.03            | 21.44   | 192     | reference:intent_engine   |
| f0a7079f312d | 6b6eabb1 | tournament/nlh/preflop/2p  | call 28   | call 28   | intent_engine/intent_engine | reproduced |                                             | 10.00/0.22             | 0.49    | 0       | reference:intent_engine   |
| 48854bcc4f89 | 6b6eabb1 | tournament/plo4/flop/6p    | check     | check     | -/-                         | reproduced |                                             | 68.66/15.87            | 16.27   | 187     | reference:postflop        |
| 02804bb97101 | 6b6eabb1 | tournament/nlh/preflop/3p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.59/0.21              | 0.52    | 0       | reference:intent_engine   |
| 1183f306f28b | 6b6eabb1 | tournament/nlh/river/3p    | check     | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 6.64/n/a               | n/a     | n/a     | reference:postflop        |
| 92c7d5ffc930 | 6b6eabb1 | tournament/nlh/river/2p    | bet 191   | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 5.03/n/a               | n/a     | n/a     | reference:postflop        |
| a25041d635e5 | 6b6eabb1 | tournament/nlh/flop/2p     | bet 32    | n/a       | -/-                         | refused    | reference_unavailable:solver_store:postflop | 2.28/n/a               | n/a     | n/a     | reference:postflop        |
| f2a5d2b0e701 | 6b6eabb1 | tournament/plo4/preflop/2p | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 0.92/0.37              | 0.79    | 0       | reference:intent_engine   |
| b4045f4742bd | 6b6eabb1 | tournament/plo4/turn/2p    | call 57   | call 57   | -/-                         | reproduced |                                             | 64.97/9.25             | 9.54    | 132     | reference:postflop        |
| 5143c8fac264 | 6b6eabb1 | tournament/plo4/preflop/2p | raise 180 | raise 180 | intent_engine/intent_engine | reproduced |                                             | 0.74/0.29              | 0.55    | 0       | reference:intent_engine   |
| 1f8e0f052d5f | 6b6eabb1 | tournament/nlh/preflop/4p  | fold      | fold      | intent_engine/intent_engine | reproduced |                                             | 4.66/1.72              | 2.08    | 0       | reference:intent_engine   |
| 4e79d9efbae3 | 6b6eabb1 | tournament/nlh/preflop/2p  | call 29   | call 29   | intent_engine/intent_engine | reproduced |                                             | 0.54/0.32              | 0.71    | 0       | reference:intent_engine   |
| b9995a548c2b | 6b6eabb1 | tournament/plo4/preflop/2p | raise 60  | raise 60  | intent_engine/intent_engine | reproduced |                                             | 21.51/6.93             | 7.27    | 220     | reference:intent_engine   |
| b27c9177d822 | 6b6eabb1 | tournament/plo4/river/2p   | bet 308   | bet 308   | -/-                         | reproduced |                                             | 14.53/3.15             | 3.84    | 220     | reference:postflop        |

Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.
