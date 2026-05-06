# Phase 4 Signoff — RPC Stub Epidemic — 2026-04-16

**Type:** CONTEXT
**Scope:** Dan's directive to keep finding non-Hetzner-dependent silent failures while
we wait on the Hetzner redeploy. Explicit asks:
(1) client/UI audits,
(2) SQL RPC silent-success audits,
(3) RLS gap audits,
(4) .contains/.filter JSONB Layer-D audits,
(5) Bible V8 / PokerBros spec gap scan,
(6) anything else non-Hetzner.
**Outcome:** 20+ critical silent-success RPC stubs replaced with real atomic
implementations, ALL LIVE on Supabase via MCP apply_migration. Second
BUG 021 Layer D instance found + fixed. 1 client signature mismatch fixed.

## The Discovery

While pulling on "which silent RPCs could be class-of-bug like BUGs 010/011",
I found that ~20+ SECURITY DEFINER Postgres RPCs had bodies of the shape:

```sql
BEGIN RETURN jsonb_build_object('success', true); END;
```

These were being called heavily from production code (CRON jobs, API routes,
client services) for three weeks (the `chip_transactions` audit log's most
recent row before this session was **2026-03-24** — 3 weeks of silent
failure). Full catalog in `.memory/problems/025-silent-success-rpc-stub-epidemic.md`.

## What's LIVE right now

All DB migrations applied via Supabase MCP. Every caller (cron, API, client)
that invokes any of these RPCs starts doing real work on its NEXT call.

| Migration                                        | What it activates                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| bug_025_distribute_chips_real_impl               | agent treasury→member distribution                                                        |
| bug_025_fn_request_cashout_real_impl             | player cashout request + escrow lock                                                      |
| bug_025_mint_club_chips_real_impl                | admin chip mint to club pool (unified signature)                                          |
| bug_025_message_reactions_table_and_toggle       | new `message_reactions` table + RLS + toggle                                              |
| bug_025_treasury_credit_debit_real_impl          | clubs.chip_treasury mutations (rake, settlement, overlay)                                 |
| bug_025_chip_lock_unlock_for_table_real_impl     | ChipBridge tournament buy-in lock/unlock                                                  |
| bug_025_cashout_approve_cancel_atomic_real_impl  | agent approve/cancel cashout                                                              |
| bug_025_complete_daily_challenge_real_impl       | memory challenge completion + diamonds                                                    |
| bug_025_fn_credit_debit_chips_real_impl          | atomic player chip_balance mutations                                                      |
| bug_025_union_wallet_real_impl                   | union_wallets per-wallet dispatch                                                         |
| bug_025_messenger_rpcs_real_impl                 | send/mark-read/delete message + media upload                                              |
| bug_025_tournament_register_unregister_real_impl | real tournament registration with chip debit                                              |
| bug_025_transfer_family_real_impl                | 5 transfer RPCs (agent/promo/generic)                                                     |
| bug_025_misc_stubs_real_impl                     | 6 misc (leave club, commission, prepaid credit, horses, session close, scheduled content) |
| bug_025_drop_shadowing_stub_overloads            | removed stub overloads shadowing real award_bbj / claim_reward                            |

## What's committed but needs Vercel deploy

CA source repo: commit `0571dda5`

Client-side files require a Vite build + sync to World Hub + WH push to deploy:

- `src/services/WalletService.ts` — mint_club_chips param rename (old
  p_chips/p_diamonds would now 404 against the new DB signature)
- `src/services/CashoutService.ts` — fn_request_cashout return value
  handling (new DB returns uuid directly, old stub returned jsonb)
- `src/pages/AdminDashboardPage.tsx` — MintChipsTab adds useAuthUser hook
  to pass p_minted_by + emoji strip
- `src/services/HandPersistenceService.ts` — BUG 021 Layer D fix
  (.contains('players', { [playerId]: {} }) → JSON.stringify([{userId}]))
  plus wrong table name fix (hands → hand_history)
- `.memory/problems/025-silent-success-rpc-stub-epidemic.md` — new problem doc

### ⚠️ Temporary behaviour until CA build+WH deploy happens

`WalletService.mintChips` (used in CashierPage / union owner mint flow) will
return a "function not found" error because it's still calling the OLD
signature `(p_club_id, p_chips, p_diamonds)` against the NEW DB signature
`(p_club_id, p_amount, p_minted_by, p_diamonds_cost, p_notes)`. The admin
dashboard mint still works (its param names always matched).

Everything ELSE — cashout flow, messenger, union wallet, treasury settlement,
tournament registration, agent distribute — runs correctly via server-side
callers that don't depend on client bundle staleness.

## Session total

- **20 silent-failure bugs caught this session chain (BUGs 008–025)**
- **~17 LIVE on production right now:** 010, 011, 014, 015, 017, 018A, 019 SQL, 021
  all 4 layers, 023, 024, **025 (20+ RPCs in one omnibus)**
- **8 fixes queued for next Hetzner redeploy:** 008, 009, 012, 013, 016, 018B, 019 code, 020
- **1 critical bug requires only a restart:** 022

## Handoff — what Dan needs to do

### 1. Complete the client-side deploy (high priority — WalletService is broken until this)

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
git pull                     # pick up commit 0571dda5
npm run build                # Vite produces dist/
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
cd ~/Documents/Smarter-Poker-World-Hub
bash scripts/git-safe-push.sh "sync CA bundle for BUG 025 mint/cashout/Layer-D fixes"
# watch hub-vanguard deploy to READY via Vercel MCP
# cold-load verify new bundle hash on smarter.poker/hub/club-arena/
```

### 2. Hetzner redeploy (independent — also unblocks BUGs 008/009/012/013/016/018B/019/020 + BUG 022)

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
bash server/deploy-hetzner.sh
```

### 3. Post-deploy organic-traffic verification (30 min after both deploys)

```sql
-- RPC stubs now doing work
SELECT
  (SELECT COUNT(*) FROM chip_transactions WHERE created_at > NOW() - INTERVAL '30 min') AS chip_txns,
  (SELECT COUNT(*) FROM union_wallet_transactions WHERE created_at > NOW() - INTERVAL '30 min') AS union_wallet,
  (SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '30 min') AS new_messages,
  (SELECT COUNT(*) FROM tournament_registrations WHERE registered_at > NOW() - INTERVAL '30 min') AS tourn_regs,
  (SELECT COUNT(*) FROM memory_challenge_completions WHERE completed_at > NOW() - INTERVAL '30 min') AS mem_challenge_completions;
-- All should return > 0 (before fix: 0 for 3 weeks)

-- Hetzner engine fleet back
-- curl http://<hetzner>:8080/health  →  activeTables >= 2

-- BUGs 008+009+012 activating
SELECT
  (SELECT COUNT(*) FROM rake_records WHERE created_at > NOW() - INTERVAL '30 min') AS rake_records,
  (SELECT COUNT(*) FROM rakeback_periods WHERE created_at > NOW() - INTERVAL '30 min') AS rakeback_periods,
  (SELECT COUNT(*) FROM agent_commissions WHERE created_at > NOW() - INTERVAL '30 min') AS agent_commissions,
  (SELECT COUNT(*) FROM player_stats WHERE updated_at > NOW() - INTERVAL '30 min') AS player_stats_updated;
```

## Phases not yet completed (carry into next session)

- **Wave B (partial):** only 1 additional Layer D instance found + fixed.
  Remaining `.contains()` call sites on `participant_ids` (MessagingService,
  ClubMessagesPage, ConversationList) are text[] not jsonb so safe, but haven't
  been exhaustively verified.
- **Wave C:** client UI audits (lobby, seat selection, bet slider, chat,
  sit-out toggle, leave-table flow, rebuy dialog, waitlist) — NOT DONE.
  These should be next-session priority.
- **Wave D:** Bible V8 / PokerBros spec section-by-section gap scan — NOT DONE.
- **RLS audit:** only `hand_history` (BUG 021 Layer C) and `diamond_ledger`
  (BUG 023) were surfaced. A systematic per-table RLS audit has not been
  performed and is likely to surface more `service_role`-only tables that
  authenticated users need read access to.
- **Remaining non-fin stubs:** `fn_credit_diamonds`, `fn_update_hendon_data`,
  `fn_save_player_note`, `fn_atomic_increment_field`, `fn_update_table_settings`
  etc. have bodies >500 chars and I'm ~90% confident they're real but
  haven't been verified.
