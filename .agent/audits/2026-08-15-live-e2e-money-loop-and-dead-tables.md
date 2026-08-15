# 2026-08-15 — Live seated E2E, money-loop fix, side-pot render fix, dead-table recovery

Agent: Claude (Cowork cloud session). All changes shipped same-session and verified live.

## 1. P0 buy-in/cashout — SECURITY DEFINER conversion (production DB)

Live repro at table d9f89a01: atomic_table_buyin raised 42501, then (after an
EXECUTE grant restore) "Insufficient balance" with 14.4M in the wallet. Root
cause: both atomic_table_buyin and atomic_table_cashout were SECURITY INVOKER
while wallets/table_seats/wallet_transactions/tables carry NO write policies
for authenticated — the wallet UPDATE matched 0 rows. Functions were designed
to run privileged.

Migration `buyin_cashout_security_definer_with_identity_guard` (applied via
Supabase MCP): SECURITY DEFINER + SET search_path=public,pg_temp + identity
guard (auth.uid() must equal p_user_id when present; service_role calls with
NULL auth.uid() unaffected) + grants tightened to authenticated/service_role,
PUBLIC/anon revoked.

Verified end-to-end seated as a real player: buy-in 200, 15 hands over 6 min
(calls, checks, folds, a raise, a won showdown +13), cashout 198.
wallet_transactions: -200 debit 02:37, +198 credit 02:42, balance_after
matches wallets.balance to the cent. Chip-placement probe: 0 off-scaler
violations across the whole session.

## 2. Client: main pot double-rendered as SIDE POT 1 — PR #45 (ac6d6151)

mapEngineSnapshot mapped EVERY entry of the engine snapshot's pots[]
partition into sidePots, but pots[0] IS the main pot: single-pot hands at
settlement showed "POT 2,745 / SIDE POT 1: 2,745 / TOTAL 5,490" and carried
a phantom side pot into the next hand's first snapshots. Fix: sidePots =
pots.slice(1); displayed main pot = pots[0].amount when the partition
exists, else s.pot. Deployed: WH sync 891fb4dc, Vercel dpl_8puZsUTj READY
(production) 02:58 UTC.

## 3. Engine: dead-table / zombie-seat recovery — PR #46 (540c9faa)

After a mid-hand engine restart, tables hydrate with horses whose stacks
went to the aborted pot (stack 0, left_at NULL). Settlement step 5 only
scans players of a COMPLETED hand, so those horses were invisible forever:
fully dead tables (all seats 0, loop sleeps in the fewer-than-2-players
branch) and zombie seats (12+ tables running 2-handed around five 0-stack
horses). Fix: recoverBustedSeatedHorses() in ServerTableEngineDealing, run
every dealing-loop tick on cash tables; mirrors Settlement step 5
(stop-loss at 2 rebuys, treasury rebuy, remove-on-failure with full engine
cleanup), throttled per-horse to 30s.

Verified live post-deploy: removal bursts 03:13-03:15 UTC, hand rate rose
from ~30/min to 56-62/min, and zombie seats on ACTIVE tables dropped to 0
within ~7 minutes.

## 4. Data hygiene: orphaned seats on closed tables (production DB)

Migration `cashout_and_close_orphaned_seats_on_closed_tables`: 51 chip-
holding seats on closed tables (all horses, 1,059,272.08 total) put through
atomic_credit_wallet_and_log with the engine's own cashout:&lt;seat.id&gt;
idempotency key — ALL deduped against prior committed-but-uncompleted
cashouts (0 new credits, no double-pay), seats soft-closed, zero-stack
orphans closed, tables.current_players ghost counts synced. A safety
assertion aborts if any non-horse or still-funded discrepancy appears.

## 5. Open follow-ups

- Leave Table hit HTTP 429 twice during normal play ("Server error (429)"
  toast, no retry) — rate-limit bucket too tight for play + menu traffic.
- Session Complete modal: "Biggest pot 0" and "Peak stack 200" wrong (won
  pot 20, peaked 203).
- CALL ANY pre-select did not auto-fire on an arriving bet (#327 flop);
  CHECK/FOLD did fire (#324).
- GameServerAPI heartbeat 502/404 flapping; table_hole_cards Realtime
  CHANNEL_ERROR (needs engine-side investigation).
