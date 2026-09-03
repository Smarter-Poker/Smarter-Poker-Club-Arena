# Problem 018 — `wallet_transactions.balance_after` Never Populated (Audit Gap)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (live audit during Dan's "verify all features" pass)
**Date Fixed:** 2026-04-15 SQL layer LIVE; server code pending Hetzner redeploy
**Severity:** MEDIUM-HIGH — wallet reconciliation capability entirely absent

## Discovery

Dan directed a "verify all features" full audit. During the behavior-level pass:

```sql
SELECT COUNT(*) AS total_rows, COUNT(balance_after) AS with_balance_after,
       COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h,
       COUNT(balance_after) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_24h_with_balance
FROM wallet_transactions;
-- total_rows: 1,951,152
-- with_balance_after: 0          ← zero, ever, in 2M+ rows
-- last_24h: 224
-- last_24h_with_balance: 0        ← still zero at the current burn rate
```

The `balance_after` column exists and is nullable, but was NEVER written in the entire history of the platform.

## Root cause (4 layers)

Every path that writes to `wallet_transactions` omits `balance_after`:

1. **`log_wallet_transaction` RPC (6-arg overload)** — INSERT omits balance_after.
2. **`log_wallet_transaction` RPC (9-arg overload)** — INSERT omits balance_after.
3. **`atomic_table_buyin` RPC** — direct INSERT omits balance_after.
4. **`atomic_table_cashout` RPC** — direct INSERT omits balance_after.
5. **`atomic_table_rebuy` RPC** — direct INSERT omits balance_after AND has two unrelated bugs: references nonexistent column `reference_id`, and omits NOT NULL column `wallet_type`. Function would `RAISE` on the first production call. (Narrow miss: auto-rebuy uses a separate direct-INSERT path in `server/src/services/supabase.ts`; my BUG 017 bust-rebuy flow had not yet been exercised in production when I discovered this.)
6. **`server/src/services/supabase.ts` — 4 direct INSERT sites** bypassing any RPC:
   - Auto-rebuy topup (line ~225)
   - Cash-out at leave (line ~299)
   - Cash-out alternate path (line ~383)
   - Horse wallet refill (line ~782)

## Fix

### Part A — SQL migration (live-applied, no deploy required)

`supabase/migrations/20260415_bug_018_balance_after.sql` — applied via Supabase MCP in the same session:

- Both `log_wallet_transaction` overloads now `SELECT balance FROM wallets` and include `balance_after` in the INSERT.
- `atomic_table_buyin`: `UPDATE wallets ... RETURNING balance INTO v_new_balance`, then INSERT with `balance_after: v_new_balance`.
- `atomic_table_cashout`: same pattern via `ON CONFLICT DO UPDATE ... RETURNING balance`.
- `atomic_table_rebuy`: triple-bug fix in one:
  - Added `wallet_type = 'PLAYER'` to satisfy NOT NULL.
  - Removed nonexistent `reference_id` column; kept `table_id` (the real FK column).
  - Added `balance_after` via `UPDATE wallets ... RETURNING balance`.

The `RETURNING` pattern is strictly better than the naive "SELECT, then INSERT" pattern because it runs inside the same transaction and row lock, eliminating any race where another path mutates the wallet between SELECT and INSERT.

### Part B — Server code (pending Hetzner redeploy)

`server/src/services/supabase.ts` — 4 direct INSERT sites now also include `balance_after`:

- **Auto-rebuy topup**: compute `newBalance = wallet.balance - rebuyAmount` before the UPDATE, reuse in INSERT.
- **Leave-table cashout (primary)**: compute `newBalance = currentBalance + stack` for the upsert, reuse in INSERT.
- **Leave-table cashout (alternate, `atomicCashout`)**: read post-upsert `wallets.balance` and use.
- **Horse wallet refill**: compute `newBalance = wallet.balance + topUp` and include.

These changes ship via the CA repo but require a Hetzner container rebuild (`./server/deploy-hetzner.sh`) to activate — the same blocker as BUGs 008/009/012.

## Verification plan

Once the SQL migration is live (ALREADY APPLIED):

- Any fresh buy-in via `atomic_table_buyin` RPC populates `balance_after`. Expected burn rate: 187 buyins per 24h → one verifiable row every ~8 minutes.
- Any fresh cashout via `atomic_table_cashout` RPC populates `balance_after`. Rarer.
- Any bust-rebuy via `atomic_table_rebuy` RPC populates `balance_after` AND no longer errors on the reference_id/wallet_type mismatch.

Once the server code ships to Hetzner:

- Auto-rebuy topups populate `balance_after` (category='rebuy' from supabase.ts path).
- Leave-table cashouts populate `balance_after`.
- Horse wallet refills populate `balance_after`.

Post-deploy verification query:

```sql
SELECT
  DATE_TRUNC('minute', created_at) AS minute,
  category,
  COUNT(*) AS rows,
  COUNT(balance_after) AS with_balance
FROM wallet_transactions
WHERE created_at > '<migration-apply-time>'
GROUP BY 1, 2
ORDER BY 1 DESC
LIMIT 20;
```

All rows post-migration should satisfy `rows = with_balance`. Any row with `with_balance < rows` is a new-regression and means a new INSERT site was added that bypasses the fix.

## Related

- BUGs 008–017 — all earlier silent-failure wallet/financial bugs from this session.
- DECISION D-001 — equal-share rake (not impacted by this fix).

## Lesson

Tenth silent-failure data-integrity bug found in this session. Common pattern keeps reproducing: columns exist, ORM doesn't enforce NOT NULL on optional fields at insert time, audit/reconciliation capability silently absent in production for years. The one-line check (`SELECT COUNT(balance_after) FROM wallet_transactions`) surfaced it in seconds. Similar checks should be added to the live-verification harness for every other "nullable audit field" column in the schema.
