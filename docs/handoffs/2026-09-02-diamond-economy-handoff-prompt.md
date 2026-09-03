# HANDOFF PROMPT - THE DIAMOND ECONOMY AUDIT, STANDARD, FIX AND ROADMAP

**To the agent receiving this: read every word before you touch anything. You are replicating, 1:1, the process that was run on the CHIP economy of Smarter Poker / Club Arena on 2026-09-02, this time for the DIAMOND economy - from the Mint to the players and everything in between - and preparing the ground for the future "Diamond Arena". Written 2026-09-02 ~22:40 UTC by the Cowork session that ran the chip work (session link in commit trailers). Truthfulness labels: CONFIRMED (verified by query or command), UNVERIFIED (believed, not proven), UNKNOWN (you must inspect).**

---

## 0. Dan's directive, verbatim, and what it means

> "WE WILL PROBABLY NEED TO DO A SIMILAR AUDIT OF THE DIAMOND ECONOMY, EVERYTHING FROM TOP TO BOTTOM, AS ONCE THE CLUB ARENA IS FULLY BUILT OUT AND FINISHED, THE "DIAMOND ARENA" WILL BE BASICALLY A CLONE OF THE CLUB ARENA, BUT EXCEPT WITH "CHIPS" USERS ALL PLAY INSIDE ONE CLUB WITH DIAMONDS THAT THEY BUY OR EARN ON THE PLATFORM. ... A SIMILAR AUDIT, REVIEW, ENHANCEMENT, IMPROVEMENT AND OPTIMIZATION OF THE DIAMOND ECONOMY, FROM THE MINT TO THE PLAYERS AND EVERYTHING IN BETWEEN."

The chip directive it clones (Dan, 2026-09-02 morning, binding on you too): every movement 100% accurate at all times on all levels; never over- or under-pay; hard rules enforced in the database with layers of protection; find the industry standard, compare what we built against it, then make every improvement, enhancement, audit, fix and upgrade needed; build fully, verify before claiming success; **"IF THERE ARE ANY THAT YOU CONSIDER HIGH RISK FOR DAMAGING CODE OR OTHER PAGES, DO NOT BUILD THEM"**; swarms are welcome; when not finished, deliver a phased plan. Every rule in the chip playbook applies to diamonds.

Two things make diamonds different from chips and shape everything below:

1. **Diamonds are bought with real money** (`diamond_purchases`, app-store / card flows) and **earned** (trivia, daily challenges, streaks, training, share rewards, login bonuses, signup grant). That makes the diamond economy a virtual-currency liability with real-money on-ramps: refunds, chargebacks, breakage, deferred revenue, promotional-versus-purchased separation, and anti-farming are part of the standard, not extras.
2. **Diamonds will become the chip of the Diamond Arena**: one platform club where everyone plays cash games, MTTs, spins, SNGs and satellites in diamonds. Everything the chip standard built for tournaments (escrow, obligations, one settle function, pool caps, funded guarantees, rake spec, BBJ, promo) must exist for diamonds, and the design must decide up front whether diamonds-at-the-table are the same asset as diamonds-in-the-wallet or a per-arena escrow of them.

---

## 1. What was done for chips (your template - read these files in this order)

All in the repo `Smarter-Poker/Smarter-Poker-Club-Arena` on `main` (or on PR #2716 until it merges):

1. `docs/CHIP-ACCOUNTING-STANDARD.md` - the industry standard (GLI-19 v3.0, NJ DGE 13:69O, UKGC LCCP, PA PGCB, MGA, operator policy) as 18 principles (S1-S18) + the conservation identity; what we built, path by path, with production numbers; the target chart of accounts, the chip lifecycle per game type, hard rules R1-R11, layers of protection, gap list, lane plan, decisions for Dan. **Your first deliverable is `docs/DIAMOND-ACCOUNTING-STANDARD.md` in exactly this shape.**
2. `docs/CHIP-ACCOUNTING-ROADMAP.md` - the honest scorecard (MEETS / PARTIAL / DOES NOT MEET per area) and seven phases. **Your last deliverable is `docs/DIAMOND-ACCOUNTING-ROADMAP.md` in this shape.**
3. `docs/audits/2026-09-02-chip-standard-round2/lane1..4` - the four read-only audits: every chip path and legacy route; the union/club/agent hierarchy vs industry practice; the conflict check on everything built the same day; BBJ/backup/promo/spins/rake. **Run the same four audits for diamonds** (the hierarchy audit becomes: platform -> purchase providers -> reward engines -> players -> Diamond Arena club).
4. `docs/SWARM-BRIEF-CHIP-STANDARD.md` and the round-2 brief at `/Users/smarter.poker/Documents/.agent-trees/club-arena/SWARM-BRIEF-R2.md` - the lane operating contract (tools, rules, definition of done). **Copy it as `SWARM-BRIEF-DIAMOND.md`, change only the names.**
5. `docs/changelog/2026-09-02-chip-std-*.md` - one changelog per lane, written from what was OBSERVED (numbers, rolled-back probe transcripts), never intentions.
6. `docs/HANDOFF_CURRENT_STATE.md`, `AGENT-PLAYBOOK.md`, `.agents/rules/00-agent-playbook.md`, `CLAUDE.md` sections 10.x - binding operating rules (verification pass, worktrees, no --no-verify, fix your own build, zero-assumption doctrine, horses are players, Title Case, no em dashes, no emoji in source).
7. Memory files for continuity: `/areas/club-arena-chip-standard.md`, `/areas/club-arena-zero-drift.md`, `/areas/club-arena-zero-drift-round2.md` (read via the memory tools before starting; write your own `/areas/club-arena-diamond-economy.md` as you go).

The chip work in one paragraph, so you know what "done" looked like: measure first (production queries, never the repo alone - the repo mirror of money functions is stale in places); write the standard from sources; find the root cause (for chips: a buy-in was destroyed at the wallet and re-minted at payout, eleven independent payers, unfunded guarantees, a rake spec split four ways, agents moving money by migration); build the fixes as independent lanes, one PR + one migration + rolled-back probes + a law test each, run as a swarm; then a read-only conflict audit of everything built that day; then the scorecard and phased roadmap; hand Dan the decisions that are his. What shipped for chips: `tournament_obligations` + `fn_settle_tournament_obligation` (one payer, a place paid once, pool-capped), engine payers re-pointed, six DB repair arms re-pointed, a money-path violation log (R3, log-only), one rake spec for engine and DB, one cash-out path, tournament chips conserved hand by hand, freerolls forced to FREE BUY (0 entry / 1.00 rebuy and add-on), a kill switch, four-eyes adjustments, an hourly per-account trial balance, a direct-write view, an escrow shadow, satellite seats paid from the satellite's own pool and seat guarantees funded at lock. What did NOT ship (Dan's high-risk rule): refusing at the money-path trigger, REVOKE on balance columns, prize_pool as a derived column, automatic kill switch, deleting legacy paths (gated on seven days of measured zero use).

---

## 2. Environment and tools (CONFIRMED on 2026-09-02)

- **You work on Dan's Mac through MCP.** Shell: `mcp__remote-devices__counselors__host_terminal` (real bash on the Mac). `node` is not on PATH: `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`. Each call has a ~60s limit; anything slow runs as `nohup ... > /tmp/<name>.log 2>&1 < /dev/null & disown` and you poll the log. If the tool says the device did not respond, wait and retry once; the MCP server can reconnect mid-session and your worktree state survives.
- **Repo**: main clone `/Users/smarter.poker/Documents/club-arena` (NEVER develop there); worktrees under `/Users/smarter.poker/Documents/.agent-trees/club-arena/<name>` created with `git worktree add -b <branch> <path> origin/main`; symlink `node_modules` from the main clone. Remote `git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git` over SSH works. Never rebase; merge `origin/main`; `docs/LAWS.md` conflicts resolve by union (keep both sides' rows).
- **GitHub**: `gh` on the Mac has a dead keyring token. Use the REST API with the token from `grep '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2- | tr -d '"'` (never print it). **Agent Autopilot opens a PR for ANY pushed branch and auto-merges any non-draft PR on green** - PATCH the PR body it opened instead of POSTing a second one; use draft only to hold something for Dan.
- **Production database**: Supabase project `kuklfnapbkmacvwxktbh` ("PokerIQ-Production", Postgres 17). Read with `mcp__Supabase__execute_sql` (a multi-statement script returns its last SELECT even when it ends in ROLLBACK - that is the probe shape; regex `{n,m}` fails, use unbounded quantifiers or substr/position; `\b` is backspace, use `\y`). Apply DDL ONLY with `mcp__Supabase__apply_migration` (name = the migration file name without `.sql`); it registers in `supabase_migrations.schema_migrations`. The MCP client times out at 60s but the transaction may have committed - verify before re-applying.
- **The engine** (Node, `server/`) is deployed to Hetzner by `.github/workflows/auto-deploy-hetzner.yml` at fixed windows only (18, 22, 04, 10, 14 America/Chicago) and needs the maintenance break to park every table first; deploys have failed for hours on "the maintenance break never opened" and an escalation fires when production is >= 190 minutes behind. **Never pass `force: true`.** `ca_engine_deploy_attempts` records every attempt. Migrations land immediately; engine code lands at the next successful window - plan every DB/engine pair so the DB half is safe with BOTH engine builds.
- **Diamond Arena web app**: UNKNOWN - grep the repo for `diamond_arena`, `DiamondArena`, `diamond-arena` (`diamond_arena_events` table and `profiles.diamond_arena_preferences` exist, CONFIRMED). The second repo `~/Documents/Smarter-Poker-World-Hub` (ops API + publish pipeline) may hold diamond purchase webhooks - UNKNOWN, inspect.

---

## 3. Binding rules (copied from the chip brief; they are Dan's, not mine)

1. **DDL: one migration file, one transaction (BEGIN/COMMIT), applied ONCE.** Every DDL statement triggers a ~28s PostgREST reload and a burst of them caused a live winner-credit failure on 2026-09-02 (repaired by the sweep). No retry loops. **No DDL probes** - never `CREATE OR REPLACE` "to test", even inside a rolled-back transaction. If apply fails, read the error, fix the file, apply once more. Prefer one migration per lane; a trigger on a hot table gets its own migration with `SET LOCAL lock_timeout = '4s'`.
2. **Never spend real diamonds to test a rule.** Probe inside a transaction you ROLL BACK. Never credit a real balance "to see if it works". **Never move diamonds by migration** (no back-pay, no clawback): write obligations or incidents.
3. **Read the LIVE body before you replace a function**: `select pg_get_functiondef(oid) from pg_proc where proname='...'`. The repo mirror is stale in places. Keep every behaviour you did not set out to change; when you compose a new body from an old file, prove it (the chip session compared reconstructed body length to `length(prosrc)` before applying).
4. **Horses are players** (CLAUDE.md 10.5). Never exclude a horse from anything a human gets.
5. **Never push a red test.** `npx vitest run <paths>` (root) / `cd server && npx vitest run <paths>`; `npx tsc --noEmit` in each root you touched. Every `*.law.test.ts` needs a row in `docs/LAWS.md` (`tests/law-registry.law.test.ts` enforces it) with a negative control.
6. **Own changelog per lane**: `docs/changelog/2026-09-<dd>-diamond-<lane>.md`. Never `MIGRATION-CHANGELOG.md`.
7. **Declare new schema** in `scripts/ci/schema-manifest.d/diamond-<lane>.json`. Never hand-edit the big manifests.
8. **New tables**: `REVOKE ALL FROM anon, authenticated`; RLS on; `service_role` only unless the browser must read. **New money RPCs**: `SECURITY DEFINER`, `SET search_path = public`, in-file REVOKE/GRANT stating who may call (the pre-push `check-definer-authorization` reads the branch, the CI `Telemetry Exposure` job scans the LIVE database for unscoped definers a browser can execute - a live exposure fails every PR until fixed), registered in `ca_money_rpc_registry` if it writes a balance.
9. **No emoji in source. No em dashes (U+2014) anywhere, docs included. Title Case in player-facing copy.**
10. **Commits**: `git -c user.name=Smarter-Poker -c user.email=254329056+Smarter-Poker@users.noreply.github.com commit ...`; trailer `Co-Authored-By` + `Claude-Session` lines as in the chip commits. Never `--no-verify`. The pre-push hook takes ~3 minutes: push with nohup and poll.
11. **Do not wait on CI.** Open the PR, report its number, stop.
12. **Dan's risk rule**: anything that could refuse a legitimate live movement, block a purchase or an earn, or change a hot-path result ships LOG-ONLY first (record the would-be refusal + info incident). If you judge an item high-risk, do not build it: write it under "Decisions that are Dan's".
13. **Report only what you verified.** Numbers from queries you ran; label the rest UNVERIFIED. Rolled-back probe transcripts go in the PR body and the changelog.
14. **Continuity**: write `/areas/club-arena-diamond-economy.md` in memory (frontmatter: name, description, sources [cowork], aliases) as you go - Dan's rulings as `[stated]`, your state as prose - and `docs/changelog/<date>-diamond-orchestrator.md` at the end. The next agent must be able to pick up from primary sources alone.

---

## 4. The diamond economy as it stands (measured 2026-09-02 ~22:30 UTC unless marked)

**Stores (CONFIRMED, `information_schema`)**: `profiles.diamonds` (canonical, 1,030,092 total) mirrored by trigger into `profiles.diamond_balance` (`fn_diamond_balance_mirrors_canonical`); `diamond_wallets` (619,879 total - it was ~50 on 09-01, so something moved 620K into it in the last day: **UNKNOWN, inspect first**); `club_diamond_wallets`, `user_diamonds`, `user_diamond_balance`, `user_progress.diamonds`, `club_members.diamonds`, `club_memberships.diamonds`, `bot_profiles.diamonds`, `diamond_platform_budget`; the dead `public.wallets` pool that still holds **732,591,994.33 diamonds** (frozen, detector only, Dan's decision pending since 09-01); side tables `diamond_purchases`, `diamond_reward_catalog`, `diamond_reward_claims`, `vip_diamond_purchase_requests`, `trivia_diamond_award_limits`, `diamond_arena_events`. Journal: `diamond_transactions` (append-only since 09-01, SIGNED `amount`, `type` is semantic; only 2 rows in the last 24h, both `daily_login` - **either the economy is nearly idle or most writers still do not journal: measure**). `diamond_ledger` is DEAD (0 rows). `ca_diamond_snapshots` hourly (`fn_ca_diamond_snapshot`, cron `ca-diamond-snapshot-hourly`) computes supply and "unexplained" against the journal; `ca_diamond_balance_audit` and `fn_ca_audit_diamond_change` exist (trigger audit of changes - read them).

**Writers (CONFIRMED)**: 56 functions mention diamonds. Known money-moving ones: `add_diamonds_to_balance`, `award_diamonds`, `award_diamonds_v2`, `award_purchase_diamonds`, `deduct_diamonds`, `fn_add_diamonds`, `fn_credit_diamonds` (x2 overloads), `increment_diamonds`, `initialize_user_diamonds`, `create_user_wallets`, `initialize_player_profile`, `handle_new_user` (signup grant of 500, journaled since 09-01), `transfer_diamonds_credit` / `transfer_diamonds_deduct` / `send_wallet_diamond_transfer` (P2P), `send_stream_gift`, `fn_award_share_streak_diamonds`, `fn_trivia_award_diamonds`, `claim_daily_challenge(s)`, `complete_daily_challenge`, `buy_streak_freeze`, `ca_promo_vault_buy`, `fn_purchase_club_chips` and `fn_mint_chips_from_diamonds` (the **diamonds -> chips bridge**: is it a burn of diamonds and a mint of chips through `fn_ca_mint`, or a conversion that inflates one side? the chip audit found `fn_mint_chips_from_diamonds` with zero use and outside the Mint - decide its fate), `fn_purchase_club_shop_item_diamonds`, `fn_purchase_time_banks`, `purchase_merch_with_diamonds_atomic`, `refund_diamond_merch_order_atomic`, `purchase_vip_with_diamonds_atomic` (v1, v2, v3 - three versions live), `settle_diamond_card_purchase_atomic`, `reconcile_diamond_purchase_refund`, `fn_atomic_buyin` (chip buy-in; `buyin.js` diamonds->chips returns 410, dead since 04-29), `fn_union_send_to_member_zd3core`, `cleanup_reserved_certification_account`, `fn_ca_mint` / `fn_ca_burn` (the Mint - chip audit found them executable by `authenticated` and burn unregistered: CONFIRMED gap), `run_trivia_economy_audit_v1`, `economy_invariants`, `fn_check_anti_farming_gift_cap`. Client-side: grep `src/` and `server/src/` for `diamonds`, `.rpc('award_diamonds`, `deduct_diamonds`, `diamond_purchases`, `StoreKit`/`RevenueCat`/`Stripe`/`webhook` - UNKNOWN which purchase provider is live.

**Already hardened on 09-01/09-02 (CONFIRMED by migration names; read their statements)**: `ca_signup_diamonds_journal_their_own_grant`, `ca_diamond_journal_locks_and_the_watchers_widen`, `cert_diamonds_are_tracked_not_drift`, `ca_diamond_watch_tolerates_cert_reclassification`, `a_reversal_is_not_a_mint` (+ close the browser door), `a_correction_is_not_a_mint`, `the_mint` / `the_mint_issuance_and_retirement` (chips -> clubs/unions only, diamonds -> individual profiles only; `ca_mint_ledger` exists but had 0 rows for chips - check diamonds), `diamond_snapshot_explains_the_test_account_retirement`, `a_diamond_cannot_move_anonymously`, `the_seven_diamond_writers_that_never_journalled`, `the_buyin_and_the_challenge_journal_their_diamonds`, `ca_hr2_phase2_mint_velocity_and_guard_def_watch` (mint velocity cron). Your audit starts from these; do not redo them, verify them.

**Known open questions (UNVERIFIED / Dan)**: the 732.59M diamond dead pool; whether purchased and earned diamonds are distinguishable (they are one column today: CONFIRMED `profiles.diamonds`), which matters for refunds, chargebacks, breakage accounting and any future cash-out; three live versions of the VIP purchase function; P2P transfers and gifts (anti-farming caps exist: `fn_check_anti_farming_gift_cap`); what `diamond_platform_budget` funds and whether reward engines (trivia, challenges, streaks, training, share rewards, login) are budgeted liabilities or unlimited issuance; `feature_pricing.diamond_cost`, `vip_pricing`, `merchandise_*.price_diamonds`, `promo_vault_catalog.diamond_cost`, `training_tournaments.entry_fee_diamonds` (a diamond tournament already exists in training - the first Diamond Arena prototype: audit it), `throw_usage.paid_diamonds`, `premium_feature_access.diamonds_spent`.

---

## 5. The industry standard you must write (sources to research; cite them)

Do the web research first, as the chip session did (GLI-19 v3.0 Interactive Gaming Systems; NJ DGE N.J.A.C. 13:69O; UKGC LCCP 4.1/4.2 and RTS; PA PGCB 811a; MGA). For diamonds add the virtual-currency and in-app-purchase body of practice:

- **Closed-loop virtual currency / social casino accounting**: purchased currency is a customer liability until consumed (deferred revenue, ASC 606 / IFRS 15 for virtual goods: consumable vs durable, breakage recognized on the consumption pattern); promotional / earned currency is a marketing liability held separately; both are never "money" unless a cash-out exists (state money-transmitter and sweepstakes-law lines - if Dan ever allows redemption, the standard changes: say so explicitly).
- **App-store rules** (Apple App Store Review Guideline 3.1.1, Google Play Billing): consumables purchased through IAP, receipts validated server-side (StoreKit 2 / Google Play Developer API), refunds and chargebacks reverse the grant (and the chain of anything bought with it), no real-money redemption inside the app, no cross-platform transfer of purchased currency without disclosure.
- **Payment providers** (Stripe / RevenueCat / Adyen): idempotent webhook processing, signed events, duplicate-delivery handling, refund and dispute webhooks reverse balances atomically, reconciliation of provider settlement vs internal grants daily.
- **Earn engines**: budgets per source with hard caps (per user per day, per source), anti-farming (device / account linking, velocity), award idempotency keys per (user, source, event), award catalog versioned and logged.
- **P2P transfers and gifts**: allowed only if the product intends it; every transfer double-entry, capped, logged, reversible within a window, never able to convert promotional into purchased (or vice versa) silently.
- **Poker with virtual currency** (Zynga Poker, WSOP app by Playtika, PokerStars Play, Governor of Poker): one house club, the same tournament and cash accounting as real money (escrow, obligations, rake as a sink), a rake / house take that is a **burn** or a house account, jackpots as reserved liabilities, promo tables, and the supply identity `ISSUED (purchased + earned) = wallets + tables + escrow + house accounts + burned`.
- **GLI-19 / NJ principles that carry over unchanged**: segregation, double entry, append-only journals, idempotency enforced by constraint, no negative balances, four-eyes on manual adjustments, daily trial balance naming the account, restart neither loses nor duplicates.

Write it as `docs/DIAMOND-ACCOUNTING-STANDARD.md`: principles D1-Dn with sources; the conservation identity; what we built path by path with production numbers; the target chart of accounts (at minimum: `player_diamonds_purchased`, `player_diamonds_earned` or one balance with a purchased/earned sub-ledger - Dan's call, present both), `diamond_table_stack`, `diamond_tournament_escrow`, `diamond_house` (rake sink or house account), `diamond_jackpot`, `diamond_promo_budget`, `diamond_reward_budgets` per engine, `diamond_purchase_clearing` (provider settlement), `diamond_refund_reserve`, `diamond_issuance` / `diamond_retirement`, `diamond_suspense`); the lifecycle per movement (purchase, refund, chargeback, earn per engine, spend per sink, transfer, gift, arena buy-in / cash-out / payout / rake / jackpot, expiry / breakage, account deletion); hard rules; layers of protection; gap list; lane plan; decisions for Dan.

---

## 6. The process, step by step (do not skip or reorder)

**Phase 0 - reconstruct and measure (read-only, 4 parallel lanes, each writes `docs/audits/<date>-diamond-economy/lane<N>-<name>.md` with every query and result)**

- Lane 1 - every writer of every diamond store (pg_proc scan for UPDATE/INSERT on each column, triggers, pg_cron jobs, engine and client RPC calls), classified STANDARD / LEGACY / PLUMBING, with 24h use from `diamond_transactions`, `ca_diamond_balance_audit`, and application_name; a 30-day supply reconstruction: purchased vs earned vs granted vs transferred vs spent vs burned vs unexplained.
- Lane 2 - the on-ramps and off-ramps: purchase providers (which ones are live, webhook handling, idempotency, refund and chargeback reversal, provider-vs-internal reconciliation), the diamonds -> chips bridge, merch / VIP / promo vault / time banks / throws / premium features, account deletion (`ca_profile_deletions.diamonds`), and how each fits the standard's principles; plus the industry research of section 5.
- Lane 3 - the earn engines: trivia (`fn_trivia_award_diamonds`, `trivia_diamond_award_limits`, `run_trivia_economy_audit_v1`), daily challenges, memory game, training achievements and tournaments (`training_tournaments.entry_fee_diamonds` - the prototype arena), streaks, share rewards, login, stream gifts, P2P: budgets, caps, idempotency, anti-farming, and 30-day issuance per engine.
- Lane 4 - the Diamond Arena readiness review: what `diamond_arena_events`, `profiles.diamond_arena_preferences` and any `diamond_arena` code already do; a gap analysis of every chip-standard component (obligations, settle function, escrow, pool cap, funded guarantees, freerolls, rake spec, BBJ, promo, kill switch, trial balance, escrow shadow, one cash-out path, hand-by-hand conservation) against "the same thing in diamonds inside one platform club"; and the design decision list (same asset or arena escrow; rake as burn or house account; jackpots; whether purchased and earned diamonds play at the same tables; whether horses play in the arena).

**Phase 1 - the standard** (`docs/DIAMOND-ACCOUNTING-STANDARD.md`), then a swarm brief (`docs/SWARM-BRIEF-DIAMOND.md`).

**Phase 2 - the fix lanes (swarm, one worktree / branch `fix/diamond-<lane>` / migration / changelog / law test / PR each; log-only for anything that can refuse)**. Expected lanes, adjust from your audit: A one Mint for diamonds (issuance and retirement only through `fn_ca_mint` / `fn_ca_burn`, both closed to `authenticated`, `ca_mint_ledger` populated, every grant path through it); B one credit function and one debit function with idempotency keys enforced by unique constraint, every legacy writer re-pointed (three VIP versions become one); C purchase clearing: provider webhook idempotency, refund and chargeback reversal as linked compensating entries, daily provider-vs-internal reconciliation with a variance incident; D earn budgets: per-engine budget accounts funded from `diamond_platform_budget`, caps enforced at the constraint, award keys per (user, source, event); E transfers and gifts: double entry, window, cap, reversal, no promo-to-purchased laundering; F the diamonds -> chips bridge as a burn + mint through the Mint or retired; G controls: hourly per-account trial balance (`fn_ca_diamond_trial_balance`), suspense must be zero, four-eyes on manual adjustments (reuse `ca_manual_adjustments` with `asset = 'diamond'`), kill switch (`ca_payout_freeze` scope `diamond_*`), direct-write log; H the Diamond Arena accounting clone (design first, then `diamond_tournament_obligations` / settle function / escrow / rake spec in diamonds, built log-only against the training tournaments prototype until Dan opens the arena).

**Phase 3 - the conflict audit** (read-only, same day as the lanes): every function two lanes touched, live body is the union of both intents; every key shape vs every consumer; every trigger order on `profiles`; chip-side interactions (the bridge, the Mint, `ca_payout_freeze`, `ca_manual_adjustments`, the trial balance now spanning two assets).

**Phase 4 - the scorecard and roadmap** (`docs/DIAMOND-ACCOUNTING-ROADMAP.md`): the honest answers, MEETS / PARTIAL / DOES NOT MEET per area with 24h evidence, phases ordered by money at risk, the delete list with its seven-day zero-use gate, and every decision that is Dan's.

---

## 7. Definition of done for every lane (verbatim from the chip brief)

- Migration applied to production (confirm in `supabase_migrations.schema_migrations`) with post-apply assertions green.
- Rolled-back probe transcript in the PR body and changelog for every money path touched (what was refused and why, what paid and how much).
- Touched-area vitest green, tsc clean, law test with negative control and a `docs/LAWS.md` row.
- Changelog written from observation.
- PR against `main` titled `fix(diamond): <lane> - <one line>` with the probe transcript, test output and migration name.
- Final message: PR number, migration names, what is log-only, what you did not build and why, decisions that are Dan's.

## 8. Reporting to Dan

Report per phase ("Phase N of X is DONE"), with the honest answer first (never claim success without the query that proves it), the numbers, what is log-only, what is Dan's. When you finish or run out of budget, write the handoff (`docs/handoffs/<date>-diamond-economy.md`) assuming the next agent can see NOTHING of your conversation - labelled CONFIRMED / UNVERIFIED / UNKNOWN - and update the memory file.

## 9. First commands

```bash
# on Dan's Mac via host_terminal
cd /Users/smarter.poker/Documents/club-arena && git fetch -q origin && git rev-parse --short=9 origin/main
mkdir -p /Users/smarter.poker/Documents/.agent-trees/club-arena && cd /Users/smarter.poker/Documents/.agent-trees/club-arena
nohup git -C /Users/smarter.poker/Documents/club-arena worktree add -b audit/diamond-economy /Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-audit origin/main > /tmp/wt-diamond.log 2>&1 < /dev/null & disown
```

```sql
-- production, read-only, first measurements
select version, name from supabase_migrations.schema_migrations where name ~* 'diamond|mint' order by version;
select type, count(*), sum(amount) from diamond_transactions where created_at >= now() - interval '30 days' group by 1 order by 2 desc;
select * from ca_diamond_snapshots order by snapshot_at desc limit 24;
select p.proname, p.prosecdef, p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc ~* 'profiles\.diamonds|diamond_wallets' order by 1;
```

Then read the four chip audits, the standard and the roadmap, and begin Phase 0.
