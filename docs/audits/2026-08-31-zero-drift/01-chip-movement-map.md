# Chip-Movement Map — Complete Architecture Audit (2026-08-31)

Four parallel read-only audit workstreams swept the estate on 2026-08-31: the cash-game engine,
tournaments/spins/heads-up, the World Hub ops API + client SPA, and the database RPC layer.
Their reports are reproduced below (condensed only where they duplicated each other). Line
numbers reference the working tree as of commit `9384b5e779` on main.

---

## Part A — Cash-game engine (`server/src`)

| # | Trigger | Location | Source → Destination | Mechanism | Tx boundary | Idempotency | Failure behavior | Risk |
|---|---------|----------|----------------------|-----------|-------------|-------------|------------------|------|
| 1 | Human buy-in / seat | HorseFleetManager.ts:1357 + client/API | club_members.chip_balance → table_seats.stack | RPC `atomic_table_buyin` | Atomic RPC | RPC-internal + transaction_idempotency_keys | Clean refusal | Low |
| 2 | Horse seat funding | services/supabase/wallets.ts:37 | club treasury → horse seat | RPC `fn_horse_seat/fund_from_treasury` | Atomic RPC | RPC-internal | Fails clean; horse busts | Low |
| 3 | Top-up between hands | ServerTableEngineSeating.ts:97 | wallet → stack | RPC `atomic_table_addon` | Atomic RPC | `addon:<table>:<user>:<opId>` stable across HTTP retries | Debit refused → no credit | Medium (double-lost-response erasure window) |
| 4 | Top-up mid-hand | same + `table_pending_addons` | wallet → pending → seat | RPC + `resolve_pending_addon` | Both atomic | addon key + refund key | Row never dropped; boot sweep | Low |
| 5 | Partial withdraw | Seating.ts:190 | seat → wallet | RPC `atomic_table_withdraw` | Atomic RPC | none | Clean refusal | Low-Med |
| 6 | Leave/kick/evict/horse stop | Seating.ts:640, Base.ts:3548 | stack → chip_balance | RPC `atomic_seat_cashout_locked` (FOR UPDATE read+credit+vacate) | One locked tx | `cashout:<seat>:<joined_at>` derived in-RPC | Failure rolls all back; seat preserved | Low |
| 7 | Leave mid-hand | Seating.ts:617 | flag → path 6 at settlement | flag update then locked RPC | — | n/a | Player re-clicks | Low |
| 8 | Hand settlement (pot/blinds/bets) | HandController + Settlement.ts:429 + syncStacks (tables.ts:167) | engine memory → absolute stack UPDATE per seat | **Multi-step JS** | per-seat UPDATE, 3 retries | none (absolute write = idempotent) | Partial success mints/destroys until next sync; hard-kill = permanent | **High** |
| 9 | Rake | Settlement.ts:1466 | pot → rake_records + club_wallets + union rake_wallet / treasury | RPC `atomic_distribute_rake` | Atomic RPC | `uq_rake_records_hand_id` + per-leg claims | 3 retries → unbanked-fee queue → redrive sweeps | Medium (crash-before-call window) |
| 10 | BBJ contribution | Settlement.ts:1512 → bbj.ts:47 | pot → bbj_pools m/b/p | RPC `bbj_record_contribution` | Atomic RPC | unique (pool,hand) | queue + `fn_bbj_repair_unbanked` self-heal | Medium |
| 11 | BBJ payout | Settlement.ts:1595 → bbj.ts:314 | pool → seats/wallets | RPC `bbj_atomic_payout_v2` | One locked tx | (pool,table,hand) + (payout,user) claims | atomic; `already_paid` re-drives | Low-Med |
| 12 | Insurance / EV cashout | Settlement.ts:~470-620 + rake.ts:220 | stack ↔ insurance bank | stack in JS; bank via `record_insurance_transaction` | split | (table,hand,player) | loss → CRITICAL alert, manual repair | Medium |
| 13 | 7-2 bounty | Settlement.ts:650-760 | payer stacks → winner stack | in-memory, zero-sum | via syncStacks | audit row unkeyed | audit-only loss | Low |
| 14 | Bomb-pot award units | Settlement.ts:1338-1388 | narration only | upsert unique | — | UNIQUE + ignoreDuplicates | nightly gap detector + hourly repair | Low |
| 15 | Horse auto-rebuy | Settlement.ts:1700 | treasury → seat | RPC `fn_horse_fund_from_treasury` | Atomic RPC | RPC-internal | horse busts on failure | Low |
| 16 | Promo playthrough | Settlement.ts:1541 | promo → chip on threshold | RPC `promo_apply_playthrough` | Atomic RPC | idempotent no-op | fire-and-forget; accrual under-counts | Low-Med |
| 18 | Admin endpoints | handlers/admin.ts | none direct (pause/kick only) | — | — | — | — | Low |

**Crash windows (ranked):** (1) partial `syncStacks` + hard-kill (SIGTERM covered by
`drainHands()`; kill -9/OOM is not) — highest residual money risk in the cash engine; (2) crash
after syncStacks before rake/BBJ posting — the fee then exists nowhere and the redrive queue
cannot see it (written only on observed in-process failure); (3) double-lost-response addon
erasure via the absolute sync write. Mid-hand crash voids the hand (chips conserved, results
lost — acceptable by design).

**Exactly-once per hand:** rake DB-enforced via `uq_rake_records_hand_id` + leg claims; BBJ
contribution unique (pool,hand) + self-heal from rake_records; BBJ payout unique claims; pot
settlement idempotent-by-construction (absolute writes, single-writer engine per table lease).

**Floating point:** chips are 2-decimal `numeric` in the DB; engine discipline is manual
(`Math.round(x*100)/100` at ~40 call sites; integer-cents pot distribution in HandController).
No `.toFixed` on money paths. StateVerifier chip-conservation per hand is the compensating
detector. The DB now also normalizes and constrains every ledger amount to exact 2dp.

---

## Part B — Tournaments, spins, heads-up

Account model: player club wallet (`club_members.chip_balance`) — club treasury — union rake
wallet — spin reserve (`spin_bonus_pools` + `spin_reserve_ledger`) — prize/bounty pools
(**accounting counters, not wallets**) — tournament play chips (`tournament_players.chips`,
tournament `table_seats.stack`; minted at buy-in, destroyed at finish, never convertible).
All wallet credits funnel through **`fn_credit_and_log`** (requires idempotency key, credits via
`fn_credit_player_wallet_once`, journals only if the credit moved).

Key flows (26 mapped; full detail in the session audit):

| Flow | RPC | Idempotency | Risk |
|------|-----|-------------|------|
| Registration / seat-first buy-in | `fn_register_for_tournament` / `fn_take_seat_and_buy_in` | FOR UPDATE + already_registered | Low |
| Pre-start refund / unregister | `fn_leave_seat_and_refund` (tournament-only!) / `fn_unregister_from_tournament` | `seat_refund:` / `tourn_unreg:` keys | Low |
| Rebuy / add-on / re-entry | `process_tournament_rebuy` | wallet-tx lookback + FOR UPDATE + client token | Low-Med (heuristic dedupe) |
| Guarantee overlay | `fn_apply_prize_guarantee` | PK claim on overlays table | Low (can drive treasury negative BY DESIGN, alarmed) |
| Place/winner prizes | `fn_credit_and_log` | **place-scoped** `tourney:<id>:prize:place:<N>` | Med (position races contained) |
| PKO bounty | `fn_collect_bounty` | already_collected per eliminated | Med (split-pot pays one collector — ruling pending) |
| Mystery bounty reserve/reveal/pay/settle | `fn_mystery_bounty_*` | op-UUID + unique award + exact-cent settle assert | Low-Med |
| Spin draw/settle | `fn_spin_draw_multiplier` / `fn_spin_settle_game` | pool FOR UPDATE + `already_settled` returns booked multiplier | Low |
| Satellite seat | `fn_award_satellite_seat` | one txn, cash fallback | Low-Med |
| Rake settlement | `fn_settle_tournament_rake` | PK claim on tournament_rake_settlements + sweep | Low |
| Cancellation | `atomic_cancel_tournament` | evidence-based refunds, `cancelrefund:<row>` keys | Low-Med |
| Payout reconciler | `fn_tournament_payout_reconcile` | `...:reconcile` keys (deltas vs ledger) | Med — pays real chips from ledger deltas; the dealt-in-survivor guard is load-bearing |
| HU shortfall backpay | `fn_backpay_hu_winner_shortfalls` | ledger-derived keyed | Low |

Heads-up games have no bespoke money path (2-seat seat-first SNG).
Conservation: `fn_tournament_money_conservation` per event (excludes spin/satellite — covered by
their own ledgers/sweeps), `fn_tournament_chip_conservation_check` for play chips (NOT in
versioned migrations — flagged), spins covered by `spin_reserve_ledger` + unbooked/unpaid sweeps.

Top tournament risks: (1) reconciler vs upstream truth (the 141%-of-pool incident shape — driver
closed, defenses load-bearing); (2) final-table deal settlement is an engine-side per-row loop;
(3) rebuy dedupe is heuristic; (4) split-pot bounty ruling pending; (5) play-chip conservation
check lives only in the live DB, with an un-root-caused ~261-chip (0.012%) fractional-split drift
reported every cycle.

---

## Part C — World Hub ops API + client SPA

Money routes inventory (mechanism → risk): `mint-chips` (`mint_club_chips`, tiered caps — Med),
`distribute-chips`/`transfer-chips`/`agent-credit`/cashout routes (atomic RPCs — Low),
`clawback-chips` (Low), `settle-period` (multi-RPC, compensating rollback not atomic — Med),
`rakeback`/`manage-agent`/`leave-club` (multi-RPC sequences — Low-Med), `record-rake`
(engine-key gated — Low), `marketplace/refund` (durable idempotency — the gold standard),
`union-wallet`, `union-invoice` (**no idempotency** — Med), `horse-launch`
(`mass_fund_horses` — platform-gated), `promo-wallet`/`distribute-promo` (**parseFloat** — Med).

**Critical findings (fixed in the companion WH PR):**
- **F2 `player-retention.js` welcome_back**: raw read-modify-write on `chip_balance` — racy,
  uncapped, minted chips from nothing, best-effort journal. → replaced with capped
  `fn_credit_chips` RPC call.
- **F1 `buyin.js`**: live diamonds→chips conversion (38d=100c) contradicting the 2026-08-19
  prohibition; `orb1_buyin_transaction` overload ambiguity (a no-op stub exists with a different
  signature). **Needs a product ruling from Dan** — not changed.
- **F3 parseFloat** in promo routes → fixed.
- **F5 idempotency**: only marketplace/refund used durable DB idempotency → added to
  settle-period, rakeback, manage-agent, leave-club, union-invoice.
- **F6**: audit logging is fire-and-forget; several money routes never call logAudit.

**Client SPA:** no browser writes to balance columns (blocked by DB triggers), but
`TournamentService.ts:1416` inserts `table_seats` rows WITH stacks from the browser (client-side
tournament start legacy), `HorseOrchestrator.ts:1825` stamps `left_at` on seats from the browser
(refund-less exit shape — the seat-exit trigger now watches it), and a **browser-resident cron**
(`FinancialCronService.ts` setInterval) executes settlement RPCs from whichever admin tab is
open. Browser-callable money RPCs verified in Part D; `promo_apply_playthrough` was the
exploitable one (fixed).

---

## Part D — Database RPC layer (~44 money functions audited)

Full per-function table in the session audit. The ranked risk list, with dispositions:

1. **`promo_apply_playthrough` authenticated-callable, no self-check + ::integer truncation** → **FIXED** (engine-only + exact release).
2. **`atomic_distribute_rake` "double-credit"** — club accumulator (net) + union/treasury (gross). `club_wallets.chip_balance` is a **rake accumulator**, not circulating supply (excluded from `fn_club_chip_circulation` and from `ca_supply_snapshots.total`); registry-documented. **Verify settlement never pays both accumulator and treasury for the same rake** — open follow-up.
3. **'adjustment' plug = 97% of rows / 65.5M chips per 30d** → category+counterparty GUCs now on buyin/rebuy/addon/cashout/transfer/rake/BBJ/promo/horse paths; suspense monitor measures the remainder daily.
4. **`fn_bbj_promo_payout_atomic` paid the frozen pool, no idempotency** → **FIXED**.
5. **Frozen-wallets fallbacks** in credit/debit paths → fail-closed for club members (already); `log_wallet_transaction` balance_after → **FIXED**; frozen pool movement now raises a critical incident within 5 minutes.
6. **No non-negative CHECKs on primary balance columns** → 5-minute negative-balance detector raises incidents (blocking constraints deliberately deferred — availability policy; overlay/credit negatives are authorized states).
7. **Journals not append-only** → **FIXED** (trigger-enforced, maintenance-GUC escape logged).
8. **`atomic_table_rebuy` missing ROW_COUNT check** → **FIXED** (+ seat FOR UPDATE).
9. **Un-idempotent movers** (`fn_union_send_to_member`, `fn_transfer_chips`, `transfer_chips_agent_to_player`, `fn_horse_fund_from_treasury`, treasury primitives, `fn_union_credit/debit_wallet`, `atomic_deduct_wallet_and_log`) → open follow-up (op_id params).
10. **`fn_union_settle_player_pnl` partial-failure trap** (`in_progress` satisfies the unique index; retry reports settled with money half-moved) → open follow-up; quick-reconcile stuck-settlement detector partially covers.
11. **Parallel balance columns** (`clubs.chip_pool` vs `chip_treasury`; `unions.*` fallbacks; `bbj_pools.pool_amount` vs `main_balance`) → all now auto-journaled so divergence is visible; consolidation is an open follow-up.
12. **`fn_credit_chips` ::integer cast** → **FIXED**. `fn_tournament_atomic_register` `v_total::integer` + lowercase-status check (likely dead path) → open follow-up: confirm dead, then retire.
13. **Unjournaled primitives** (`fn_add_chips`, `deduct_chip_balance`, `decrement_club_treasury`, `redeem_promo_to_chips`, `increment_union_chip_balance`) → now auto-journaled by the coverage triggers (suspense-visible); explicit categories are an open follow-up.
14. **`fn_mint_club_chips` un-idempotent, uncapped at DB level** → open follow-up (route-level caps exist); every mint now journals via the treasury trigger.
15. **anon/authenticated hold latent DML grants on journals + idempotency tables** (masked by RLS) → REVOKE sweep is an open follow-up; the append-only triggers now block destructive writes regardless of grants.

**Positives:** agent-wallet send/claim pair, `fn_club_bank_*`, `fn_cashier_*`,
`process_tournament_rebuy`, `bbj_atomic_payout_v2` + `bbj_record_contribution`,
`fn_spin_settle_game`, and `atomic_distribute_rake`'s leg-claim design are all
lock-then-check-then-write with real unique-index-backed idempotency. No float money columns
exist anywhere. All legacy BBJ payers are hard-retired.
