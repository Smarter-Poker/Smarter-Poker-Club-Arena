# Session Memory — Smarter Poker Club Arena

## Active Migration: Server-Authoritative (Bible V8)

**Current Phase:** PokerBros parity ACHIEVED across Phases A-H. Live-verification pass-throughs are next (operations / QA work).
**Last Verified:** 2026-04-15 — CA HEAD `a9700673` (post-Phase-H), WH HEAD `2fa7c88e`, live bundle `index-f_1RKRxq.js` + `TablePage-2gHXSd7X.js`, Hetzner container `8b4ba435dc62` healthy (553 hands @ ~86 hands/hour, 0 broadcast threshold violations).
**V8 Compliance:** 115 items, 112 VERIFIED (97%), timer ring / rebuy-on-bust LIVE.
**Last Major Ship:** `.memory/context/2026-04-15-pokerbros-parity-milestone.md` (Phases A-H all signed off + committed)

## PokerBros Parity (Phases A-H) — ALL SIGNED OFF

| Phase | Surface                          | Commit     | Signoff doc                     |
| ----- | -------------------------------- | ---------- | ------------------------------- |
| A     | Core gameplay (15 rows)          | `77d8e3dc` | `2026-04-15-phase-A-signoff.md` |
| B     | Omaha variants & special formats | `77d8e3dc` | `2026-04-15-phase-B-signoff.md` |
| C     | Tournament system (30+ features) | `77d8e3dc` | `2026-04-15-phase-C-signoff.md` |
| D     | Club / agent / union economy     | `fcdfd03c` | `2026-04-15-phase-D-signoff.md` |
| E     | VIP / IAP / daily rewards        | `58eddd4e` | `2026-04-15-phase-E-signoff.md` |
| F     | Security & anti-cheat            | `9f305d8c` | `2026-04-15-phase-F-signoff.md` |
| G     | Real-time & multi-tabling        | `20386861` | `2026-04-15-phase-G-signoff.md` |
| H     | Analytics & reporting            | `a9700673` | `2026-04-15-phase-H-signoff.md` |

## Key Decisions

- [001] SUPERSEDED 2026-08-29: cash rake is WEIGHTED CONTRIBUTED (see [004]); DEALT_EQUAL survives only for historical rows
- [002] BBJ requires 3+ players dealt in (FIX 145)
- [003] Sit-out mid-hand must be deferred (FIX 143)
- [004] Broadcast await only on TURN_CHANGE (FIX 217) — non-critical broadcasts stay fire-and-forget
- [005] Formal FSM is a design choice, not a bug — string-based stage progression is functionally correct

## Key Preferences

- [001] Dan's verification standard: deep line-by-line, no rubber-stamping
- [002] Rakeback (now weighted contributed rake, Dan 2026-08-29) is THE key metric for weekly player/agent earnings
- [003] NO TERMINAL PROMPTS — Antigravity prompts only. Never tell Dan to run a shell command; emit an AG agent prompt instead. See preferences/002-no-terminal-prompts-only-antigravity.md
- [004] CLUB ARENA IS MOBILE FIRST — every design and flow starts at phone size and is progressively enhanced for desktop. Mobile is never a compressed afterthought. See preferences/003-mobile-first-design.md

## Key Context

- [001] Three-service architecture (Vercel + Hetzner VPS + Supabase)
- [002] Git hooks bypassed: `core.hooksPath /dev/null`
- [003] Migration phase order is SACRED — cannot skip steps
- [004] Hetzner VPS: SSH root@178.156.160.206, path /opt/club-arena, container club-arena-engine, port 8080, health https://engine.smarter.poker/health
- [005] Vercel: hub-vanguard project prj_op66GkZyZcygXQKm76iyycfVFAQx, token stored at /Users/smarter.poker/Library/Application Support/com.vercel.cli/auth.json (never commit the literal value — GitHub push protection blocks it)
- [006] Supabase: kuklfnapbkmacvwxktbh.supabase.co, service role key in server/.env
- [007] GitHub PAT: REDACTED-USE-LOCAL-ENV-OR-GH-CLI (Antigravity-Fleet-v4, never expires)

## Problems Solved

- [001] FIX 143 — Sit-out during active hand caused auto-fold
- [002] FIX 144 — Rakeback was weighted by pot contribution instead of equal share
- [003] FIX 145 — BBJ minimum players was 4, should be 3
- [004] FIX 217 — Broadcast was fire-and-forget; TURN_CHANGE timer could start before clients received state
- [005] FIX 218 — Bomb pot settings (frequency, multiplier) never loaded from DB, dead code in HandController
- [006] FIX 219 — ante_enabled toggle missing from DB and loadTable query
- [007] 2026-04-14 — TURN_CHANGE deadline stamped AFTER broadcast (hero timer shipped expired). Stamp BEFORE broadcast.
- [008] 2026-04-14 — Opponent timer rings stuck at 100% (JS hook never ticked on hidden tabs). Pure-CSS `@property --timer-progress` animation.
- [009] 2026-04-15 — `seat--${player.status}` collided with `seat--active` current-turn class; every seated player glowed. Skip `seat--${status}` when status === 'active'.
- [010] 2026-04-15 — Players were booted immediately on bust (no rebuy path). Added `atomic_table_rebuy` RPC + TablePage useEffect + BuyInModal rebuy mode.
- [011] 2026-04-15 — BUG 008 rakeback settler missing: settleRakeback() had zero callers; in-memory accumulator never flushed; rakeback_periods empty 7 days despite $30K rake. Built RakebackSettlerService + engine writes rake_records durably. (858bebf7)
- [012] 2026-04-15 — BUG 009 agent commission never credited: 68 agents, $0 each; server engine had zero refs; existing increment_agent_rake RPC updated non-existent profiles.rake_generated column. SQL migration fixed RPC + new credit_agent_commission_from_rake + settler calls it. (ba8c15f0)
- [013] 2026-04-15 — BUG 010 fn_clawback_chips_atomic was a stub: inserted into non-existent clawback_audit_log and returned success:true without moving chips. Rebuilt as real atomic clawback with 10-min window + recipient debit + sender credit + audit row. (7616dbba)
- [014] 2026-04-15 — BUG 011 fn_union_send_chips_to_club targeted non-existent union_transactions table; actual audit table is union_wallet_transactions. Fixed INSERT; 30 days of 42P01 silent failures resolved. (a2963597)
- [015] 2026-04-15 — BUG 012 player_stats frozen 22 days: engine never writes it (grep server/ = 0 hits); 7 client readers show stale data. Extended settler with step 2c to upsert player_stats.hands_played + total_rake. (9ff21f18)
- [016] 2026-04-15 — BUG 013 union_transactions direct server writes (distinct from BUG 011 RPC variant): 2 sites in server/src writing audit rows that silently 42P01'd. Redirected to union_wallet_transactions with balance_after populated.
- [017] 2026-04-15 — BUG 014 bbj_payouts + bbj_payout_recipients tables didn't exist; BBJ jackpot audit trail always empty despite pool deductions succeeding. Created both tables with FK + indexes + RLS.
- [018] 2026-04-15 — BUG 015 tournament_bounties table didn't exist; PKO / Mystery / Fixed KO bounty recording silently failed on every elimination. Created table with unique-KO constraint.
- [019] 2026-04-15 — BUG 016 club_wallets dead probe: non-fatal (graceful fallback) but wasted round trip + tournament path used race-prone read-then-write. Removed dead probe; both sites now atomic increment_club_chip_pool.

## Session 2026-04-15 — Verification Harness Phase (FINAL TALLY)

Built live-verification harness (c33b3277), ran it against production, then extended with a systematic stranded-writer audit. **Caught 9 silent-failure financial bugs** in sequence (008-016 above). All shipped as engineering fixes within the same session. Engine telemetry remained healthy throughout: 683+ hands dealt at 85 hands/hour, 0 broadcast threshold violations.

**Systemic root cause across all 9 bugs:** Bible V8 server-authoritative migration inventoried "code + DB + UI exists" but never ran "RPC actually completes + data flows end-to-end" validation. Two failure modes:

- Writers stranded in orphaned `src/services/` (client) code with no server replacement (008, 009, 012)
- RPCs / server writes targeting tables that don't exist in the schema (010, 011, 013, 014, 015, 016)

**Rules of thumb for future agents:**

1. `grep -rln "<table>" server/` for each UI-read table — zero hits = red flag for stranded-writer
2. For every `.from('<table>')` in server/src, assert that table exists in pg_tables — missing = 42P01 silent-failure
3. CI should parse both patterns automatically and block merges that violate them

## Index of Entries

| ID     | Type       | File                                           | Summary                                                                                                        |
| ------ | ---------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D-001  | DECISION   | decisions/001-rake-equal-share.md              | SUPERSEDED by D-004: weighted contributed rake                                                                 |
| D-002  | DECISION   | decisions/002-bbj-min-players.md               | BBJ requires 3+ players                                                                                        |
| D-003  | DECISION   | decisions/003-deferred-sitout.md               | Sit-out deferred until hand end                                                                                |
| D-004  | DECISION   | decisions/004-broadcast-await.md               | Await broadcast only on TURN_CHANGE                                                                            |
| P-001  | PREFERENCE | preferences/001-verification-standard.md       | Deep verification, no rubber-stamps                                                                            |
| P-003  | PREFERENCE | preferences/003-mobile-first-design.md         | Every Club Arena design and flow is authored mobile first, then progressively enhanced                         |
| C-001  | CONTEXT    | context/001-architecture.md                    | Platform architecture overview                                                                                 |
| C-002  | CONTEXT    | context/002-migration-status.md                | Current migration progress                                                                                     |
| C-003  | CONTEXT    | context/003-hetzner-vps.md                     | Hetzner VPS credentials and deploy                                                                             |
| C-004  | CONTEXT    | context/004-vercel-deploy.md                   | Vercel project and deployment details                                                                          |
| PR-001 | PROBLEM    | problems/001-fix143-sitout.md                  | Sit-out mid-hand auto-fold bug                                                                                 |
| PR-002 | PROBLEM    | problems/002-fix144-rakeback.md                | Weighted rakeback bug                                                                                          |
| PR-003 | PROBLEM    | problems/003-fix145-bbj.md                     | BBJ min players wrong                                                                                          |
| PR-004 | PROBLEM    | problems/004-fix217-broadcast.md               | Broadcast fire-and-forget timing                                                                               |
| PR-005 | PROBLEM    | problems/005-fix218-bombpot.md                 | Bomb pot dead code                                                                                             |
| PR-006 | PROBLEM    | problems/006-fix219-ante.md                    | Missing ante_enabled toggle                                                                                    |
| C-005  | CONTEXT    | context/2026-04-14-basic-functionality-push.md | Timer ring v1→v5 + rebuy-on-bust + engine audits                                                               |
| PR-007 | PROBLEM    | problems/007-v5-drop-orphans-outage.md         | v5 push-script drop-orphans deleted vendor-supabase; fixed with hotfix + v6 cache-bust + permanent script rule |
| C-006  | CONTEXT    | context/2026-04-15-phase-A-signoff.md          | Phase A core-gameplay verification — 15 rows, 12 GREEN via code+live, 3 deferred to Phase B test-table setup   |
