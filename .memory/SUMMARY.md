# Session Memory — Smarter Poker Club Arena

## Active Migration: Server-Authoritative (Bible V8)

**Current Phase:** Step 6 — PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)
**Last Verified:** Round 19 — Bible V8 Chapter 7 Edge Cases Deep Verification
**Last FIX Numbers:** FIX 143, 144, 145 (uncommitted, pending push)

## Key Decisions
- [001] Rake is EQUAL SHARE, never weighted (FIX 144)
- [002] BBJ requires 3+ players dealt in (FIX 145)
- [003] Sit-out mid-hand must be deferred (FIX 143)

## Key Preferences
- [001] Dan's verification standard: deep line-by-line, no rubber-stamping
- [002] Rakeback equal share is THE key metric for weekly player/agent earnings

## Key Context
- [001] Three-service architecture (Vercel + Hetzner VPS + Supabase)
- [002] Git hooks bypassed: `core.hooksPath /dev/null`
- [003] Migration phase order is SACRED — cannot skip steps

## Problems Solved
- [001] FIX 143 — Sit-out during active hand caused auto-fold
- [002] FIX 144 — Rakeback was weighted by pot contribution instead of equal share
- [003] FIX 145 — BBJ minimum players was 4, should be 3

## Index of Entries
| ID | Type | File | Summary |
|----|------|------|---------|
| D-001 | DECISION | decisions/001-rake-equal-share.md | Rake credit is always equal share |
| D-002 | DECISION | decisions/002-bbj-min-players.md | BBJ requires 3+ players |
| D-003 | DECISION | decisions/003-deferred-sitout.md | Sit-out deferred until hand end |
| P-001 | PREFERENCE | preferences/001-verification-standard.md | Deep verification, no rubber-stamps |
| C-001 | CONTEXT | context/001-architecture.md | Platform architecture overview |
| C-002 | CONTEXT | context/002-migration-status.md | Current migration progress |
| PR-001 | PROBLEM | problems/001-fix143-sitout.md | Sit-out mid-hand auto-fold bug |
| PR-002 | PROBLEM | problems/002-fix144-rakeback.md | Weighted rakeback bug |
| PR-003 | PROBLEM | problems/003-fix145-bbj.md | BBJ min players wrong |
