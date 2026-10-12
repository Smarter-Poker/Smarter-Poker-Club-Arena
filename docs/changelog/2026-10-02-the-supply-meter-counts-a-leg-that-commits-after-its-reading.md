# The supply meter counts a leg that commits after its reading (2026-10-02)

Launch-gate sweep. Migration `20261002164500`.

## What the rows said

- **The 15:05 UTC kill switch was the meter, not a leak.** `fn_ca_supply_snapshot` read -100,005.30 unexplained for 14:05 -> 15:05 (incidents `2e00634c`, `d9ebce90`, `035e55db`, verdict UNCONFIRMED; payouts were never frozen). Snapshot 778 (14:05:00.176) recorded `burn_since_prev` 802,036.92; the same window read later returns 902,036.92. A 100,000.00 certification burn (`club_treasury -> chip_retirement`) was stamped inside 13:05 -> 14:05 but committed after 14:05:00.176: its balance change landed in the next reading, its leg in the previous window. 778 + 779 together come to -4.62, the meter's ordinary noise; 16:05 read 6.01.
- **Why.** `chip_ledger.created_at` is the writer's transaction start, not its commit (the same defect `20260927144455` fixed in the rakeback settler). The meter windowed the ledger by `created_at` and read it in a different statement from the balances, so any writer open across a reading split its balance and its leg across two readings.
- **Money-path check.** `20261002140203` retired `atomic_tournament_register` (it only raises `atomic_tournament_register_retired`); `fn_union_money_path_check` still listed it, so the hourly conservation sweep filed "money path no longer reaches club scope" from 15:52 (incident `696b3666`).

## What changed

- `fn_ca_supply_snapshot` reads balances, this window's mint/burn and the previous six windows in one statement under one cut. A leg that became visible since its window was read is counted once, as `late_mint` / `late_burn`, in the reading where its balance first appears; the window is marked `restated_mint` / `restated_burn` / `restated_at`. `mint_since_prev` / `burn_since_prev` keep what was read at the time. A chip that moves with no leg still reads unexplained.
- Snapshot 778 is restated once so the first new reading does not count that burn twice.
- `fn_union_money_path_check` lists `fn_register_for_tournament` in place of the retired function.

Dry run in production (one rolled-back transaction): the new meter restated only 778 and read -0.71 unexplained in 19 s. Nothing was moved; no balance was touched.
