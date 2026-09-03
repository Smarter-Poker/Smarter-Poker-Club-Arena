# HANDOFF PROMPT — Copy everything below this line into a new chat

---

## MANDATORY: Server-Authoritative Migration — Read Before Doing ANYTHING

There is an active migration to remove ALL client-side poker engine code and make the server the SOLE authority. This has been meticulously documented. You MUST read these files FIRST, in this EXACT order, before writing a single line of code:

1. **`MIGRATION-LAW.md`** — 10 absolute laws governing this migration. ZERO exceptions. If you violate any law, all work stops.
2. **`MASTER-MIGRATION-DOCUMENT.md`** — Read Section 1 (architecture) and Section 8 (phase order). This is the complete blueprint.
3. **`STEP1-REMOVAL-CATALOG.md`** — Every single reference that must be removed, with exact file paths, exact line numbers, and exact replacement instructions.
4. **`MIGRATION-CHANGELOG.md`** — What has been done so far. Resume from where it left off. Do NOT redo completed work.
5. **`skills/bible-v8/BIBLE-V8-REFERENCE.md`** — The Ultra-Master System Bible v8 spec. This is what we're building against.

All 5 files are in the club-arena folder root.

## Phase Order (SACRED — Law 1, CANNOT be changed):

```
STEP 1: RIP OUT — Remove ALL client-side engine code (ONE source of truth)
STEP 2: VERIFY CLEAN — Grep confirms ZERO local authoritative state remains
STEP 3: FIX SERVER BLOCKERS — Card security, auto-fold bug, timer bug
STEP 4: PORT CORE — PreciseActionTimer, ServerActionValidator, StateVerifier
STEP 5: PORT SUPPORTING — TimeBankEngine, DisconnectEngine, PreActionEngine
STEP 6: PORT ADVANCED — Straddle, RIT, Insurance, MixedGame, Rakeback
STEP 7: TOURNAMENT & EXTRAS — ChipRace, TableBalancer, OFC, Telemetry
```

You CANNOT skip ahead. You CANNOT build before cleanup. You CANNOT rubber-stamp.

## What's Been Completed So Far:

- MIGRATION-LAW.md created (10 laws)
- MASTER-MIGRATION-DOCUMENT.md created and phase order corrected (Step 1 = rip out, not fix)
- STEP1-REMOVAL-CATALOG.md created (51 handControllerRef, 14 broadcastLocalHandState, 14 performAction, 6 engine imports — all with exact line numbers)
- MIGRATION-CHANGELOG.md created (no code changes yet)
- SESSION-START-PROMPT.md created
- CLAUDE.md updated with migration warning at top
- Every action handler in TablePage.tsx has been read line-by-line
- Every engine file (22 client, 3 server) has been read and documented

## What Has NOT Been Done (Your Job):

- **NO code changes have been made yet.** Step 1 removal has not started.
- The previous session ran out of VM disk space before any code edits could begin.
- You need to: confirm GitHub access (`gh auth status` — must show `Smarter-Poker`), then begin Step 1 removals following STEP1-REMOVAL-CATALOG.md exactly.

## Rules You MUST Follow Every Single Change:

1. READ the actual code (not from memory — use the Read tool)
2. DOCUMENT what exists (line numbers, exact code)
3. DOCUMENT what you're changing and WHY
4. MAKE the change (one change at a time — Law 4)
5. VERIFY (re-read the file, run grep, run `npx tsc --noEmit`)
6. LOG in MIGRATION-CHANGELOG.md with before/after

## GitHub Protocol:

- The ONLY authorized account is `Smarter-Poker` (login: `admin@smarter.poker`)
- NEVER write ghp* or github_pat* tokens into any file
- ALWAYS use `bash scripts/git-safe-push.sh "message"` — never raw git push
- Run `gh auth status` first to confirm correct account

## After Reading All 5 Files:

Tell me:

1. Which STEP you're on (should be Step 1)
2. Which specific sub-task is next (should be the first removal from STEP1-REMOVAL-CATALOG.md)
3. Confirm you've read MIGRATION-LAW.md and will follow all 10 laws

Then wait for my go-ahead before touching any code.
