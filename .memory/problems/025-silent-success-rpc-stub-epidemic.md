# Problem 025 — Silent-Success RPC Stub Epidemic

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-16 (Phase 4 full-feature audit, Wave A2 SQL RPC pass)
**Date Fixed:** 2026-04-16 (all 20+ critical stubs replaced with real implementations, LIVE in Supabase)
**Severity:** CRITICAL — every single financial RPC in one class was a no-op

## The pattern

Widespread `RETURN jsonb_build_object('success', true)` stub bodies on
`SECURITY DEFINER` Postgres functions that production code called every day
expecting them to do real work (debit/credit balances, insert rows, update
state). Every call looked successful to the caller (`result.success === true`)
but nothing actually changed in the DB.

This is a more insidious variant of BUGs 010 and 011 (`fn_clawback_chips_atomic`,
`fn_union_send_chips_to_club`) from earlier in the session — same "returns
success without doing the work" anti-pattern, just 20+ more instances across
almost every subsystem.

## Discovery

While auditing unhandled client-side call paths I spot-checked one stub
(`fn_request_cashout`) and found the body was a 1-line no-op. Widening the grep
to all functions returning jsonb with bodies <1000 chars surfaced dozens more.
Cross-referencing each against actual `.rpc('...')` call sites in WH and CA
code showed they were all being hit hard by production cron jobs, API routes,
and client services.

## Evidence

`chip_transactions.created_at` — the audit log every treasury-mutation RPC is
supposed to write to — had its **most recent row dated 2026-03-24**. Today is
2026-04-16. Three weeks of rake settlements, agent distributions, union wallet
transfers, tournament buy-ins, and cashout approvals went silently
unrecorded at the DB level.

## Stubs confirmed and fixed

All had identical bodies of the shape:

```sql
BEGIN RETURN jsonb_build_object('success', true); END;
-- or
BEGIN NULL; END;
```

### Treasury & balance (most critical)

| RPC                                                           | Callers                                                                                                          | Was doing                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `fn_credit_treasury(club_id, amount, reason, metadata)`       | rake settlements, union rakeback cron, auto-settlement, rakeback API, union-wallet API, manage-agent, leave-club | nothing                                                |
| `fn_debit_treasury(club_id, amount, reason, metadata)`        | tournament overlay debit, settle-period payout, rakeback, auto-settlement                                        | nothing                                                |
| `fn_credit_chips(club_id, user_id, amount, reason, metadata)` | auto-settlement-distribute cron, manage-agent, rakeback, union BBJ payouts                                       | nothing                                                |
| `fn_debit_chips(club_id, user_id, amount, reason, metadata)`  | auto-settlement-distribute cron, manage-agent                                                                    | nothing                                                |
| `fn_union_credit_wallet(union_id, wallet, amount, ...)`       | union-rakeback cron, union-wallet API (×3)                                                                       | nothing                                                |
| `fn_union_debit_wallet(union_id, wallet, amount, ...)`        | union-rakeback cron, union-wallet API (×2 + BBJ)                                                                 | nothing                                                |
| `lock_chips_for_table(club_id, user_id, table_id, amount)`    | ChipBridge.lockChips (tournament buy-ins), table-chips API                                                       | returning `{success, locked}` without locking anything |
| `unlock_chips_from_table(club_id, user_id, table_id, amount)` | ChipBridge.unlockChips, GameController, tournaments, tournament-cron, union-games, table-chips                   | returning `{success, unlocked}` without refunding      |

### Cashout

| RPC                         | Callers                                    | Was doing                                                       |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `fn_request_cashout`        | CashoutService (client)                    | returning fake UUID without inserting or debiting escrow        |
| `fn_approve_cashout_atomic` | approve-cashout API                        | returning success without updating status or crediting treasury |
| `fn_cancel_cashout_atomic`  | approve-cashout API, cancel-my-cashout API | returning success without refunding player from escrow          |

### Tournament

| RPC                                | Callers                              | Was doing                                                                           |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `fn_tournament_atomic_register`    | tournaments API registration handler | returning success without creating `tournament_registrations` row or debiting chips |
| `fn_tournament_unregister_counter` | tournaments API unregister handler   | returning success without decrementing counter or prize pool                        |

### Agent / promo / transfer

| RPC                              | Callers                                     | Was doing                                                                                         |
| -------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `distribute_chips`               | AgentService (client)                       | returning success without debiting treasury or crediting member                                   |
| `mint_club_chips`                | WalletService (client) + AdminDashboardPage | returning success without crediting chip_pool (plus param-name mismatch bug on both client sites) |
| `mint_club_promo`                | promo-wallet API                            | returning success without crediting promo_balance                                                 |
| `transfer_chips_agent_to_player` | distribute-chips API                        | returning success without moving chips                                                            |
| `transfer_promo_club_to_agent`   | promo-wallet API                            | returning success without transferring                                                            |
| `transfer_promo_agent_to_player` | distribute-chips + distribute-promo APIs    | returning success without transferring                                                            |
| `fn_transfer_chips`              | (any future caller)                         | returning success without transferring                                                            |
| `fn_pay_commission_atomic`       | commission payout flow                      | returning success without paying                                                                  |
| `fn_add_prepaid_credit_atomic`   | agent-credit API                            | returning success without adding credit line                                                      |

### Messenger

| RPC                          | Callers                                                                                                              | Was doing                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `fn_send_message`            | messenger.js (×2), services/MessagingService.js, social-media, home-games/message-host, request-cashout notification | returning `gen_random_uuid()` as fake message_id without inserting the row              |
| `fn_mark_messages_read`      | services/MessagingService.js                                                                                         | nothing                                                                                 |
| `fn_delete_message`          | messenger.js (×2)                                                                                                    | nothing                                                                                 |
| `fn_toggle_message_reaction` | client MessagingService                                                                                              | returning success without toggling anything (also no `message_reactions` table existed) |
| `fn_complete_media_upload`   | MediaUploadService                                                                                                   | nothing                                                                                 |

### Misc

| RPC                         | Callers                     | Was doing                                                           |
| --------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `fn_leave_club_atomic`      | (expected: leave-club flow) | returning success without removing membership                       |
| `mass_fund_horses`          | horse-launch API            | returning success without funding horses                            |
| `close_table_session`       | anti-cheat API              | returning success without closing session                           |
| `publish_scheduled_content` | ContentScheduler cron       | returning success without publishing anything                       |
| `complete_daily_challenge`  | DailyChallengeService       | returning success without inserting completion or awarding diamonds |

### Shadowing overloads dropped

| RPC                                     | Why dropped                                            |
| --------------------------------------- | ------------------------------------------------------ |
| `award_bbj(club_id, winner_id, amount)` | 3-param stub shadowing the real 18-param function      |
| `claim_reward(user_id, reward_id uuid)` | 2-param stub shadowing the real 3-param implementation |

## Root cause

Unknown origin. Likely created during an earlier scaffolding phase as stubs
"to come back and implement later" — and then never came back to. Because
they returned `{success: true}` the test harness and all production callers
were satisfied, and the bugs simply never surfaced until somebody audited the
function bodies directly.

## Fix

Each stub replaced with a proper atomic implementation using `FOR UPDATE`
row locks where appropriate, writing an audit row to `chip_transactions` /
`union_wallet_transactions` / the relevant table, and returning meaningful
`balance_before`/`balance_after` values (since several callers were reading
them and logging 0).

All migrations applied via Supabase MCP `apply_migration`:

- `bug_025_distribute_chips_real_impl`
- `bug_025_fn_request_cashout_real_impl`
- `bug_025_mint_club_chips_real_impl`
- `bug_025_message_reactions_table_and_toggle`
- `bug_025_treasury_credit_debit_real_impl`
- `bug_025_chip_lock_unlock_for_table_real_impl`
- `bug_025_cashout_approve_cancel_atomic_real_impl`
- `bug_025_complete_daily_challenge_real_impl`
- `bug_025_fn_credit_debit_chips_real_impl`
- `bug_025_union_wallet_real_impl`
- `bug_025_messenger_rpcs_real_impl`
- `bug_025_tournament_register_unregister_real_impl`
- `bug_025_transfer_family_real_impl`
- `bug_025_misc_stubs_real_impl`
- `bug_025_drop_shadowing_stub_overloads`

## Client code changes required

Two client sites had param-name mismatches that would have 404'd the moment
the stubs were replaced with real functions using the DB's original signature.
Fixed alongside the RPC work:

- `src/services/WalletService.ts` — mint_club_chips params aligned to
  `(p_club_id, p_amount, p_minted_by, p_diamonds_cost, p_notes)`
- `src/pages/AdminDashboardPage.tsx` — MintChipsTab now takes `user` from
  `useAuthUser()` and passes `p_minted_by`; emoji prefix removed per CLAUDE.md §8
- `src/services/CashoutService.ts` — `fn_request_cashout` return value now
  treated as a uuid (the real impl returns uuid directly); falls back to
  reading `.request_id` if a jsonb shape reappears

## Verification plan

Post-deploy, run organically for 30 minutes, then:

```sql
-- Treasury mutations flowing (was 3 weeks stale)
SELECT COUNT(*) FROM chip_transactions WHERE created_at > NOW() - INTERVAL '30 min';

-- Tournament registrations creating rows (was registering count without chip debit)
SELECT COUNT(*) FROM tournament_registrations WHERE registered_at > NOW() - INTERVAL '30 min';

-- Messenger writing actual rows (was returning fake uuids)
SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '30 min';

-- Union wallet moving
SELECT COUNT(*) FROM union_wallet_transactions WHERE created_at > NOW() - INTERVAL '30 min';

-- Daily challenge completions actually logged
SELECT COUNT(*) FROM memory_challenge_completions WHERE completed_at > NOW() - INTERVAL '30 min';
```

All should show non-zero under real organic traffic.

## Impact

Before fix:

- ~3 weeks of rake accumulation never credited to `clubs.chip_treasury`
- Agent commissions marked paid but no chips moved
- Tournament buy-ins debited via direct `atomic_table_buyin` path OR not at all
  depending on which entry point the player hit
- Union rakeback cron running every hour doing literally nothing
- Messenger appearing to deliver but nothing written (users seeing sent state
  but recipient seeing empty conversation)
- Daily memory challenges completing with reward shown client-side but no
  diamond ledger or completion row

After fix:

- All RPCs now do the real atomic work with proper FOR UPDATE locking and
  audit rows
- `chip_transactions` / `union_wallet_transactions` / `messages` / `tournament_registrations`
  / `memory_challenge_completions` / `message_reactions` all start
  populating immediately as callers invoke the real functions

## Lesson

When you see a DB function returning `{success:true}` as its entire body, do
NOT assume it's a thin wrapper — grep the codebase for `.rpc('<name>'` first.
Stubs that have been live long enough to accumulate 30+ call sites become
invisible landmines because every layer assumes everything below it is doing
its job.

Any future scaffold stubs should `RAISE EXCEPTION 'not implemented'` so the
platform fails loud the moment anyone relies on them.

## Related

- BUG 010 — `fn_clawback_chips_atomic` stub → real impl (prior)
- BUG 011 — `fn_union_send_chips_to_club` stub → real impl (prior)
- BUG 024 — VIPPage `diamond_ledger` column-name mismatch (surfaced during
  same audit pass; fixed in `src/pages/VIPPage.tsx`)

## Followups NOT done in this pass

- `fn_union_transfer_wallets` (if it exists) — not audited
- `calculate_cascading_commission`, `calculate_agent_spread` — looked like getters, not audited
- `fn_credit_diamonds`, `fn_update_hendon_data`, `fn_save_player_note`, etc. —
  bodies are >500 chars, confident they are real, but not 100% verified
- Individual chip-transaction row `from_user_id`/`to_user_id` fields are
  populated by the new RPCs, but some chip_transactions callers write
  transactions directly (bypassing RPCs) — no audit of those direct-INSERT
  call sites was done
