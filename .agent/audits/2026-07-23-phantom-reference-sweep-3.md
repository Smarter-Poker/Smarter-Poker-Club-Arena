# Phantom-Reference Sweep #3 — 2026-07-23

Continuation of sweep #2 (`2026-07-23-phantom-reference-sweep-2.md`). That audit
left two buckets: (1) financial dashboards pointing at phantom tables with real
equivalents, and (2) "unbuilt feature clusters." Dan's call: repoint the
dashboards, build the clusters out rather than hide them. This sweep did both —
with one refinement: a full reachability pass showed **over half the phantom
call sites live in dead code** (never-imported components/services), so backends
were built only for the ~30 call sites reachable from routed UI. Dead clusters
are catalogued below for a revive-vs-delete decision instead of getting tables
nothing can ever query.

## A. Financial dashboards — repointed to real tables (DEPLOYED to DB; client on main)

DB (production, Supabase MCP migrations `ca_sweep3*`):

- `generate_period_settlements(p_period_id)` — was a not_implemented stub; now a
  real SECURITY DEFINER read model over settlement_periods, rake_records (+
  pre-overlap rake_history), bbj_contributions, agent_commissions,
  rakeback_periods, settlement_invoices. Returns the full camelCase
  SettlementSummary. Handles per-club AND global (club_id NULL) periods.
- `calculate_agent_settlement(p_period_id, p_agent_id)` — real impl over agents
  - agent_commissions (the live per-hand commission ledger written by the
    engine RakebackSettler).
- `calculate_agent_spread(p_agent_id, p_period_id)` — real impl: own earnings
  (window) as netMargin, sub-agent earnings as payoutToDownlines, downline
  breakdown from sub_agents (+profiles names).
- `get_current_settlement_period()` — fixed get-or-create INSERT that omitted
  NOT NULL period_number/year (would have raised once no period was open).

Client (commit `a72ebaf4` on main, via PR #19 squash):

- SettlementService.getClubReport/getAgentReport → the read-model RPCs (off
  phantom club_settlements/agent_settlements).
- SettlementDashboardPage → RPC agentSettlements; RT sub agent_settlements →
  agent_commissions INSERT.
- SettlementHistoryPage → settlement_invoices (gross_amount / breakdown.
  union_hold_amount / breakdown.club_retained); RT likewise.
- SettlementPage → RT club_settlements → settlement_invoices (net_amount,
  status 'paid'); agent_settlements → agent_commissions INSERT → debounced
  reload via existing BALANCE_UPDATED listener.
- CommissionService — rates now live on agents (write via fn_admin_update_agent;
  direct agents writes are RLS-locked), sub_agents for SUB_AGENT (read-only
  client-side); history/executePayout post-read → agent_commissions;
  approvePayout retired (no-op, commission_payouts approval concept removed).
- FinancialExportService — club/agent/commission exports → settlement_invoices /
  agent_commissions; **bug fix:** fetchSettlementInvoices was querying
  settlement_invoices with credit_invoices' exact column list → repointed to
  credit_invoices.
- AgentPortalPage — commission_ledger → agent_commissions (keyed by auth
  user_id, not agents.id PK), query + RT filter.

### Key data-model discoveries (important for future work)

1. **agent_commissions is the live commission ledger** (49.8k rows, written
   per-hand by RakebackSettler; keyed by user_id+club_id). commission_history /
   commission_records exist but are EMPTY.
2. **rake_history is dead since 2026-05-01; rake_records is the live rake
   store.** They overlap (double-written) 2026-04-16→05-01, so any period math
   must take rake_records in-window + rake_history in-window _before
   rake_records' first row_ (implemented in generate_period_settlements and the
   club_daily_stats view).
3. **The open settlement period was stale** (Apr 20–27, never rolled after the
   client-side SettlementCron stopped running). Closed it (status=settled +
   notes) and let get_current_settlement_period create the live weekly global
   period. NOTE: periods only roll when something calls
   get_current_settlement_period after week end — consider a pg_cron roll job.

## B. Feature backends built (reachable clusters) — migration `20260723_sweep3_feature_backends.sql`

| Feature                   | What was broken                                                                                                                                      | What exists now                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session history/stats     | SessionStatsService inserted every session into phantom session_history → 3 retries → silently dropped; SessionHistoryPage error-toasted every visit | `session_history` table (writer schema + generated session_start/session_end reader aliases), RLS (own + club admins), realtime; `player_sessions` compat VIEW                                                                                                       |
| Position stats            | player_position_stats phantom; radar/win-rates/pie/admin analytics empty                                                                             | Table + hand_history AFTER INSERT trigger deriving VPIP/PFR/3-bet/wins/profit from players/actions/winners jsonb (position inferred from preflop action order — documented heuristic); pg_cron batched backfill `pps-backfill` over all 73k hands (self-unschedules) |
| Referrals                 | Codes/redemptions phantom; redeem RPC missing; **client-side add_chips milestone landmine**                                                          | referral_codes / referral_redemptions / referral_milestone_claims + `redeem_referral_code` (250/250 both sides, server-credited, one-per-referee) + `fn_claim_referral_milestone` (DB-deduped); ReferralService.checkMilestones repointed to the RPC                 |
| Feature purchases         | fn_purchase_feature missing; client sends no cost ("would default to 0 = free")                                                                      | RPC prices SERVER-SIDE from feature_pricing (p_cost ignored), debits via deduct_diamonds (idempotent), records feature_purchases                                                                                                                                     |
| VIP throwables            | Every VIP throw failed ("Failed to record throw usage")                                                                                              | throw_usage table; flow works end-to-end now                                                                                                                                                                                                                         |
| Agent invite codes        | Always failed                                                                                                                                        | club_invites table + RLS                                                                                                                                                                                                                                             |
| User feedback             | Shown "Feedback sent!" while dropped                                                                                                                 | user_feedback table                                                                                                                                                                                                                                                  |
| Promotions                | Claim button raw-errored; leaderboards empty                                                                                                         | promotion_claims (unique per promo+user) + promotion_leaderboards + increment_promotion_claim_count (derived count)                                                                                                                                                  |
| Friend challenges         | Send button raw-errored                                                                                                                              | friend_challenges table                                                                                                                                                                                                                                              |
| Anti-cheat                | detect_collusion_pairs / detect_suspicious_plays missing (page otherwise real)                                                                       | Both RPCs implemented: collusion over live collusion_tracking (37.5k engine-scanned rows; 206 pairs ≥0.75 for SHARK CLUB), suspicious plays = big-pot heuristic over hand_history. Club-admin gated                                                                  |
| Wheel/bonus read surfaces | GamificationLeaderboard threw on every Profile view                                                                                                  | user_lucky_wheel_spins / user_daily_rewards / user_bonuses / special_bonuses tables (read paths clean; WRITE flows are dead code — see below)                                                                                                                        |
| Flash pools               | Page error-toasted on load                                                                                                                           | flash_pools table (empty). **join_flash_pool deliberately NOT built** — it must seat the player via the engine before debiting; money+engine work                                                                                                                    |
| Club daily stats          | Cards showed 0 forever                                                                                                                               | club_daily_stats VIEW over rake_records/rake_history                                                                                                                                                                                                                 |

Client edit shipped with this sweep: `ReferralService.checkMilestones` no longer
calls `add_chips` (which is service_role-only anyway) — server RPC instead.
CI: `player_sessions` + `club_daily_stats` added to check-phantom-tables
allowlist (they're VIEWS; the scanner only parses CREATE TABLE).

## C. Dead code catalogue — revive-vs-delete decisions for Dan (NOT built)

These phantom references live in code that cannot execute (no importer/route/caller):

- **GTO cluster** (GTOQueryService: gto_solutions, gto_solve_queue, preflop_ranges)
  — fetchGtoAdvice defined but never invoked in TablePage; vestigial advisor UI.
  Live analogs exist if revived: solved_spots_gold / solver_queue / gto_scenarios.
- **Arena training** (ArenaTrainingController + useArenaStore arena actions;
  arena_sessions, record_arena_session) — no page renders it. Live analog:
  training_sessions.
- **Messaging extras** — entire src/components/messaging/ tree has zero external
  importers; message_read_receipts→social_message_reads, scheduled_messages→
  messenger_scheduled, get_message_reactions→message_reactions are ready live
  backends if revived.
- **BonusService (all 9 phantom sites incl. claim_lucky_wheel_spin,
  increment_bonus_progress)** — imported but no method ever called;
  LuckyDrawWheel.tsx never imported. The wheel/bonus WRITE flows need a real
  server RNG + crediting RPC before revival (BonusPage's local claim credits
  nothing by design — left with no UPDATE policy so it can't silently "claim").
- **PositionStatsPopup, PlayerPositionStatsService (bulk_update_position_stats,
  bulk_add_vip_points)** — unused imports in TablePage; superseded by the
  server-side trigger pipeline built in this sweep.
- **club_challenges** (ClubsService.getClubChallenges) — zero callers.
- **user_presence** (social/PresenceIndicator) — unused import; profiles.is_online
  fallback is the live path. presence/OnlinePlayersList also importerless.
- **hand_results** (HorseOrchestrator.trackHorsePerformance) — orchestrator loop
  never launched; legacy client-side horse code per MIGRATION-LAW.
- **clawback_audit_log** (AgentAnalyticsDashboard) — query result set but never
  rendered; metrics already derived from chip_transactions.clawed_back.
- **club_activity** (ClubActivityFeed) — reachable but handles the missing table
  explicitly (console.debug only); needs an event producer to be worth building.
- **invites analytics** (MessagingService.getInviteAnalytics) — zero callers;
  club_invites (new) is the canonical invite store if revived.
- **ClubDetailPage.tsx** — unrouted page (dead).

## D. Deploy status & follow-ups

- DB: all migrations LIVE in production Supabase (kuklfnapbkmacvwxktbh).
- Client: commits `a72ebaf4` + this sweep's commit on GitHub main. **Vercel git
  auto-deploy is disabled for club-arena** (vercel.json git.deploymentEnabled=
  false; project deployed via `./deploy-production.sh` CLI from the workstation)
  — run it to ship the client half.
- Local checkout on the Mac is ~20 commits behind origin/main — `git pull`.
- pps-backfill cron: check `select * from _pps_backfill_state` — done=true and
  ~73k processed expected within ~25 min of 18:25Z; job self-unschedules.
- Settlement periods now roll only on get_current_settlement_period calls;
  consider a weekly pg_cron `select public.get_current_settlement_period()`.
- Position-stat numbers are heuristic (preflop-order positions; per-street
  max-to-match contribution model) — good for trends, not audit-grade.

## E. Post-deploy verification addendum (same day, second pass)

Full verify-before-claiming-success pass. Results:

**Published to production (verified end-to-end).** Both CA pushes triggered the
`build-for-world-hub.yml` workflow (on: push to main) — GitHub runners compiled
the Vite bundle (build passing = the code compiles), rsynced dist into WH
`public/hub/club-arena/`, and pushed (WH commits `dd436b1b`, `477d92bf`).
hub-vanguard auto-deployed both; latest production deployment
`dpl_9QxerxcXakvH1kqdkvLAFeQJZmEL` (18:33:29Z) is READY on the a49e9ec1 build,
and production serves the new `index-C0JP5pqO-v6.js` bundle. No manual deploy
needed — the pipeline was already automated.

**Hetzner: nothing to sync, by design.** No server/\*\* files changed in either
commit, so `auto-deploy-hetzner.yml` correctly did not fire. Engine health
verified live: running:true, 35 active tables, 28 tournaments, hands flowing
throughout (hand inserts unaffected by the new trigger; zero trigger warnings
in postgres logs).

**Money paths tested against production logic (rolled-back transactions):**
referral redeem 250/250 both wallets + double-redeem blocked; milestone
validation (not-reached / unknown) correct; fn_purchase_feature server-priced
1 diamond (300→299), purchase row recorded, unknown feature rejected;
session_history insert + reader aliases + player_sessions view + RLS
(stranger sees 0, club owner sees club sessions) all correct.

**Defects found by verification and fixed:**

1. First backfill runner had no concurrency lock and non-tie-safe pagination →
   truncated player_position_stats and re-ran cleanly with an advisory lock +
   keyset (created_at, id) pagination (migration
   `20260723_sweep3_backfill_lock_keyset_v2.sql`).
2. hand_history is actually 5M+ rows (the 73k figure was a stale planner
   estimate); hands before 2026-03-14 carry an old action format with no
   preflop userIds and can never yield position stats (backfill starts
   2026-03-14; later eras are mixed — e.g. Mar 27 parseable, Apr 5 not — the
   crawl handles both). Backfill runs ~10k hands/min under lock and
   self-unschedules; expected completion within hours (check
   `select * from _pps_backfill_state` — done=true when finished).
3. `get_current_settlement_period` execute revoked from anon.
