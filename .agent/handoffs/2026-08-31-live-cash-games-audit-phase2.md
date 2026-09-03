# HANDOFF — Live Cash Games Full Audit — PHASE 2 OF 6

**Written:** 2026-08-31 ~12:10 UTC
**Repo:** `Smarter-Poker/Smarter-Poker-Club-Arena` (NOT `club-arena` — that is the old name)
**Supabase project_id:** `kuklfnapbkmacvwxktbh`
**Status:** Phase 1 of 6 COMPLETE and verified. **You are starting Phase 2 of 6.**

---

## 0. YOUR MISSION IN ONE PARAGRAPH

Dan asked for a full audit of every live cash game end-to-end (sit down, buy in, wait for 3 players, spin animation, tournament flow, blinds increase, payouts), fixing every bug, gap, stub, error, regression and wiring issue, verified by live E2E rather than by reading code. That audit found and fixed several production outages and a real chip leak. The remaining work was then broken into 6 phases. Phase 1 (money-integrity alarms) is done, shipped, and independently verified. **Your job is Phase 2 and onward.** Do not re-do Phase 1 — verify it in 60 seconds with the query in §7 and move on.

---

## 1. NON-NEGOTIABLE LAWS (read before touching anything)

From `CLAUDE.md` in the repo. BINDING. Violating them is how previous agents caused outages.

1. **HORSES ARE PLAYERS** (§10.5). Horses (AI players — NEVER call them "bots") are treated 100% identically to humans in everything: earnings, payouts, rules, evictions, counts, ledgers, pauses, timers. If you type `is_horse` to EXCLUDE a horse from something a human gets, you are writing a bug. Only legitimate uses: (a) identification/display, (b) the horse's "input device" (HorseLogic, scheduleHorseAction, synthetic heartbeat, autoRebuyHorse). There is NO "equal outcome by a different mechanism" exemption — timing/pauses count as treatment. One sanctioned asymmetry: hand-history retention (7 days for horse-only hands) — Dan ruled on it, it is a config row, DO NOT "fix" it.
2. **ANIMATIONS MUST ALWAYS PLAY** (§10.6). Enforced by `tests/animations-always-play.law.test.ts`. Never weaken a pin.
3. **NEVER AUTO-CHANGE TABLES** (§10.6). Moving `activeIndex` without a user gesture is forbidden. Enforced by `tests/no-auto-table-switch.law.test.ts`.
4. **NEVER SPEND REAL CHIPS TO TEST A RULE** (§11.5). Probe money paths inside a transaction you ROLL BACK. Never DELETE a `table_seats` row to clean up — that skips the refund and destroys chips. Helper functions go in `pg_temp`, never `public`.
5. **NEVER REBASE main** (§12). Never run git WRITE commands against the mounted repo (see §2.4).
6. **NO NEW INFRA** (World Hub RULE 12). No new repos, Vercel projects, Supabase projects, OAuth clients.
7. **NEVER PUSH A RED TEST** (§5.8). A failing test stops the World Hub sync for every agent.
8. **No emoji in source.** Popups/toasts: Capitalize Every Word, no em dashes.
9. Changelogs go in your OWN file: `docs/changelog/YYYY-MM-DD-<slug>.md`. NEVER append to `MIGRATION-CHANGELOG.md` (it caused 18 of 108 PR conflicts).
10. **Migrations must be BOTH applied to production AND committed to `supabase/migrations/`.** I caught 5 that were applied but never committed — see §3.3.

---

## 2. ENVIRONMENT: EXACT SHIPPING ROUTE + EVERY TRAP I HIT

**This section will save you 2+ hours. Read all of it.**

### 2.1 The GitHub MCP token is DEAD

`mcp__github__*` returns `Authentication Failed: Bad credentials`. Do not use it, do not debug it. (Dan had another agent rotate it in `claude_desktop_config.json`, but MCP servers read env at startup, so it will NOT take effect until the desktop app / MCP servers restart. I retested after the rotation — still dead in-session.)

### 2.2 The working token

`GITHUB_TOKEN` in `/sessions/blissful-cool-gates/mnt/club-arena/.env` — **works, admin-scoped.**
**TRAP:** the top of that `.env` has three stale comment lines saying `# REMOVED: GITHUB_TOKEN / GITHUB_PAT — ... Use gh auth token`. **That comment is a lie.** A live `GITHUB_TOKEN=` line sits ~8 lines below it.

```bash
cd /sessions/blissful-cool-gates/mnt/club-arena && \
TOKEN=$(grep -oE '^GITHUB_TOKEN=.*' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
```

### 2.3 How to ship (proven working 3x this session)

Use the **GitHub REST Contents API** with that token. Prefer it over cloning — `/` and `/sessions` in the sandbox have been **100% full** from other agents' clones.

- Branch → create files → PR → wait for checks → squash-merge.
- Author commits as `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>`. **This matters:** Vercel refuses to build a commit it cannot attribute; a wrongly-authored commit goes to BLOCKED with no build logs (World Hub CHECK 15).
- `agent-autopilot.yml` runs every 10 min and enables squash auto-merge on open PRs — your PR may merge itself before you call the merge endpoint. Verify by RE-READING the PR object, not the merge response.

### 2.4 NEVER run git write commands on the mounted repo

`/sessions/blissful-cool-gates/mnt/club-arena` is a mount that **cannot unlink files**. Any `git status/add/commit` there strands a `.git/index.lock` that then blocks git on Dan's actual Mac. Read-only greps are fine.

### 2.5 The mounted repo is STALE

An auto-sync loop does `git reset --hard origin/main` on Dan's Mac. The mount lags main. **Always base edits on content fetched from GitHub `main`, not from the mount.**

### 2.6 More traps

- **Secondary rate limits** on content creation are live and INVISIBLE in `/rate_limit` (shows `used: 0/5000`). A `403` on `POST /git/blobs` means secondary limit — wait ~10 min. Other agents push constantly (main moved 4x in 6 minutes during one task).
- **Node `fetch` has no default timeout** — one request hung 5+ minutes. Use `AbortSignal.timeout`.
- Backgrounding needs `setsid`; plain `nohup ... &` dies when the bash call returns.
- Token **lacks `checks:read`** — `/commits/{sha}/check-runs` returns 403. Read `/actions/runs?branch=...` + `/actions/runs/{id}/jobs` and `mergeable_state` instead.
- **`supabase/migrations/` has hit GitHub's exact 1,000-entry Contents API cap.** Listing that directory SILENTLY TRUNCATES — it produced a false "file missing" in my own verification. **Always check a specific migration by direct path** (`/contents/supabase/migrations/<file>?ref=main`), never by listing.
- Supabase MCP `list_migrations` and `get_advisors` return outputs too large for the tool (947K / 215K chars). Query `supabase_migrations.schema_migrations` directly with SQL instead.
- `fn_bomb_pot_ledger_gaps('30 days')` exceeds the statement timeout. Use `'1 day'`.

### 2.7 DEPLOY TRUTH — THE MOST IMPORTANT OPERATIONAL FACT

**`auto-deploy-hetzner.yml` regularly reports GREEN while deploying NOTHING.**

The drain gate polls `handsInFlightTotal` 16 times waiting for zero. With a continuously-dealing horse fleet that **never** reaches zero. It then checks engine uptime against `MAX_ENGINE_AGE_SEC=2700` (45 min): if the engine is younger it sets `skip=true`, prints `::warning title=DID NOT DEPLOY::`, and **exits 0**. The staleness cap is in practice the ONLY way a deploy ever lands. A `schedule: */20` catch-up retries. Dan confirms a background `engine-watchdog.sh` also catches up. This is intentional design (it protects live hands), not a bug — but a green tick is NOT proof of deployment.

**NEVER claim something is deployed because CI is green.** Verify through the DATABASE (§7). Do NOT use `https://engine.smarter.poker/health` — CDN + fetch cached ~15 min, it will lie to you.

Check whether a run actually deployed:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
 "https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/<RUN_ID>/jobs" \
 | python3 -c "import sys,json;[print(s['number'],s['name'][:60],'->',s['conclusion']) for j in json.load(sys.stdin)['jobs'] for s in j['steps']]"
```

If step 20 `DID NOT DEPLOY — this run shipped nothing -> success`, it shipped nothing.

### 2.8 CI gates that WILL block you (all real, all hit this session)

- **`check-migrations-applied.mjs`** (inside required `TypeScript Check`): parses `CREATE OR REPLACE FUNCTION` from added migrations, fails unless the name is in `scripts/ci/supabase-schema-manifest.json`. Edit that manifest **ADDITIVELY, one object only**, byte-identical under `JSON.stringify(x, null, 2) + '\n'` (a unit test asserts this). **NEVER regenerate wholesale** — other agents have unrelated live schema drift a full regen would sweep in.
- **`check-definer-authorization.mjs`**: any `SECURITY DEFINER` function must carry an explicit `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;` **in the migration file itself** (the gate models grants from the file alone, starting from the Postgres default where PUBLIC has EXECUTE). `CREATE OR REPLACE` does not reset a live ACL, so a function that is correct in production still trips this. Add the REVOKE (+ `GRANT EXECUTE ... TO service_role`) as a documented no-op restatement. Do NOT loosen the gate.
- **`tests/unit/noFixedSizeSourceWindows.test.ts`**: forbids byte-count source windows like `slice(idx, idx+2500)` in tests. Use `server/src/testHelpers/sourceWindow.ts` (`sliceEnclosingBlock`, `sliceMethod`).
- Required checks on main: `TypeScript Check`, `Client Unit Tests (vitest)`, `Server Engine (typecheck + tests)`, `Production Build`, `CSS Beat E2E`, `Silent Revert Guard`. Ruleset `main protection` (id 21163380) is ACTIVE with `bypass_actors: []`. Direct pushes to main are refused; PR is the only path.
- `ci.yml` gates `unit`/`server`/`build` behind a `changes` job; a docs+migrations-only PR legitimately SKIPS them. Correct behaviour, not a bypass.

---

## 3. WHAT THE AUDIT FOUND AND FIXED (all shipped, all verified)

### 3.1 Pre-Phase fixes (the original audit)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                | PR      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Chips leaking off the felt.** Engine boot sweep credited one aggregate then **bulk-DELETEd active cash seats** (the non-refunding exit §11.5 forbids). 3,405 deletes/day carrying 1.27M chips; **1,033/day (~432K chips) had no matching wallet credit.**                                                                                                                                                                                                                                   | Every seat now exits via `atomic_seat_cashout_locked` (credit + `left_at` in ONE tx, per-seat ledger row). DELETE removed entirely. Batches of 10. | #2038   |
| 2   | **`remove_horse` RPC** vacated a seat and refunded NOTHING — live `SECURITY DEFINER` grenade. Live body differed from the repo's 008 version. 0 recorded calls.                                                                                                                                                                                                                                                                                                                               | Retired to a tombstone that RAISEs, naming its replacement.                                                                                        | #2038   |
| 3   | **SNG board DEAD for 16 hours** (zero SNGs created 17:31→09:00; 32 stuck REGISTERING 15-25h past start). Root cause: a retired World Hub legacy engine (`GameController.js:2505` `_cleanupStaleTables`) had closed their tables — **all 32 husk tables were `status='closed'` while their tournaments were REGISTERING.** Healthy SPINs owned `waiting` tables. A closed table can't be seated, and `ensureBoardOpen` counted them as "covered" because they owned a table → absorbing state. | Close-guard; joinability now requires a non-closed table; recovery sweep reopens tables closed under live tournaments.                             | #2054   |
| 4   | **Horse fill starvation.** `pickFreeHorses` fetched an unordered, unfiltered first page of the 584-horse fleet; the same horses were drained all day while ~380 idled. Spins decayed 340/hr → 3-10/hr.                                                                                                                                                                                                                                                                                        | Whole fleet keyset-paged via `fetchAllRows`, filter+shuffle in memory, fail closed.                                                                | #2013   |
| 5   | **Short Deck cash DARK** since 09:14. `cashTableHeldEmpty` used a weak `h*31+c` hash so `% 100` **incremented +1 per 2h bucket** instead of re-rolling → ~30-hour holds.                                                                                                                                                                                                                                                                                                                      | mix32 murmur avalanche + guard that the only open table for a variant is never held empty.                                                         | #2013   |
| 6   | **Create Table could crash the engine.** Table Size slider offered 2–10 seats for EVERY variant and wrote `max_players` unclamped; a 10-max PLO5/6/8 exceeds deck capacity → `PokerEngine.deal()` throws "Not enough cards in deck" mid-hand. `TableService.createTable` (which held the clamp) was deleted 2026-08-27.                                                                                                                                                                       | Clamp via `clampSeatsForVariant` in `buildTableData`, per-variant slider cap, snap-down on variant change.                                         | #2012   |
| 7   | 10 COMPLETED tournaments with `ended_at` NULL (from `20260823100000_unstick_the_seatless_spins.sql`).                                                                                                                                                                                                                                                                                                                                                                                         | Backfill migration.                                                                                                                                | applied |
| 8   | One spin double-stamped `prize` (18.00 on a 9.00 pool). **Wallet was correct (9.00, once)** — only the stats column was wrong (primary settle + back-pay sweep each stamped it).                                                                                                                                                                                                                                                                                                              | Targeted repair with a pre-flight that ABORTS if the wallet is also wrong.                                                                         | applied |

### 3.2 PHASE 1 — Money-integrity alarms (COMPLETE)

| Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                             | PR    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **The alarm had no schedule.** `reconcile_ledger_nightly` — the check that surfaced the leak — was in **NO pg_cron entry** (55 jobs scheduled, not one of them). Last run 20:54 the previous day.                                                                                                                                                                                                                                                                | Scheduled `reconcile-ledger-integrity-6h` (`55 */6 * * *`, jobid 157). Every 6h not nightly: the function DELETEs its own `run_date=CURRENT_DATE` rows so repeat runs are idempotent, and `chip_ledger` is only ~213k rows (measured 0.97s seq scan).                                                                                                                                                                                           | #2144 |
| **Treasury check structurally could never pass.** `fn_club_members_ledger_writer()` — the **ONLY writer of `chip_ledger` in the whole database** — **invented** the counterparty: any wallet increase was booked `club_treasury → player_wallet`, any decrease the reverse. It never read `clubs.chip_treasury`. 62,495 of one club's 62,499 treasury rows were this fiction (`description LIKE 'auto-audited%'`). Drift GREW with volume: 30.5M → 41.7M in 12h. | 3 migrations: trigger takes a real counterparty from `app.ledger_counterparty` defaulting to `table_stack`; the 4 highest-volume real treasury writers now journal; `ca_treasury_baseline` gives an opening balance (mirrors `ca_chip_baseline`). Also widened `chip_ledger_from_type_check`/`to_type_check` to admit `table_stack` (NOT VALID → VALIDATE).                                                                                     | #2115 |
| **The bomb-pot repair could not repair a bomb pot.** `fn_backfill_bomb_pot_award_units` filters `jsonb_array_length(winners) = 1` → **only single-winner hands**, but a multi-board bomb pot has a winner per board. All 6 open gaps had 2–3 winners; the function "succeeded" on 6 unrelated hands and left every real gap untouched. The gap could never reach zero.                                                                                           | New `fn_backfill_bomb_multi_winner_units` using the per-winner `amount`/`potIndex` already in `hand_history.winners` (they sum EXACTLY to net — verified on all 6). Only repairs hands that reconstruct the net pot exactly, so a hand that doesn't add up stays visible as a different defect. Scheduled `bomb-multi-winner-repair-hourly` (`20 * * * *`), DB-side so it can't drift from an engine build. **Repaired 178 hands / 368 units.** | #2144 |

**Phase 1 before/after:** reconciler criticals **10 → 0**; `club_treasury` 3 critical / 41.7M drift → **2 ok / 0.00**; `bomb_award_ledger_gap` 17 → **0**; `seat_stack_exit` 1,033 (431,906 chips) → **0**; `ca_ledger_write_failures` **0**.
**Live proof of the trigger cutover:** phantom `club_treasury` rows ran ~1,330/hour, then stopped **dead at 10:36:54Z**, with 0 in the following hour and correctly-typed `table_stack` rows in their place.

### 3.3 Phase 1 VERIFICATION pass (Dan asked me to re-verify — found 2 MORE issues)

| Issue                                                        | Detail                                                                                                                                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5 migrations applied but NEVER committed**                 | Production carried 2 cron jobs + a repair function source control had no record of. A rebuild would have lost them silently.                                                                                                                                                                                                                                                                        | Reconstructed from `supabase_migrations.schema_migrations.statements`, md5-verified in Postgres against the committed blob (all 5 match byte-for-byte). **PR #2144 merged.**                                                                                                                                           |
| **Deadlock spike** 1-4/hr baseline → 15 (08:00) → 28 (10:00) | **NOT caused by the trigger change** (which landed 10:36, two hours after the spike began) — it tracks restored throughput. Root cause: `fn_sync_seat_first_player_count` updates `public.tables` then `public.tournaments` while concurrent seating writers take them in the opposite order — lock-order inversion, always present, only now exercised. It logged "count sync failed" and gave up. | Function is idempotent (every value from a fresh `COUNT(*)`), so a bounded 3-attempt retry catching `deadlock_detected`/`lock_not_available`, then defers to the every-minute sweep as before. Lock order deliberately NOT reordered (that would just move the inversion). Deadlocks 28 → 16 → 2. **PR #2157 merged.** |

**Regression checks that came back clean:** no downstream reader of `chip_ledger` filters on `club_treasury` (only the 4 writers); null `from_label`/`to_label` are PRE-EXISTING not new (0 of 53,224 before, 0 of 1,242 after) and the `null → null` UI fallback in `CashierPage.tsx:964` is unreachable because every row has a description; the 5 check-constraint violations in logs were an unrelated `probe_heartbeats` table; every `table_stack` log line was a rolled-back probe.

---

## 4. EVERY PR AND MIGRATION FROM THIS SESSION

**PRs (all merged into `main`):**
`#2012` Create Table seat-law clamp · `#2013` horse fill starvation + held-empty 30h walk · `#2038` seat never ends by DELETE + retire `remove_horse` + bomb repair sweep · `#2054` a closed table is not a joinable table (SNG board) · `#2115` treasury journal truth · `#2144` commit 5 applied migrations · `#2157` seat-first deadlock retry

**Migrations applied to production (all now committed):**

```
20260831002318_backfill_completed_tournaments_ended_at
20260831090516_repair_double_stamped_spin_prize_column
20260831101605_schedule_reconcile_ledger_nightly
20260831103651_ledger_trigger_stops_inventing_the_treasury
20260831104152_journal_the_real_treasury_writers
20260831104550_treasury_baseline_and_reconcile_from_the_line
20260831110447_reconcile_nightly_is_not_browser_callable
20260831111557_bomb_backfill_repairs_multi_winner_pots
20260831112020_schedule_bomb_multi_winner_repair
20260831115135_seat_first_count_sync_survives_a_deadlock
20260831120000_retire_remove_horse_the_delete_that_refunds_nothing
```

**New pg_cron jobs:** `reconcile-ledger-integrity-6h` (`55 */6 * * *`), `bomb-multi-winner-repair-hourly` (`20 * * * *`).

---

## 5. ⚠️ KNOWN HOLES — THINGS THAT ARE STILL WRONG

1. **Only 4 of 23 functions that write `clubs.chip_treasury` journal to `chip_ledger`.** Journaling now: `fn_horse_fund_from_treasury`, `credit_club_rake_to_treasury`, `atomic_distribute_rake` (treasury branch), `fn_horse_seat_from_treasury`. **NOT journaling:** `fn_club_bank_send`, `fn_club_bank_claim_back`, `fn_club_bank_reverse`, `fn_wallet_claim_back`, `fn_member_leave_to_treasury`, `fn_leave_club_atomic`, `fn_admin_remove_player_chips`, `fn_seed_horses_to_floor`, `fn_mint_chips_from_diamonds`, `fn_mint_club_chips`, `fn_credit_treasury`, `fn_debit_treasury`, `fn_union_send_to_club_atomic`, `fn_union_promo_send`, `fn_union_clawback_from_club`, `fn_close_club_wallets_on_union_join`, `fn_apply_prize_guarantee`, `decrement_club_treasury`, `fn_union_settle_player_pnl`.
   **The treasury check reads `ok` today only because none of those 19 moved money since the cutover.** It WILL go critical the first time one does. **That is the check working.** The fix then is to journal that writer — **NOT to move the baseline.**
2. **`atomic_distribute_rake`'s treasury branch is DORMANT in production** — all 3 clubs carry a `union_id`, so every hand routes to `union_rake_wallet`. Its journaling was proved by forcing the route in a rolled-back probe, never observed live.
3. **`chip_ledger.category` is almost always `'adjustment'`** because **nothing anywhere sets `app.ledger_category`** — zero callers in `server/src`, `src`, or `supabase/migrations`. The category breakdown is unreliable as a diagnostic.
4. **`from_label` / `to_label` are ALWAYS NULL** (0 of 53,224 rows). `CashierPage.tsx:964` would render `null → null` if a description were ever missing. Latent.
5. **Treasury baseline sub-second race:** the snapshot takes `FOR UPDATE` on `clubs`, but a transaction started before the line and committing after it could contribute a row stamped before the line. Worth at most a few chips of rake.
6. **`fn_bomb_pot_ledger_gaps('30 days')` exceeds the statement timeout.** Only `'1 day'` is usable.
7. **`supabase/migrations/` has hit GitHub's 1,000-entry Contents API cap** — listings silently truncate. Check files by direct path.
8. **12 tournaments CANCELLED** in 24h despite the "tournaments run, they do not cancel" law — but **all 12 had ZERO players** and none since 18:43 on 08-30. Low priority; some sweep still has a cancel path.
9. **Dead schema:** `tournament_registrations`, `tournament_payouts`, `tournament_results` are **all empty (0 rows)** while `tournament_players` holds 185,362. Someone will write against the wrong table.
10. **`solved_spots_gold` is 80 GB of a 106 GB database** (75 GB TOAST, 8.9M rows, ~8.8 KB/row). Not bloat (0 dead tuples) — real GTO solver output. Dominant storage cost.
11. **`data_audit_log`: 3 GB, `seq_scan = 0`, `idx_scan = 0`** — never read by anything, ever.
12. Other MCP servers (playwright, exa, memory, context7, sequential-thinking) flap in and out of availability. All `plugin:engineering:*` need OAuth Dan has not completed.

---

## 6. THE PHASE PLAN — WHERE YOU ARE

| Phase      | Scope                           | Status                 |
| ---------- | ------------------------------- | ---------------------- |
| 1 of 6     | Money-integrity alarms          | ✅ **DONE + verified** |
| **2 of 6** | **Cash table config integrity** | ⬅️ **YOU START HERE**  |
| 3 of 6     | Cash rule guards                | pending                |
| 4 of 6     | Deploy truth watchdog           | pending                |
| 5 of 6     | Human-path E2E                  | pending                |
| 6 of 6     | Storage/cost + dead schema      | pending                |

### PHASE 2 OF 6 — CASH TABLE CONFIG INTEGRITY (START HERE)

**Item 2A — Three conflicting buy-in column pairs on EVERY live cash table.**
All 26 live cash tables disagree on both pairs, **none null**. On a 1/2 table:

| Column pair                       | Value          | Implies                                      |
| --------------------------------- | -------------- | -------------------------------------------- |
| `min_buy_in` / `max_buy_in`       | 80.00 / 400.00 | 40–200 BB ✅ **the one the engine enforces** |
| `min_buyin` / `max_buyin`         | 40 / 200       | different units                              |
| `min_buy_in_bb` / `max_buy_in_bb` | 2 / 25         | 2–25 BB ✗ nonsense                           |

I proved which is real by looking at money actually moved: buy-ins cluster **80.00–280.00**, matching `min_buy_in`/`max_buy_in`. The other four columns are stale but LIVE — anything reading `max_buy_in_bb` would cap a player at 50 chips on a table advertising 400. **Same class of trap as the seat-law bug already fixed (#2012).**
**Task:** pick one canonical pair; migrate the others to generated columns or drop them; find and fix every reader/writer (`TableConfigPage.tsx` `buildTableData`, the lobby, the engine, `atomic_table_buyin`); add a test pinning the canonical field.

**Item 2B — Rake config on live tables is a sentinel, not a value.**
Every live cash table has **`rake_percent = -1.00` and `rake_cap_bb = -1.00`**. Rake IS taken correctly (6,774.94 over 2h; max 5.00 on 1/2 = 2.5 BB, 7.50 on 2/5 = 1.5 BB), so the real config resolves elsewhere. Problem: any lobby/table UI reading these to show "5% / 3 BB cap" renders `-1`, and **cap adherence cannot be asserted from the table row at all.**
**Task:** find where rake config actually resolves from; either populate the columns or make the resolution readable; then add a cap-adherence assertion.

### PHASE 3 OF 6 — CASH RULE GUARDS (identified, none verified)

- **"No flop, no drop"**: 4,271 cash hands → 2,165 rake rows (51%). Plausible for preflop-ending hands but **NOT confirmed** as intended vs dropped rake.
- **Rathole prevention**: leaving with a big stack and re-buying short. `atomic_table_buyin` has a rathole-clear path; the RULE is unverified.
- **Sit-out eviction** (`fn_evict_sitting_out_cash_players`, pg_cron every minute): confirm it treats horses IDENTICALLY — that exact exemption was a real bug fixed 2026-08-27.
- **BBJ contributions** on cash hands.
- **60-second waitlist seat hold**: migrations `20260831004720_sixty_second_exclusive_seat_hold` and `20260831093748_waitlist_one_active_row_and_one_live_hold_per_player` are APPLIED; PR **#2014** `feat/seat-hold-60s` may still be OPEN. **Verify whether the client half shipped.**
- Cash table features never exercised by a human: straddle, run-it-twice, insurance, rabbit hunt, bomb pots.

### PHASE 4 OF 6 — DEPLOY TRUTH WATCHDOG

Build the Club Arena equivalent of World Hub's `publish-watchdog.yml`: compare the engine's actually-running SHA against `main` and alert past a budget. See §2.7. Must NOT share a failure domain with the thing it watches.

### PHASE 5 OF 6 — HUMAN-PATH E2E (highest value remaining)

**Nothing verified so far involved a human.** In 7 days across 442 human accounts: **14 human sit-downs, 10 human tournament registrations, 0 humans seated now** (last at 22:00 on 08-30). Everything proven was the horse fleet exercising the SERVER path. Horses have no browser, so they cannot test: client rendering, auth/session handoff from World Hub, cashier/deposit UI, seat reservation + 60s hold, mobile 375px, animation timing on real hardware.
**Test account:** `daniel@bekavactrading.com`; password stored as `TEST_USER_PASSWORD` in `.env.local` (**never commit it**). All features unlocked, works on localhost and production. Production URL: `https://smarter.poker/hub/club-arena/`.
Use the Claude-in-Chrome MCP or the built-in browser. Playwright MCP is flaky.

### PHASE 6 OF 6 — STORAGE / COST + DEAD SCHEMA

`solved_spots_gold` 80 GB (75 GB TOAST) of a 106 GB DB — question whether cold solver grids belong in Postgres vs object storage. `data_audit_log` 3 GB never read. `hand_state_snapshots` 6.1 GB, `ca_hand_player_idx` 3.7 GB (12.1M rows). Drop/document the 3 empty `tournament_*` tables. `vip_points_ledger` (3.8M rows) and `rakeback_stats_applied` (4.9M rows) have very low index-scan counts relative to size — possible unused/missing indexes.

---

## 7. VERIFY PHASE 1 IS STILL GOOD (run this first, ~10 seconds)

```sql
select
 (select count(*) from ledger_reconcile_log where run_date=CURRENT_DATE and severity='critical') criticals,
 (select count(*) from public.fn_unaccounted_seat_exits('1 day'::interval)) unaccounted_exits,
 (select count(*) from public.fn_bomb_pot_ledger_gaps('1 day'::interval)) bomb_gaps,
 (select count(*) from ca_ledger_write_failures) write_failures,
 (select count(*) from ca_seat_stack_exits where exit_kind='deleted'
    and occurred_at > '2026-08-31 10:36:54+00') seat_deletes_after_fix,
 (select count(*) from cron.job
    where jobname in ('reconcile-ledger-integrity-6h','bomb-multi-winner-repair-hourly') and active) alarms,
 (select count(*) from tournaments where status='COMPLETED' and ended_at is null) completed_no_ended_at,
 (select count(*) from hand_history where created_at > now() - interval '15 minutes') hands_15m;
```

**Expected:** `0, 0, 0, 0, 0, 2, 0, ~2700`. Anything else — investigate before starting Phase 2.

**Platform health (all 7 variants must be dealing):**

```sql
select t.game_variant, count(*) tables,
  sum((select count(*) from table_seats s where s.table_id=t.id and s.left_at is null)) seated,
  max((select max(h.created_at) from hand_history h where h.table_id=t.id)) last_hand
from tables t where t.tournament_id is null and t.status='running'
group by 1 order by 1;
```

Expect nlh, pineapple, plo4, plo5, plo6, plo8, short_deck all present with recent hands.

**SNG board alive (it was dead 16 hours):**

```sql
select status, count(*) from tournaments
where tournament_type='SNG' and created_at > now() - interval '2 hours' group by 1;
```

**Money conservation:**

```sql
with s as (
  select t.id, t.tournament_type, t.prize_pool,
    (select coalesce(sum(w.amount),0) from wallet_transactions w
      where w.related_entity_id=t.id and w.type='credit' and w.category='prize') credited
  from tournaments t where t.status='COMPLETED' and t.ended_at > now() - interval '2 hours')
select tournament_type, count(*) events,
  count(*) filter (where abs(credited-prize_pool) > 0.005) money_mismatch,
  round(sum(prize_pool)::numeric,2) pools, round(sum(credited)::numeric,2) credited
from s group by 1;
```

`money_mismatch` must be **0**; pools must equal credited.

---

## 8. HOW DAN WANTS YOU TO WORK

- **One step at a time.** Finish and verify before the next. Do it right, not fast. No band-aids. However long it takes.
- **Never ask permission for obvious work — just do it.** Only stop for genuine forks.
- **When corrected, change course immediately.** Do not defend the rejected path.
- **Fix-first:** when auditing, FIX each issue as you find it. Do not audit 10 things then ask what to fix.
- **Verify on real hardware. "It compiles" is not verification.** Dan explicitly praised checking the DB over trusting the CI tick — keep doing that.
- **Never say "looks good."** Never call horses "bots."
- **Mobile-first: 375px, then scale up.**
- **Report format Dan asked for:** finish a phase, then say **"PHASE N OF 6 IS DONE"** + summary, then **"READY TO START PHASE N+1 OF 6."**
- Handoffs are pasted **in chat** as copy-pasteable markdown, with the on-disk file as backup.
- Be honest about what you could NOT make work. Dan values that over a clean-looking report.

---

## 9. YOUR IMMEDIATE NEXT ACTIONS

1. Run the §7 verification block. Confirm `0,0,0,0,0,2,0,~2700`.
2. Confirm all 7 cash variants are dealing and the SNG board is alive.
3. Start **Phase 2, Item 2A**: trace every reader and writer of the six buy-in columns across `src/` (client), `server/src/` (engine), and `supabase/migrations/` (RPCs — especially `atomic_table_buyin`). Establish definitively which the engine enforces (evidence says `min_buy_in`/`max_buy_in`), then converge the rest.
4. Ship per §2.3, verify per §2.7 (DB, not CI), and commit the migration file AND apply it (§1.10).
5. Report **"PHASE 2 OF 6 IS DONE"** + summary + **"READY TO START PHASE 3 OF 6."**

Good hunting.
