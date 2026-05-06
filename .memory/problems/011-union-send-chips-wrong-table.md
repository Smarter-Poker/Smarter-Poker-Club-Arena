# Problem 011 — fn_union_send_chips_to_club Targeted Non-Existent Table

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (live verification D-2 #4)
**Date Fixed:** 2026-04-15 (same session, fix-first)
**Severity:** HIGH (cross-club federation chip movement permanently broken)

## Discovery

Phase D signoff claimed union → club chip transfer as a working PokerBros-parity feature. D-2 #4 live verification found:

| Check                                                                  | Live value |
| ---------------------------------------------------------------------- | ---------- |
| `union_wallet_transactions` rows last 30 days                          | 0          |
| `union_wallet_transactions` with `tx_type='send_to_club'` last 30 days | 0          |

RPC body ended with:

```sql
INSERT INTO public.union_transactions (...) VALUES (...);
```

but `public.union_transactions` **does not exist**. The actual union audit table is `public.union_wallet_transactions` (found via `\dt union*`).

Every attempt to run `fn_union_send_chips_to_club` raised PostgreSQL 42P01, rolling back the entire transaction (debit + credit + audit). Net result: zero chips ever moved across the union → club boundary in production.

## Fix

`supabase/migrations/20260415_fix_union_send_chips_to_club_bug011.sql` — applied live via Supabase MCP in the same session.

Swapped the broken INSERT for the correct table + column shape:

```sql
INSERT INTO public.union_wallet_transactions (
  union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes
) VALUES (
  p_union_id, 'main', 'debit', p_amount, v_union_balance - p_amount, 'send_to_club',
  p_club_id, COALESCE(p_notes, 'Union chip distribution')
);
```

The debit/credit/lock logic was already sound (SELECT FOR UPDATE on union_wallets, balance check, atomic update of both sides) — only the audit write failed, taking the whole transaction with it.

## Verification queued

Next time a union owner sends chips to a member club:

1. `SELECT COUNT(*) FROM union_wallet_transactions WHERE tx_type='send_to_club';` should grow.
2. `union_wallets.chip_balance` should drop by exactly the sent amount.
3. `club_members.chip_balance` (for the club owner) should rise by the same amount.
4. All three in a single transaction (all-or-nothing).

## Related

- BUG 010 — `fn_clawback_chips_atomic` stub (identical "audit table missing" signature)
- BUG 008 — rakeback settler missing
- BUG 009 — agent commission never credited
- Phase D signoff — claimed this feature as "Union shared chip pool" working; that claim now holds

## Lesson

**Fourth silent-failure bug in a row.** All four caught within one verification session. The common thread: every signoff-listed feature had code, DB tables, RPC definitions, UI pages — but the actual data path was interrupted at one specific spot and never exercised end-to-end. Bug 010 and Bug 011 both have the identical pattern: RPC inserts into a table that doesn't exist, everything rolls back, client never sees the actual failure because the UI layer above treats RPC-level errors as generic failures.

**Systemic recommendation:** a future migration should add a test harness that runs `SELECT fn_*()` against all SECURITY DEFINER RPCs with sentinel inputs + asserts data actually moved. Any future RPC that targets a non-existent table fails in CI before shipping.
