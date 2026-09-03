# Secondary Phantom-Reference Sweep — 2026-07-23

Systematic sweep: extracted every `.from('table')` and `.rpc('fn')` in `src/`
(127 tables, 105 RPCs referenced) and diffed against the live DB
(`information_schema.tables` / `pg_proc`). Result: **41 phantom tables, 17
phantom RPCs**. Each was triaged as real-breakage-fixed, dead-code-removed, or
unbuilt-feature (degrades gracefully).

## FIXED + DEPLOYED (production `smarter.poker` @ 0e266375, migrations applied)

### Phantom → real repoints (client)

- `PlayerNotesService.getNote/saveNote`: `fn_get_player_note` / `fn_save_player_note`
  (never existed) → direct `player_notes` table access (self-owned, full RLS).
  Added label↔hex color mapping.
- `ReportReviewPage`: `player_reports` table (never existed) + broken `user_reports`
  RLS (admins couldn't read/update) → new SECURITY DEFINER RPCs
  `fn_list_player_reports` / `fn_action_player_report`, scoped so a club
  owner/admin may moderate reports whose reported player is a member of a club
  they administer. Added `user_reports.admin_notes` + `fn_caller_can_moderate_user`.
- `PermissionService`: `union_members` → `union_clubs` (club↔union link).
- `TablePage` observer-chat perm: `union_members` → `unions.owner_id` + `union_admins`.
- `ClubMessagingPermissions`: union role via `union_clubs` + `unions` + `union_admins`.
- `GlobalWaitlistListener`: `waitlist_entries` → `table_waitlist`, `poker_tables` → `tables`.

### Money RPCs created (verified LIVE-BREAKAGE by call-site tracing)

- `atomic_table_rebuy(user,table,amount)` — cash-game bust rebuy (TablePage
  BuyInModal). Mirror of `atomic_table_addon`: wallet → seat stack, guard-whitelisted.
- `deduct_table_chip_lock(user,table,amount)` — dealer tip: player seat stack →
  club treasury (chip-conserving). TipDealer modal.
- `process_tournament_rebuy(tourney,user,type,cost,chips,level)` — rebuy/reentry/addon;
  wallet deduct + `tournament_players` update + history. Added to
  `guard_wallet_balance_write` whitelist.
- `credit_assignments` table backfilled (fn_admin_update_agent INSERTs into it;
  it was missing → every credit-limit change rolled back).

### Dead code removed

- `src/engines/RakeWaterfallEngine.ts` (+ `engines/index.ts`): called non-existent
  `execute_pot_drops`; never imported. Rake is collected server-side into `rake_history`.
- `WalletService.processInsurance`: zero call sites; insurance settled server-side.

### Confirmed OK, no action

- `verify_ledger_totals` (ChipFlowService): has a working paginated client-side
  fallback; admin/cron-only. Optional future RPC for perf.

## REMAINING — unbuilt feature clusters (degrade gracefully; NOT regressions)

All wrap their phantom query in try/catch → empty state + errorReporter log; none
white-screen. These are product features never built server-side. Each needs a
build-vs-hide decision (surfaced to Dan), not a silent fix:

- **Player stats subsystem**: `player_position_stats`, `player_sessions`,
  `session_history`, `preflop_ranges`, RPCs `bulk_update_position_stats`,
  `bulk_add_vip_points` (PlayerStatsPage, stats/\* components, PlayerPositionStatsService).
- **GTO**: `gto_solutions`, `gto_solve_queue` (GTOQueryService).
- **Flash pools**: `flash_pools` + RPC `join_flash_pool` (FlashPoolPage).
- **Referrals**: `referral_codes`, `referral_redemptions` + RPC `redeem_referral_code`.
- **Bonuses / lucky wheel**: `special_bonuses`, `user_bonuses`, `user_daily_rewards`,
  `user_lucky_wheel_spins` + RPCs `claim_lucky_wheel_spin`, `increment_bonus_progress`.
- **Arena training**: `arena_sessions` + RPC `record_arena_session`.
- **Challenges**: `club_challenges`, `friend_challenges`.
- **Promotions**: `promotion_claims`, `promotion_leaderboards` + RPC
  `increment_promotion_claim_count`.
- **Anti-cheat detection**: RPCs `detect_collusion_pairs`, `detect_suspicious_plays`.
- **Feature purchases**: `feature_purchases` + RPC `fn_purchase_feature` (VIPService).
- **Throwables**: `throw_usage`.
- **Messaging extras**: `message_read_receipts`, `scheduled_messages`, `invites`,
  RPC `get_message_reactions`.
- **Misc single-file**: `announcements`, `clawback_audit_log`, `club_activity`,
  `club_daily_stats`, `club_invites`, `hand_results`, `members`, `user_feedback`,
  `user_presence`.

## REMAINING — financial dashboards (real repoint candidates, higher risk)

These reference phantom tables but real equivalents exist; repointing needs
careful column mapping (deferred — needs verification, not guessing):

- `agent_settlements` / `club_settlements` → `settlement_periods` + `settlement_invoices`
  (SettlementService, FinancialExportService, SettlementDashboard/HistoryPage).
- `commission_ledger` / `commission_payouts` / `commission_structures` →
  `commission_records` / `agent_commissions` (CommissionService, AgentFinancialPortal).
- `credit_requests` → likely `credit_invoices` or a new table (CreditService,
  CreditRequestService) — needs product decision.

## Methodology (reusable)

```
grep -rhoE "\.from\(\s*'[a-z_]+'"  src → distinct tables
grep -rhoE "\.rpc\(\s*'[a-z_]+'"   src → distinct rpcs
diff against information_schema.tables / pg_proc → phantom list
grep -rl each phantom → owning files → triage live/dead
```
