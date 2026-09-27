Command: `python3 server/scripts/phase6b-route-proof-observe.py f2e484a3d1a674f329d923b30394fd65f5aff50e 2026-09-26T14:41:00Z 2026-09-27T14:41:00Z docs/evidence/phase6b`

Engine /health before: release `f2e484a3d1a674f329d923b30394fd65f5aff50e`; Horse journal mode paused (paused: archive_segments since 2026-09-26T14:13:54.887Z); journal records 4139804.

Engine /health after: release `f2e484a3d1a674f329d923b30394fd65f5aff50e`; Horse journal mode paused (paused: archive_segments since 2026-09-26T14:13:54.887Z); journal records 4139804.

Selector: observer release `f2e484a3d1a674f329d923b30394fd65f5aff50e`, records release `f2e484a3d1a674f329d923b30394fd65f5aff50e`, window 2026-09-26T14:41:00Z to 2026-09-27T14:41:00Z (UTC), journal `/var/lib/club-arena/horse-decisions`.

Archive rows scanned 8192 (rowid 4131613 to 4139804); rows inside the window 0; other-release rows inside the window 0; truncated: false.

Tournament preflop decisions on this release: 0; receipts with a lookup 0; matched snapshot 0; mismatch refused 0; accepted actions bound 0.

Cells: universe 5643 (sizes 9 x branches 11 x ante modes 3 x bands 19); observed 0; unobserved 5643.

### By dealt size

| Key |   Observed | Baseline | Refused | Mismatch refused | Accepted |
| --- | ---------: | -------: | ------: | ---------------: | -------: |
| 2   | unobserved |          |         |                  |          |
| 3   | unobserved |          |         |                  |          |
| 4   | unobserved |          |         |                  |          |
| 5   | unobserved |          |         |                  |          |
| 6   | unobserved |          |         |                  |          |
| 7   | unobserved |          |         |                  |          |
| 8   | unobserved |          |         |                  |          |
| 9   | unobserved |          |         |                  |          |
| 10  | unobserved |          |         |                  |          |

### By preflop branch

| Key              |   Observed | Baseline | Refused | Mismatch refused | Accepted |
| ---------------- | ---------: | -------: | ------: | ---------------: | -------: |
| unopened         | unobserved |          |         |                  |          |
| limp_facing      | unobserved |          |         |                  |          |
| open_facing      | unobserved |          |         |                  |          |
| three_bet_facing | unobserved |          |         |                  |          |
| cold_call        | unobserved |          |         |                  |          |
| overcall         | unobserved |          |         |                  |          |
| squeeze          | unobserved |          |         |                  |          |
| reshove          | unobserved |          |         |                  |          |
| blind_vs_blind   | unobserved |          |         |                  |          |
| bb_defense       | unobserved |          |         |                  |          |
| multiway_all_in  | unobserved |          |         |                  |          |

### By ante mode

| Key        |   Observed | Baseline | Refused | Mismatch refused | Accepted |
| ---------- | ---------: | -------: | ------: | ---------------: | -------: |
| none       | unobserved |          |         |                  |          |
| per_player | unobserved |          |         |                  |          |
| big_blind  | unobserved |          |         |                  |          |

### By stack-anchor band (big blinds)

| Key       |   Observed | Baseline | Refused | Mismatch refused | Accepted |
| --------- | ---------: | -------: | ------: | ---------------: | -------: |
| below-2   | unobserved |          |         |                  |          |
| 2-3       | unobserved |          |         |                  |          |
| 3-4       | unobserved |          |         |                  |          |
| 4-5       | unobserved |          |         |                  |          |
| 5-6       | unobserved |          |         |                  |          |
| 6-8       | unobserved |          |         |                  |          |
| 8-10      | unobserved |          |         |                  |          |
| 10-12     | unobserved |          |         |                  |          |
| 12-15     | unobserved |          |         |                  |          |
| 15-18     | unobserved |          |         |                  |          |
| 18-20     | unobserved |          |         |                  |          |
| 20-25     | unobserved |          |         |                  |          |
| 25-30     | unobserved |          |         |                  |          |
| 30-40     | unobserved |          |         |                  |          |
| 40-60     | unobserved |          |         |                  |          |
| 60-80     | unobserved |          |         |                  |          |
| 80-100    | unobserved |          |         |                  |          |
| 100       | unobserved |          |         |                  |          |
| above-100 | unobserved |          |         |                  |          |

### Observed cells

| Size | Branch | Ante | Band | Observed | Baseline | Refused | Mismatch refused | Accepted | Accepted unavailable |
| ---: | ------ | ---- | ---- | -------: | -------: | ------: | ---------------: | -------: | -------------------- |

Unobserved cells: 5643 of 5643; the full list is in the JSON under `cells.unobserved`.
