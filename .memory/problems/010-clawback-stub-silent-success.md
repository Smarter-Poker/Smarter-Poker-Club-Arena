# Problem 010 — Clawback Stub Returned Silent Success (Zero Chips Moved)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (live verification, D-2 #3)
**Date Fixed:** 2026-04-15 (same session — fix-first)
**Severity:** HIGH (advertised 10-minute clawback window was a no-op; super-agent "reversals" never reversed)

## Discovery

Phase D signoff called out distribution clawback (10-min window) as an area that "exceeds PokerBros baseline" (see `.memory/context/2026-04-15-phase-D-signoff.md`). D-2 #3 live verification found:

- `chip_transactions`: 13,902 total rows
- `chip_transactions.is_reversed = true`: **0** rows
- `clawback_audit_log` table: **does not exist**

The existing RPC body was:

```sql
CREATE OR REPLACE FUNCTION fn_clawback_chips_atomic(
  p_transaction_id uuid, p_club_id uuid, p_agent_id uuid, p_amount numeric
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO clawback_audit_log (...) VALUES (...);
  RETURN jsonb_build_object('success', true, 'clawed_back', p_amount);
END;
$$
```

Two compound bugs:

1. The **INSERT targets `clawback_audit_log` which doesn't exist** → every call raises PostgreSQL 42P01.
2. Even if the audit row succeeded, the stub **returned `success: true` without touching chip_transactions, wallets, or agents** — the chips stayed where they were regardless.

The client (`AgentService.clawbackDistribution`, line 1185) surfaces the RPC response. On error it sets a failure toast; on `success: true` it tells the user the clawback worked. Either path misleads: the clawback never actually happens.

## Fix

`supabase/migrations/20260415_fix_clawback_stub_bug010.sql` — full atomic clawback body, applied live to Supabase in the same session:

1. `SELECT ... FOR UPDATE` the source transaction row (lock).
2. Reject if already reversed (`is_reversed` or `clawed_back`), wrong club, past `reversible_until`, or amount mismatch.
3. Debit the recipient — tries `agents.player_balance` first (if recipient is an agent in that club), falls back to `wallets.balance` where `wallet_type='PLAYER'`.
4. Refuse if it would drop the recipient balance below zero ("recipient spent the chips — clawback would create negative balance").
5. Credit the sender's `agents.business_balance`.
6. Mark source row `is_reversed=true, clawed_back=true`.
7. Insert a reversal audit row in `chip_transactions` with `transaction_type='CLAWBACK'` and `metadata.reversed_transaction_id` pointing back to the original.

Function signature unchanged — `AgentService.clawbackDistribution` works without any client update. Function comment records the fix.

## Safety invariants

| Invariant                          | Enforced by                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Only within 10-min window          | `reversible_until < NOW()` check (agent UI sets `reversible_until = NOW() + 10 min` on distribution) |
| Never clawback a reversed tx twice | `is_reversed OR clawed_back` early-out                                                               |
| Never clawback across clubs        | `club_id <> p_club_id` rejection                                                                     |
| Never create negative balance      | `v_to_user_balance < 0 → RAISE EXCEPTION` (rolls back the whole tx)                                  |
| Atomic (all-or-nothing)            | Single plpgsql function with implicit transaction; any RAISE rolls back all UPDATEs                  |

## Verification queued

Next time an agent clicks "Clawback" within 10 min of a distribution:

1. RPC returns `{success: true, clawed_back: amount, new_recipient_balance: N, new_agent_balance: M}`
2. `SELECT COUNT(*) FROM chip_transactions WHERE is_reversed=true` should now be > 0
3. Recipient's balance should be reduced by exactly `amount`
4. Agent's business_balance should be increased by exactly `amount`
5. A new `CLAWBACK` row should exist in chip_transactions with `metadata.reversed_transaction_id` matching the original

Attempts to clawback after 10 min return `{success:false, error:'clawback_window_expired'}` instead of lying.

## Related

- BUG 008 — Rakeback settler missing (same silent-failure pattern)
- BUG 009 — Agent commission never credited (same silent-failure pattern)
- Phase D signoff — claimed clawback as "exceeds PokerBros baseline" ability; that claim now holds because the RPC does what it says

## Lesson (third in a row)

**Three silent-failure bugs found in the same verification session.** Common pattern: code/DB/UI components exist, surface-level API contracts are honored, but the behavior is hollow — either nothing flows (008, 009) or the stub returns success without doing the work (010).

Future agent rule: whenever a phase signoff claims a feature "exceeds baseline," write a live verification check that exercises the full data path, not just the RPC presence. The "feature exists in code" answer hid three financial bugs in this codebase alone.
