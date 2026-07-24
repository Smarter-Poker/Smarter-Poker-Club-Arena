# Rake, BBJ & Tournament Fee — Full Audit, Fixes & Verification

**Date:** 2026-07-24 · **Scope:** club-arena engine + services + Supabase (PokerIQ-Production) · **Auditor:** Claude (line-by-line code audit + live database verification)

---

## Executive summary

Your instinct was right: parts of this were badly broken. The audit covered the entire money path — pot → rake/BBJ deduction → per-player attribution → club wallet → union wallet → rakeback/commission/settlement — in code AND against the live production database.

**What was verified WORKING:**

- Cash-game rake is being taken from every eligible pot. In the last 7 days: 12,919 cash hands, 10,151 raked, $35,108.55 collected. Every zero-rake hand was a no-flop hand (no flop, no drop — by design). **Zero** flop-seen pots escaped rake.
- Rake follows your official schedule: 10% with per-stakes dollar caps, heads-up/3-handed reduced caps, exact-cent rounding.
- Per-player per-hand attribution exists: every `rake_records` row carries `player_contributions`, and equal-share credit (FIX 144) flows to `rakeback_periods`, `player_stats`, and `agent_commissions` (6,364 commission rows in 14 days — the settler daemon is alive).
- Club/union wallets are being credited per hand (`club_wallets`, `union_wallets.rake_wallet` ≈ $258,852, audit rows flowing).

**What was BROKEN (now fixed):**

| #   | Severity | Finding                                                                                                  | Status                                  |
| --- | -------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | CRITICAL | **BBJ collection dead platform-wide since 2026-07-19 16:29 UTC.** Zero BBJ taken from any pot for 5 days | **FIXED** (code + DB migration applied) |
| 2   | CRITICAL | **Tournament pots were being RAKED like cash pots** — 62,422 tournament chips destroyed in 7 days        | **FIXED** (code)                        |
| 3   | CRITICAL | **Union weekly 90% rake-back paid clubs $0** (read a dead table)                                         | **FIXED** (code)                        |
| 4   | CRITICAL | **Tournament fee never recorded to the rake ledger** — every insert failed since launch                  | **FIXED** (code)                        |
| 5   | HIGH     | **Rebuys, add-ons, re-entries charged NO fee** — 100% went to prize pool, 0% to house                    | **FIXED** (code)                        |
| 6   | HIGH     | **BBJ jackpot ticker showed nothing / wrong pool** for every club                                        | **FIXED** (code)                        |
| 7   | MEDIUM   | **Rounding drift in equal-share rakeback** (per-player rounding didn't sum to actual rake)               | **FIXED** (code)                        |
| 8   | MEDIUM   | Unregister refunded the fee but club was still billed for it in settlement                               | **FIXED** (code)                        |

Plus a set of remaining risks that need decisions/follow-up (Section 4).

> ⚠️ **DEPLOY REQUIRED:** The server fixes (#1, #2, #7) take effect when you redeploy the game server (`server/` — Hetzner/Railway). The DB migration is already applied and is inert until that deploy. The client fixes (#3, #4, #5, #6, #8) ship with your next frontend build.

---

## 1. The BBJ outage (smoking gun)

**Live evidence** (hand_history, cash games):

| Day   | Cash hands | Rake      | BBJ hands | BBJ collected |
| ----- | ---------- | --------- | --------- | ------------- |
| 07-18 | 570        | $1,694.25 | 428       | $214.00       |
| 07-19 | 1,626      | $4,636.75 | 716       | $358.00       |
| 07-20 | 1,322      | $4,177.05 | **0**     | **$0.00**     |
| 07-21 | 996        | $3,400.41 | **0**     | **$0.00**     |
| 07-22 | 1,376      | $4,640.25 | **0**     | **$0.00**     |
| 07-23 | 3,191      | $8,340.83 | **0**     | **$0.00**     |
| 07-24 | 3,870      | $8,291.27 | **0**     | **$0.00**     |

**Root cause (3 compounding defects):**

1. FIX-A2 (2026-07-19) gated the BBJ fee on `tables.bbj_percent > 0` (`ServerTableEngine.ts:2490`, `:5084`, and hit-detection at `:3322`).
2. `tables.bbj_percent` defaulted to **0.00 on all 50,155 table rows** and no code path ever sets it.
3. `loadTable()` in `server/src/services/supabase.ts` **never even selected the column**, so the gate always saw `undefined ?? 0` → disabled.

Result: no BBJ fee dropped from any pot, and even if a bad beat occurred, the hit-detection gate made it undetectable/unpayable.

**Fix applied:**

- `loadTable()` now selects `bbj_percent`.
- Gates default to **enabled** (`?? 100`); an explicit `bbj_percent = 0` still disables per-table (you now have a working per-table kill switch).
- DB migration applied to production: column default → 100, all existing tables backfilled to 100.
- Tournaments explicitly never collect the BBJ fee (see #2).

Estimated loss during the 5-day outage, extrapolating 07-18/19 rates: roughly **$300–400/day** of BBJ funding.

## 2. Tournament pots were being raked (chips destroyed)

`HandController.completeHand()` deducts `rake + bbjFee` from every pot before distribution. The hand config built in `ServerTableEngine` passed the full cash rake schedule (10% + cap) for **tournament tables too**. `postHandTasks` then skips all rake logging for tournaments — so the chips were removed from pots and credited **nowhere**. They simply vanished from the tournament chip economy.

**Live evidence:** 4,735 tournament hands in the last 7 days had rake deducted — **62,422 tournament chips destroyed**; 342 tournament hands also paid BBJ fee (pre-07-19) into a jackpot tournament players can't win.

This quietly wrecks tournament structure: total chips shrink every hand, stacks-vs-blinds get shallower than designed, and chip conservation checks can never reconcile.

**Fix applied:** both hand-config sites now pass `percent: 0, cap: 0` and `bbjConfig.enabled: false` when `isTournamentTable()`. The house's tournament revenue is exclusively the 10% entry fee, as designed.

## 3. Tournament / SNG 10% fee — collection & tracking

Your rule: **10% on any and all tournament and SNG buy-ins.** Findings:

- **Fee configured:** 516 of 526 tournaments created in the last 7 days had exactly 10% fee (recurring scheduler hardcodes it). Human-created tournaments use a free-form Fee field with no 10% enforcement (see remaining items).
- **Fee charged at registration:** yes, for real-money entries (`atomic_tournament_register` debits buy-in + fee; fee excluded from prize pool). Horses register free by design.
- **Fee NEVER recorded to the rake ledger:** the registration wrote `hand_id: "tournament-reg-<id>-<id>"` (TEXT) into a **UUID** column — the insert failed **on every registration since launch** and the error was swallowed. Live DB confirms: **zero** tournament rows in `rake_records`, all-time. So tournament fees never appeared in per-player fee tracking, club settlement rollups, or union reporting.
- **Rebuys / add-ons / re-entries: NO fee at all**, and 100% of that money was pushed into the prize pool.
- **Unregister:** refunded buy-in + fee to the player but never reversed the recorded fee → clubs billed in settlement for fees that were returned.

**Fixes applied (`src/services/TournamentService.ts`):**

- Registration fee now writes a valid `rake_records` row: `is_tournament: true`, `tournament_id`, `source`, and `player_contributions: {userId: fee}` — tournament fees are now attributed per player and flow into settlement rollups.
- New `recordTournamentFee()` helper + `calcTournamentFee()` (uses the tournament's configured fee ratio, falls back to 10%).
- **Rebuys, add-ons, and re-entries now charge the fee on top of the base cost**; the base still feeds the prize pool; `recalculatePrizePool` strips the fee portion from rebuy/add-on transactions.
- Unregister now writes a negative fee-reversal row so a register→unregister cycle nets to zero in the ledger.

## 4. Player → Agent → Club → Union rollup

**Working:** per-hand `rake_records` (server-authoritative, single writer confirmed live — no double-counting) → 30-min `RakebackSettlerService` daemon → equal-share credit to `rakeback_periods` + `player_stats` + `agent_commissions` (via `credit_agent_commission_from_rake`) → `generate_period_settlements` read-model for club/union settlement. Club wallets and union rake wallet credited per hand with audit rows.

**Fixed in this pass:**

- **Union weekly 90% rake-back read `rake_history`** — a table that stopped receiving writes on 2026-05-01. Every club's rake summed to $0, so `executeUnionRakeBack` "succeeded" while transferring nothing. Now reads the live `rake_records` ledger.
- **Rounding drift:** all four equal-share sites rounded each player's share independently (`round(rake/N)` per player), so credited totals drifted from actual rake by up to N×$0.005 per hand — a systematic leak across ~10,000 hands/week that also trips your own verification harness (`02-equal-share-rake.sql`). Replaced with an exact integer-cents split that always sums to the hand's rake (deterministic remainder assignment).

**Remaining risks — need your decision (not changed):**

1. **Client-side "cron" jobs:** `FinancialCronService` and `SettlementCronService` run in the **browser** — weekly rakeback settlement, credit-invoice generation, and period close only fire while an admin has the page open. These should move to the server daemon or a Supabase scheduled function.
2. **Union revenue share hardcoded at 10%:** `union.settings.revenueSharePercent` is stored but ignored — `calculateUnionWire` and `generate_period_settlements` both hardcode 0.10.
3. **Fee field not enforced at 10%** in `CreateTournamentModal` — a club can type any fee, including 0. Recommend a validation (or auto-compute fee = 10% of buy-in).
4. **Agent commission on tournament fees:** the settler skips rows without `hand_id` for commission crediting (idempotency design), so tournament fees now roll into club settlement + player attribution, but do **not** yet generate agent commission. Needs a small settler change with a tournament-safe idempotency key.
5. **Dead/duplicate code to retire:** `RakebackEngine` (in-memory, never flushes, conflicting tier table), client `RakeService.executeWaterfall` legacy path, `SettlementService.executeMondayPayouts` (retired no-op still called by the cron), duplicate `get_current_settlement_period` definitions.
6. **`rake_records` vs `hand_history` gap:** 156 rake rows in 7d have `hand_id = null` (hand_history insert failed); sums differ by ~$535/7d. Worth monitoring; money is still credited, only the FK link is missing.

## 5. BBJ storage, real-time counter & display

**Where the money lives:** `bbj_pools` — `main_balance` / `backup_balance` / `promo_balance` (+ lifetime counters). One pool per club, or one per union (union members share the union pool). Server splits each fee via `bbj_record_contribution`: 50/25/25 standard, pivoting to 30/40/30 once main ≥ $100k. Current live pools: union pool main **$16,687.99** (backup $15,321.62, promo $14,515.34, 27 lifetime hits), Club JAQK main $3,396.27, plus one small legacy club pool.

**Display bugs (fixed):**

- The table ticker (`useBBJ`) selected columns that **don't exist** (`hourly_rate, tiers, qualifying_hands, rules`) — the query errored and the ticker showed nothing, for every club.
- Both the ticker and the jackpot page resolved the pool by `club_id` only. **SHARK CLUB players were shown a stale $876 legacy club pool while their actual jackpot ($16.6k main) accumulates in the union pool.** Both now resolve club → union pool, exactly mirroring where the server banks the money.
- Realtime subscriptions now key on the resolved pool id (union pools stream live; the old `club_id=eq.` filter never fired for union clubs). The counter is genuinely realtime (Supabase postgres_changes) — no fake ticking on the real data path.
- "100K Pivot Alert" fired at $50k while its own progress bar measured against $100k — now aligned (alerts at ≥80% of pivot).

**Remaining BBJ risks (flagged, not changed):**

- Two payout paths exist (server `bbj_atomic_payout` — the live one — and a dead client `award_bbj` path). Their idempotency keys don't dedupe against each other, they disagree on backup-bank rollover (the atomic path never rolls backup → main after a hit), and they write winners to different tables (`bbj_payouts` vs `bbj_winners` — 0 rows in `bbj_winners`, so "Previous Winners" history depends on which path ran). Should be consolidated to the server path with backup rollover added.
- `add_bbj_contribution` (client legacy RPC) swallows all errors and returns success-shaped JSON — silent money loss if ever used.
- Promo bank ($14.5k union) only disburses via manual admin "rain" — nothing pays it automatically.

## 6. Verification performed

- **Static:** line-by-line read of `HandController.completeHand/finalizeRunout/computeRakeAndBBJ`, `calculateRake`, `RakeConfig` (both copies), `ServerTableEngine` settlement pipeline (HAND_COMPLETE → postHandTasks), `logRakeCollection`/`logBBJCollection`/`processBBJPayout`, RakebackEngine/Settler, Settlement/Commission/Union services, tournament fee paths, BBJ display components, and 20+ SQL migrations.
- **Live DB:** 7-day reconciliation of `hand_history` vs `rake_records` (no missed flop-pots; single writer; sums within 1.5%), BBJ daily series (outage pinpointed to the hour), `tables.bbj_percent` census (50,155 rows @ 0.00), tournament fee ledger census (0 rows all-time), pool balances, club/union wallet counters, settler liveness.
- **Post-fix:** all edited files syntax-checked; DB migration applied and verified (`tables.bbj_percent` default 100, backfill complete). The migration is inert until server deploy, so nothing changes mid-flight.

## 7. Files changed

| File                                                                       | Change                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/src/engine/ServerTableEngine.ts`                                   | Tournament rake/BBJ guard (both config sites); BBJ default-enabled gates; hit-detection gate                                                     |
| `server/src/services/supabase.ts`                                          | `loadTable()` now selects `bbj_percent`                                                                                                          |
| `server/src/services/RakebackSettlerService.ts`                            | Exact integer-cents equal-share split (4 sites)                                                                                                  |
| `src/services/SettlementService.ts`                                        | Union rake-back reads live `rake_records` (was dead `rake_history`)                                                                              |
| `src/services/TournamentService.ts`                                        | Fee ledger insert fixed (UUID bug); fees on rebuy/add-on/re-entry; prize-pool fee stripping; unregister fee reversal; per-player fee attribution |
| `src/components/bbj/BBJDisplay.tsx`                                        | Pool resolution (club→union), valid columns, realtime on pool id                                                                                 |
| `src/pages/BadBeatJackpotPage.tsx`                                         | Pool resolution, winners-by-pool, realtime on pool id, pivot alert threshold                                                                     |
| `supabase/migrations/20260724_rake_audit_reenable_bbj_percent_default.sql` | **Applied to production** — bbj_percent default 100 + backfill                                                                                   |

**Deploy order:** 1) deploy `server/` (game engine) — BBJ resumes and tournament raking stops immediately; 2) ship the frontend build; 3) after 24h, re-run the daily BBJ query above to confirm collection resumed (I can do this re-verification on request).

---

# SWEEP 2 (same day) — Full re-audit, deeper fixes, LIVE deployment & verification

Dan's mandate: find every remaining bug, stub, gap, regression and wiring error; fix and improve every level. Sweep 2 dumped and diffed EVERY live Postgres RPC against its code callers, re-audited the tournament/settlement/BBJ paths end-to-end, fixed 20+ additional defects, deployed the critical server fixes to production via PR #25, and verified the results against live data.

## DEPLOYED AND VERIFIED LIVE (PR #25, merged 2026-07-24 04:20 UTC)

**BBJ collection is RUNNING again — verified in production.** hand_history shows 0 BBJ hands for 5 straight days, then the first BBJ fees land at **04:21 UTC, the minute after the merge deployed**: 3-8 qualifying hands per minute since, $20.50 banked in the first 15 minutes, union pool main balance rising (16,687.99 → 16,691.24), and the new hands-contributed counter incrementing (15,000 → 15,013). Deployed via `loadTable()` now selecting `bbj_percent` + the production backfill to 100.

Also live from PR #25 + applied migrations:

- **BBJ pool auto-create** — fees can never again be deducted from a pot and banked nowhere because a club/union had no `bbj_pools` row.
- **RakebackSettler**: exact integer-cents equal-share (shares now sum exactly to each hand's rake at all four calculation sites); **server-side weekly financial close** (rakeback payout via `settle_club_rakeback`, agent credit invoices, weekly counter reset — no longer dependent on an admin's browser tab); watermark-failure abort (kills the 7-day-rescan double-credit of player_stats); tournament fees now generate **agent commissions** (idempotent on rake_records.id).

## DB-side fixes (migration `20260724b_rake_audit_sweep2_db_fixes` — APPLIED to production)

1. **`bbj_atomic_payout` v2** — after a jackpot hit, the backup bank now rolls into main as the reseed (previously backup accumulated forever and jackpots never reseeded), and the RPC writes the `bbj_winners` history row with display names (the "Previous Winners" UI had 0 rows despite 27 recorded hits, and selected columns that didn't exist).
2. **`bbj_record_contribution`** — increments `hands_contributed` (was frozen forever).
3. **`get_union_rake_for_period`** — now reads live `rake_records`; it summed the dead `rake_history` table, so the union rake-back idempotency estimate was always $0.
4. **`settle_club_rakeback`** — only closes LAPSED weeks; a mid-week run used to pay out the partial week, mark it paid, and silently void all remaining rakeback that week.
5. **`process_tournament_rebuy`** — logged `category='tournament_buyin'` with NO related id, so `recalculatePrizePool` found zero rebuy/add-on transactions (**rebuys and add-ons never entered the prize pool at all**) and the one-add-on-per-player check never matched (**unlimited add-ons**). Also set the unknown status `'active'` (real vocabulary: registered/playing/eliminated/winner). All fixed.
6. **`atomic_cancel_tournament`** — refunded buy-in + fee to EVERY registrant **including horses who paid nothing** (chip minting on every cancellation — 415 of 526 tournaments in the last 7 days were cancelled); now refunds only real players AND reverses the collected entry fees in the rake ledger + total_rake counters.
7. `bbj_winners.club_id` made nullable (union pools have no club) + display-name columns added.

## Code fixes on disk awaiting the follow-up push (`bash ~/Documents/club-arena/DEPLOY-RAKE-AUDIT.sh`)

These three files exceed the cloud bridge's push size limit, so they are committed to your working tree with a one-command script (everything verified byte-exact against current main before branching — no clobbering of the Horse AI V7 merge):

- **ServerTableEngine.ts** — tournament pots never raked / never charged BBJ (the 62,422-chips-in-7-days destruction bug); BBJ gates default-enabled; the dead `RakebackEngine` in-memory accumulator (unbounded per-player Map that never paid anyone) disabled.
- **GameServer.ts** — tournament completion settles rake from the FEE LEDGER (actual collected fees incl. rebuy/add-on/re-entry, minus reversals) instead of `buy_in_fee × current_players` which credited the union wallet for free horse entries (phantom revenue); the union audit row used `wallet:'main'` which violates the CHECK constraint — every tournament rake audit row was silently rejected (verified: zero rows); `total_rake` no longer overwritten with the phantom figure at completion.
- **TournamentService.ts** — 10% fee now charged on rebuys, add-ons and re-entries (previously 100% fee-free); registration fee ledger insert fixed (TEXT written into a UUID column had failed on EVERY registration since launch, all-time — zero tournament rows existed); fee stripped from prize-pool math; unregister writes a fee-reversal row; `createTournament` hard-enforces fee = 10% of buy-in; the call to the nonexistent `distribute_tournament_prizes` RPC removed (would double-pay every placement if the RPC were ever created — prizes are server-authoritative at elimination/win).

Plus (also on disk, deploy with the frontend build): `CreateTournamentModal` fee auto-computed at 10% and read-only; `SettlementService` honors the union's configured `revenueSharePercent` (was hardcoded 10% everywhere); `SettlementCronService` no longer calls the retired no-op `executeMondayPayouts` (which reported "payouts complete $0" as success); `BBJService.executePayout` dead client payout path (wrong RPC signature + revoked permissions + cross-path double-pay risk) now refuses cleanly; inverted winner/loser share comments corrected; `cancelTournament` fetches players before the RPC deletes them so refund balance events actually fire.

## Verification ledger

- Live RPC sources dumped from pg_proc and diffed against all callers (28 functions) — this is what exposed #3, #5, #6, the missing `distribute_tournament_prizes`, and confirmed `credit_agent_commission_from_rake` is idempotent (safe re-scans for commissions).
- All 11 pushed/committed base files verified blob-SHA-identical to current origin/main before any push — zero risk of reverting the Horse AI V7 merge that landed mid-session.
- Pushed blobs verified byte-identical (git SHA match) after upload, before merging.
- Post-deploy: BBJ resumption verified minute-by-minute in hand_history; pool banking verified in bbj_contributions + bbj_pools.
- Remaining after Dan runs the follow-up script: tournament hands show rake_amount = 0 (chip destruction stops) — verifiable with: `SELECT count(*) FROM hand_history WHERE tournament_id IS NOT NULL AND rake_amount > 0 AND created_at > <push time>;` (expect 0).

## Still open (documented, needs decisions or future work)

1. `generate_period_settlements` uses a GLOBAL rake_records-era cutoff for legacy rake_history blending — a club that migrated later than the earliest club under-counts its bridge period (currently negligible: both active clubs predate).
2. Promo BBJ bank (~$14.5k union) only disburses via the manual admin "rain" RPC — consider scheduled promo events.
3. ~156 rake_records/week have `hand_id` NULL from hand_history insert failures — money is credited, only the FK link is missing; worth a retry wrapper someday.
4. `FinancialCronService`'s remaining browser-side jobs (reconciliation alerts, dispute escalation) still benefit from an admin tab; the money-moving jobs are now server-side.
5. Per-player BBJ contribution display ("Your Contribution") reads a `player_id` column no writer populates — shows 0; needs per-player attribution design (contribution is per-pot, not per-player).

---

# SWEEP 3 — TOURNAMENT / SNG / SPIN FULL AUDIT (launch → registration → play → payout)

Line-by-line audit of the entire tournament stack: GameServer tournament runtime (lifecycle, blinds, breaks, eliminations, payouts, bounties, balancing), the recurring scheduler, the client service/UI, all live RPCs, and live-data conservation checks. Deploy: run `bash ~/Documents/club-arena/DEPLOY-TOURNEY-AUDIT.sh` (explicit file staging — no `git add -A`).

## Verified WORKING (live data)

- **Sweep-2 deploy confirmed**: tournament hands show rake = 0 from 04:44 UTC (chip destruction over); BBJ still collecting.
- **Spin payouts conserve money**: every completed spin paid exactly prize_pool = buyIn × multiplier to one winner.
- **Blind levels do advance and persist** (current_level written per level, all tables updated together); synchronized hourly 5-min breaks exist for MTT/XMTT; hand-for-hand bubble sync exists and works across tables.
- All preset payout structures sum to exactly 100%; recurring-scheduler fees are all exactly 10%.

## CRITICAL bugs found & FIXED (live evidence in parentheses)

1. **Engine restart MINTED money and destroyed tournaments.** Startup cleanup credited every seated player's stack to their real wallet with **no tournament filter** — tournament chips (e.g. 10,000) became spendable currency on every reboot, and the seats a resumed tournament needs were deleted. Fixed: only cash-table seats cash out; deletes target exactly the processed rows.
2. **Force-completed tournaments never paid out.** Stuck COMPLETING tournaments were blind-flipped to COMPLETED (verified live: a COMPLETED bounty MTT with **8 players still 'playing'** and $60 of a $100 guaranteed pool never paid; 755 stranded rows platform-wide, all horses). Fixed: recovery now assigns remaining positions by chip count, pays winner + unpaid ITM places (idempotent), then completes. Historical stranded rows healed by migration.
3. **Spin&Go economics were a guaranteed house loss at creation** (pool = buyIn × players × multiplier ≈ 2.75× every dollar collected). Fixed to standard buyIn × multiplier.
4. **Mystery bounty payouts were minted, not funded**: collection ignored the value assigned to the player's head at registration and re-rolled hardcoded multipliers with `Math.random()` — unbounded, and the revealed number ≠ the paid number. Fixed: pays the stored head value (bounded by what was collected); crypto-RNG clamped fallback.
5. **Bounties routed to the wrong player**: knocker = first winner of the table's most recent hand — even if the busted player wasn't in that hand (5s sweep lag) and regardless of side pots. Fixed: last hand the busted player actually played, largest-pot winner.
6. **PKO/bounty champions forfeited their own bounty head** (never paid at the win). Fixed: champion collects it at finish, logged, idempotent.
7. **Simultaneous full-table bust double-paid 1st place** (eliminatePlayer paid position 1, then finishTournament paid the winner again). Fixed: top stack is spared from the elimination sweep; eliminations can never pay position 1.
8. **Restart-orphaned SNG/Spins were cancelled with NO refund** — real players simply lost buy-in + fee. Fixed: full refund + fee reversal in the rake ledger for non-horse entrants.
9. **Blind clock reset to a full level on every restart** (level_started_at never persisted) — restart-heavy windows nearly froze escalation. Fixed: level clock persists; resume arms the REMAINING time. Add-on window flag also persists now.
10. **Every tournament created with a standard blind structure FAILED validation** — turbo/regular/deepStack presets contain break levels (0/0 blinds) and the monotonicity check rejected them. Fixed: breaks skip the check.
11. **Late-registering players were never seated** — the open-seat lookup filtered `status in ('active','running')` but started tables are `'RUNNING'` (case-sensitive). Everyone went to the alternates list. Fixed.
12. **Owner "Start" raced the server's discovery loop** → double tables + double seating; client-seated players also had **no stacks** (seat insert omitted `stack`) and `tables.current_players` stayed 0. Fixed: atomic start claim (CAS), stacks seeded, counts recorded. Start button now requires 3 players (2 triggered insta-cancel).
13. **Scheduler defects**: bounty portion double-counted into prize pools (MTT + XMTT); horses double-booked into simultaneous events; DB-error → duplicate-creation storms (now fails closed); schedule hours now UTC.

## Remaining decisions / follow-ups (documented, not changed)

- Recurring SNGs/Spins fill to capacity with horses — humans can never join them. Decide desired mix (e.g. horsesToRegister = maxPlayers − 1) — changing it affects the always-running bot ecosystem.
- Horse prize credits are real wallet credits against pools funded by phantom (free) horse entries — the horse economy mints; consider funding horse buy-ins from club treasury like cash-table rebuys.
- `TableBreakEngine` (warning countdown flow) and `ChipRaceEngine` are dead code (chip race hard-disabled; its single-chip branch would mint a denomination if re-enabled).
- Elimination position during open late reg is relative to the current field (early busts get flattering places); same-hand tie ordering is arbitrary among equal busts.
- Mystery bounty reveal overlay guards on a `playerName` field the event never carries (dead overlay); satellite seat awards unimplemented; client waitlist tables unwired.
- `waitForHandComplete` gives up after 30s — table moves can still catch a marathon hand mid-flight.

## Deploy & verify

1. `bash ~/Documents/club-arena/DEPLOY-TOURNEY-AUDIT.sh` (explicit adds; your Horse V3 WIP stays unstaged — the script prints the staged set and the untouched WIP for eyeball confirmation).
2. DB migration 20260724c already applied (columns + hygiene).
3. Post-deploy checks (expect zero): stranded 'playing' rows in tournaments completed after deploy; tournament hands with rake > 0; spins with prize_pool ≠ buyIn × multiplier.
