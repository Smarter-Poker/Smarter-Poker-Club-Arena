# Live Verification Harness

End-to-end test rigs for the deferred X-2 items across PokerBros parity Phases B-H.

Each script targets one specific deferred check from the phase signoff docs in `.memory/context/2026-04-15-phase-*-signoff.md`.

## Inventory

| Script                                   | Phase           | What it validates                                                                                                                                                                               |
| ---------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-rls-regression.sql`                  | F-2 #1          | God-mode RLS removed; per-user policy in effect on `table_hole_cards`; financial tables RLS-enabled; SECURITY DEFINER on critical RPCs; Realtime publication includes `wallet_transactions`     |
| `02-equal-share-rake.sql`                | D-2 #1          | Per-hand rake split is exactly equal across dealt-in players (FIX 144 / DECISION D-001)                                                                                                         |
| `03-double-spend-buyin.sql`              | F-2 #2          | 100 concurrent `lock_for_buyin` calls produce exactly 1 success, 99 failures, exactly `amount` debited                                                                                          |
| `04-engine-telemetry-snapshot.sh`        | G-2 #0          | Hetzner engine `/health` reports hands_dealt > 0, hands_per_hour > 0, broadcast_threshold_violations == 0                                                                                       |
| `cashier-claim-back-cent-integrity.sql`  | Cashier Phase 1 | In one rolled-back transaction: rejects sub-cents, conserves a whole-cent reversal, replays the same intent, refuses a reused key for another source, and blocks a direct browser balance write |
| `cashier-phase2-authorization-audit.sql` | Cashier Phase 2 | In one rolled-back transaction: proves mandatory retry keys, scoped roster/agent/ticket reads, distinct ticket closing receipts, replay safety, and exact escrow credits                        |
| `cashier-phase3-performance.sql`         | Cashier Phase 3 | In one rolled-back transaction: proves keyset pages have no overlap, bounded send/ticket batches replay without duplicate movement, oversize batches refuse, and all hot indexes are valid      |

## Coming next

| Script                           | Phase  | What it validates                                                   |
| -------------------------------- | ------ | ------------------------------------------------------------------- |
| `05-agent-commission-credit.sql` | D-2 #2 | Agent commission is credited correctly on each hand                 |
| `06-distribution-clawback.sql`   | D-2 #3 | 10-min clawback window reverses chip flow atomically                |
| `07-union-chip-transfer.sql`     | D-2 #4 | `union_send_chips_to_club` updates both balances in one transaction |
| `08-vip-quota-consume.sql`       | E-2 #4 | Gold user time-bank quota decrements; over-quota → diamond purchase |
| `09-daily-claim-credit.sql`      | E-2 #5 | Daily challenge claim credits wallet correctly                      |
| `10-position-stats-accuracy.sql` | H-2 #1 | `player_position_stats` rows match Bible §3.2 derivation            |
| `11-disconnect-grace-test.sh`    | F-2 #4 | Drop network mid-turn; expect server auto-check then auto-fold      |
| `12-cross-tab-notification.sh`   | G-2 #3 | Action-required toast fires on inactive tabs                        |

## Usage

### SQL scripts

```bash
# Run individually against the live Supabase project
psql "$DATABASE_URL" -f scripts/verification-harness/01-rls-regression.sql

# Or paste into Supabase SQL Editor (Dashboard → SQL Editor)
```

### Bash scripts

```bash
ENGINE_URL=https://engine.smarter.poker bash scripts/verification-harness/04-engine-telemetry-snapshot.sh
```

### Run everything

```bash
bash scripts/verification-harness/run-all.sh
```

(see `run-all.sh` — runs each test in sequence, halts on first failure)

## Output convention

Every check prints a row with:

```
TEST_<NUM>_<NAME> | <result>
```

where result is `PASS` or starts with `FAIL — <reason>`.

The `run-all.sh` driver greps for `^FAIL` and exits non-zero if any check fails.
