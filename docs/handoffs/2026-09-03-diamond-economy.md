# HANDOFF - The Diamond Economy audit, standard, fixes and roadmap (2026-09-02/03)

Written 2026-09-03 ~01:25 UTC by the Cowork orchestrator session (Claude Fable 5.1, on Dan's Mac through `mcp__counselors__host_terminal` and the Supabase MCP). This document assumes the next agent can see NOTHING of the conversation. Truthfulness labels: **CONFIRMED** (verified by query or command, evidence stated), **UNVERIFIED** (believed, not proven), **UNKNOWN** (must inspect).

The memory tool named in the previous handoff (`/areas/club-arena-diamond-economy.md`) was NOT available in this session; this file and the documents it names are the continuity record. Section 9 is the memory-shaped summary to import if the tool returns.

## 0. UPDATE 2026-09-07 (read this first)

Four days after the swarm, the verification pass found the ten lane migrations live but not on `main` (#2756 never merged; closed stale). Re-landed with the review fixes as **#3558** (`fix/diamond-p2-lanes-reland`). The twenty decisions are DECIDED in `docs/DIAMOND-RULINGS.md` (Dan delegated them). The review and every fix are in `docs/changelog/2026-09-07-diamond-review.md`; the three reviewer reports are `docs/audits/2026-09-02-diamond-economy/review1..3`. Live migrations of the review: 20260907220229, 220659, 222050, 222245, 222658. World Hub: #1558 (refund rename, dispute deadline, correlation) merged and live; `fix/diamond-welcome-grant-through-the-mint` (ensure-profile issues the welcome 500 through the Mint) pushed 2026-09-07 ~22:35 UTC. Direct DB host refused connections this session; the us-west-2 session pooler (`aws-0-us-west-2.pooler.supabase.com`, user `postgres.kuklfnapbkmacvwxktbh`, password `SUPABASE_DB_PASSWORD` in `~/Documents/club-arena/.env`) works for psql; migrations applied that way were registered in `schema_migrations` with their statements. Next: section 7 of the roadmap's Phase 1 list in `docs/DIAMOND-ACCOUNTING-ROADMAP.md` 0b, then Phase 2 (rulings 1, 2, 3, 15, 18 to build).

## 1. What this was

Dan's directive (2026-09-02, verbatim in `docs/DIAMOND-ACCOUNTING-STANDARD.md` header): audit, standardize, fix and roadmap the DIAMOND economy 1:1 as the chip work of 2026-09-02 did for chips, from the Mint to the players, and prepare the Diamond Arena (one platform club playing in diamonds). Rules inherited from the chip directive: 100 percent accuracy, hard rules in the database with layers of protection, industry standard first, build fully and verify before claiming, **do not build anything high-risk** (log-only first), swarms welcome, phased plan when not finished.

## 2. What was delivered (CONFIRMED unless marked)

| Phase | Deliverable                                                                                                                                                                                                | Where                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Four read-only audits (writers and stores; ramps, bridge, industry research; earn engines and transfers; Diamond Arena readiness)                                                                          | `docs/audits/2026-09-02-diamond-economy/lane1..4*.md` (PR #2735)                                                                                                               |
| 1     | The standard: D1-D22 with sources, conservation identity, what we built with numbers, chart of accounts, lifecycle per movement, DR1-DR16, layers of protection, gap list, lanes A-H, 16 decisions for Dan | `docs/DIAMOND-ACCOUNTING-STANDARD.md` (PR #2735)                                                                                                                               |
| 1     | The swarm operating contract with the shared interface                                                                                                                                                     | `docs/SWARM-BRIEF-DIAMOND.md` (PR #2735)                                                                                                                                       |
| 2     | Foundation migration (house account, per-engine budgets, incident log, journal class and counterparty columns, never-raising incident helper)                                                              | `supabase/migrations/20260903000735_diamond_std_foundation.sql` (PR #2735)                                                                                                     |
| 2     | Six fix lanes A, B, C, D, E, G, each: migration(s), rolled-back probes, law test with negative control, LAWS.md row, changelog, manifest fragment                                                          | C merged as #2744; A, B, D, E, G consolidated in #2756 (lane PRs #2750 #2748 #2751 #2745 #2752 closed as superseded, transcripts preserved); World Hub #1257 (Lane D disputes) |
| 3     | Conflict audit (read-only) and the one live conflict fix                                                                                                                                                   | `docs/audits/2026-09-02-diamond-economy/phase3-conflicts.md` (PR #2735); migration `20260903010547_diamond_p3_the_baseline_is_circulation_not_the_house` (PR #2756)            |
| 4     | Scorecard and phased roadmap; this handoff; orchestrator changelog                                                                                                                                         | `docs/DIAMOND-ACCOUNTING-ROADMAP.md`, `docs/handoffs/2026-09-03-diamond-economy.md`, `docs/changelog/2026-09-03-diamond-orchestrator.md` (PR #2735)                            |

Lanes F (transfers) and H (Diamond Arena clone) were NOT built: both are gated on Dan's decisions (standard 6.4, 6.16) and H is Phase 5 of the roadmap.

## 3. Production state at handoff (CONFIRMED by query, 2026-09-03 01:14 UTC)

- `SUM(profiles.diamonds)` = 1,030,092 (1,308 profiles; horses 456,781; unchanged all night: no balance moved).
- `fn_ca_mint_supply('diamonds')` = 1,030,092 (was 0). `ca_mint_ledger` diamond rows: baseline mint to house (00:22, Lane B), reversal burn from house and re-post mint to `circulation` (01:05, phase 3 fix). House mint net 0.
- `fn_ca_diamond_trial_balance(now() - 2h)`: player_diamonds 1,030,092 diff 0; diamond_house 0 diff 0; debts 0; budgets spent 0; mirror_mismatch 0; dead_stores 37,241 (informative); suspense 0; total 1,030,092 diff 0.
- `ca_diamond_snapshots` 01:10 UTC (first on Lane A's identity): total 1,030,092, profile 1,030,092, wallet 1,030,092 (mirror now complete), unexplained 0, delta_vs_prev 0. The deploy money gate did not re-arm.
- `ca_diamond_incidents`: 2 rows, both DR11 at 00:38 (Lane G's first manual watch run); the break row is resolved (01:14) with the resolution in `detail`. Cron `ca-diamond-trial-balance-hourly` at minute 20.
- `diamond_transactions` rows since 00:07: 0. `ca_diamond_balance_audit` rows since 00:37: 0. The platform was idle across the whole window; **no rewritten writer has carried live traffic yet.**
- `profiles_diamonds_nonnegative` CHECK validated. `fn_ca_mint` / `fn_ca_burn` ACL: postgres, service_role only. 21 diamond RPCs in `ca_money_rpc_registry`.
- Migrations applied tonight (versions): 000735 foundation; 002248, 002333 (B); 002317 (C, file named 20260903031500\_...); 002841 (E); 003036, 004002 (A); 003128, 003714 (G); 003327, 003403 (D); 010547 (P3). All in `supabase_migrations.schema_migrations`.

## 4. Open PRs and what must happen to them

- **#2735** `audit/diamond-economy`: standard, audits, foundation migration, roadmap, handoff, orchestrator changelog. Non-draft. Autopilot merges on green.
- **#2756** `fix/diamond-p2-lanes`: five lanes consolidated plus the P3 baseline fix; 185 law tests green, tsc clean. Non-draft.
- **World Hub #1257** `fix/diamond-d-disputes`: dispute webhook cases, subscription list, checkout reads `diamond_packages`. UNVERIFIED whether its pre-push build passed; check `mergeable_state`.
- If #2735 and #2756 conflict on `docs/LAWS.md` again (another agent adding a row), resolve by union: keep every row.

## 5. Incidents and things the next agent must check first

1. **Chip-side deadlock during the DDL burst** (CONFIRMED): `ca_ledger_write_failures` id 704, 00:31:49 UTC, `40P01` in `fn_ca_fund_overlay_on_lock`, tournament `1068cd04-41c8-4168-83cb-243ebe693918` ("Late Night PKO (PLO4)", RUNNING at 01:05, 54 entries, prize_pool 450 = guarantee 450, **no `tournament_guarantee_overlays` row**, 18.00 chips of overlay not funded). Check at completion: `tournament_escrow_shadow` for that id, and whether `fn_ca_backpay_guarantee_shortfalls` funded it. If not, it is a four-eyes adjustment (`ca_manual_adjustments`), never a migration. Lesson recorded in the roadmap: at most two lanes applying DDL in any twenty-minute window.
2. **`scripts/setup-stripe-webhook.js` has not been run** (World Hub). Until a human runs it with the live Stripe key, `charge.dispute.*` never reaches the new handler.
3. **DR2 noise once seeding resumes** (UNVERIFIED volume, Lane E estimate about 200 warnings a day): the horse seeder inserts profiles with `diamonds = 500` about 2 ms before the auth row; Lane B's trigger records each as `DR2:balance_born_outside_the_mint`. The seeder was NOT found in WH, CA, CA server, workers or `pg_proc` (UNKNOWN where it lives). Roadmap 1.3.
4. **Lane C's findings on deletion** (CONFIRMED): a profile DELETE is refused outright unless `app.ledger_maintenance` is set; a profile with `user_daily_challenges` or `challenge_streak_state` rows cannot be deleted at all (their AFTER DELETE triggers re-INSERT for the deleted user); World Hub `delete-account.js` sets no maintenance reason so self-service deletion returns 500 for any user with a journal row. Roadmap 2.6.
5. **The 897,095 unclaimed challenge diamonds** (87 percent of supply, 11,662 horse rows) are still an unbudgeted promise until Dan rules (standard 6.3).

## 6. Environment (CONFIRMED tonight)

- Shell: `mcp__counselors__host_terminal`; node via `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`; ~60 s per call; long work with `nohup ... & disown` and a log. `gh` is NOT installed (use curl; token `grep '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2- | tr -d '"'`, rotated 2026-09-02, never print it).
- Supabase MCP in this session: `mcp__b6d9edd4-a2e3-495f-b4c4-16c2befba6ef__execute_sql` / `_apply_migration` (the prefix changes per session; ToolSearch `select:` it). `apply_migration` registers `version = now()` and `name` = what you pass; rename the file to the registered version afterwards.
- Worktrees used: `~/Documents/.agent-trees/club-arena/diamond-audit` (branch `audit/diamond-economy`), `diamond-p2` (`fix/diamond-p2-lanes`), `diamond-a`, `-b`, `-c`, `-d`, `-e`, `-g` (lane branches, all pushed). `scripts/prune-stale-worktrees.sh` removes clean pushed worktrees after 72 h.
- Push and publish changed on 2026-09-02: `publish-club-arena.yml` is the only publisher and it, plus CI, runs on the Hetzner self-hosted runners (`vars.CI_RUNNER`); the agent side is unchanged: push a branch, Autopilot opens and merges the PR, stop. See `docs/HANDOFF-2026-09-02-push-publish-cost-audit.md`.
- Other agents were active concurrently (migrations `admin_platform_aggregates`, `an_alarm_that_fails_to_file_says_so`, commits #2749, #2755 landed during the swarm).

## 7. First commands for the next agent

```bash
cd /Users/smarter.poker/Documents/club-arena && git fetch -q origin && git log --oneline origin/main -5
# is #2735 / #2756 merged? (curl the PR state)
```

```sql
-- production, read-only
select * from fn_ca_diamond_trial_balance(now() - interval '24 hours');
select rule, severity, count(*), max(occurred_at) from ca_diamond_incidents where resolved_at is null group by 1,2;
select fn_ca_mint_supply('diamonds'), (select sum(diamonds) from profiles);
select taken_at, total, unexplained from ca_diamond_snapshots order by taken_at desc limit 5;
select * from ca_diamond_dead_store_writes;
select id, status, prize_pool from tournaments where id = '1068cd04-41c8-4168-83cb-243ebe693918';
```

Then read `docs/DIAMOND-ACCOUNTING-ROADMAP.md` section 2 Phase 1 and take the next unblocked item.

## 8. Decisions that are Dan's

The consolidated list is `docs/DIAMOND-ACCOUNTING-ROADMAP.md` section 3 (twenty items). The five that block the most work: 6.3 daily challenges and horses (897,095), 6.4 transfers, 6.6 the union diamond grant, 6.16 the Diamond Arena design (one platform club), and the real budget and cap numbers (every seeded value is labelled PROPOSED).

## 9. Memory-shaped summary (import into `/areas/club-arena-diamond-economy.md` when the memory tool is available)

```
---
name: club-arena-diamond-economy
description: The diamond economy audit, standard, fixes and roadmap of 2026-09-02/03; state, rulings and where to resume.
sources: [cowork]
aliases: [diamond standard, diamond arena accounting, DR1-DR16]
---
[stated] Dan 2026-09-02: audit the diamond economy top to bottom like the chip economy; the Diamond Arena is a Club Arena clone with one club playing in diamonds bought or earned on the platform; hard rules in the DB; do not build high-risk items; swarms welcome; phased plan when unfinished.
[stated] Dan 2026-09-02: GitHub token rotated, still sourced from GITHUB_TOKEN in ~/Documents/club-arena/.env; push and publish now run through the Hetzner self-hosted runners (publish-club-arena.yml is the only publisher).
State 2026-09-03 01:25 UTC: standard written (docs/DIAMOND-ACCOUNTING-STANDARD.md, D1-D22, DR1-DR16); foundation + six fix lanes live (11 migrations 20260903000735..010547), all log-only where they could refuse; mint supply = player sum = 1,030,092; hourly diamond trial balance at 0; PRs #2735 (docs), #2756 (lanes A B D E G + baseline fix), #2744 merged (C), WH #1257 (disputes). Not built: lanes F (transfers) and H (arena clone), both Dan-gated. Open incident: chip overlay 18.00 for tournament 1068cd04 deadlocked during the DDL burst (ca_ledger_write_failures 704). Next: roadmap Phase 1 (run setup-stripe-webhook.js, union diamond grant ruling, seeder inserts 0, DR4 to refuse after 24h clean, merge the PRs).
```
