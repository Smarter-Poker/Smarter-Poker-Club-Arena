# Session Memory — Smarter Poker Club Arena

## Active Migration: Server-Authoritative (Bible V8)

**Current Phase:** ALL 8 STEPS COMPLETE — Bible V8 Deep Audit (225 fixes, 99% verified)
**Last Verified:** Round 45 — FIX-223/224/225 (animation-speed, perf instrumentation, formal FSM)
**Last FIX Numbers:** FIX 223, 224, 225 (committed + deployed to Hetzner + World Hub pushed)

## Key Decisions
- [001] Rake is EQUAL SHARE, never weighted (FIX 144)
- [002] BBJ requires 3+ players dealt in (FIX 145)
- [003] Sit-out mid-hand must be deferred (FIX 143)
- [004] Broadcast await only on TURN_CHANGE (FIX 217) — non-critical broadcasts stay fire-and-forget
- [005] Formal FSM is a design choice, not a bug — string-based stage progression is functionally correct

## Key Preferences
- [001] Dan's verification standard: deep line-by-line, no rubber-stamping
- [002] Rakeback equal share is THE key metric for weekly player/agent earnings

## Key Context
- [001] Three-service architecture (Vercel + Hetzner VPS + Supabase)
- [002] Git hooks bypassed: `core.hooksPath /dev/null`
- [003] Migration phase order is SACRED — cannot skip steps
- [004] Hetzner VPS: SSH root@178.156.160.206, path /opt/club-arena, container club-arena-engine, port 8080, health https://engine.smarter.poker/health
- [005] Vercel: hub-vanguard project prj_op66GkZyZcygXQKm76iyycfVFAQx, token vcp_8kIgZkEiE0YNlrmUvjdaXfNZxrzPZsdTksANXVsyAhbnjEg1Hl3q470C
- [006] Supabase: kuklfnapbkmacvwxktbh.supabase.co, service role key in server/.env
- [007] GitHub PAT: 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 (Antigravity-Fleet-v4, never expires)

## Problems Solved
- [001] FIX 143 — Sit-out during active hand caused auto-fold
- [002] FIX 144 — Rakeback was weighted by pot contribution instead of equal share
- [003] FIX 145 — BBJ minimum players was 4, should be 3
- [004] FIX 217 — Broadcast was fire-and-forget; TURN_CHANGE timer could start before clients received state
- [005] FIX 218 — Bomb pot settings (frequency, multiplier) never loaded from DB, dead code in HandController
- [006] FIX 219 — ante_enabled toggle missing from DB and loadTable query

## Index of Entries
| ID | Type | File | Summary |
|----|------|------|---------|
| D-001 | DECISION | decisions/001-rake-equal-share.md | Rake credit is always equal share |
| D-002 | DECISION | decisions/002-bbj-min-players.md | BBJ requires 3+ players |
| D-003 | DECISION | decisions/003-deferred-sitout.md | Sit-out deferred until hand end |
| D-004 | DECISION | decisions/004-broadcast-await.md | Await broadcast only on TURN_CHANGE |
| P-001 | PREFERENCE | preferences/001-verification-standard.md | Deep verification, no rubber-stamps |
| C-001 | CONTEXT | context/001-architecture.md | Platform architecture overview |
| C-002 | CONTEXT | context/002-migration-status.md | Current migration progress |
| C-003 | CONTEXT | context/003-hetzner-vps.md | Hetzner VPS credentials and deploy |
| C-004 | CONTEXT | context/004-vercel-deploy.md | Vercel project and deployment details |
| PR-001 | PROBLEM | problems/001-fix143-sitout.md | Sit-out mid-hand auto-fold bug |
| PR-002 | PROBLEM | problems/002-fix144-rakeback.md | Weighted rakeback bug |
| PR-003 | PROBLEM | problems/003-fix145-bbj.md | BBJ min players wrong |
| PR-004 | PROBLEM | problems/004-fix217-broadcast.md | Broadcast fire-and-forget timing |
| PR-005 | PROBLEM | problems/005-fix218-bombpot.md | Bomb pot dead code |
| PR-006 | PROBLEM | problems/006-fix219-ante.md | Missing ante_enabled toggle |
