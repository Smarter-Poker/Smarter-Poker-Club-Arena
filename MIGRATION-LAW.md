# MIGRATION LAW — ABSOLUTE ENFORCEMENT RULES
## Zero Exceptions. Zero Shortcuts. Zero Rubber-Stamping.

**Created:** 2026-03-24
**Authority:** Dan (project owner)
**Applies to:** ALL agents, ALL sessions, ALL future work on this migration

---

## LAW 1: ORDER OF OPERATIONS IS SACRED

The migration MUST proceed in this EXACT order. No phase may begin until the previous phase is 100% verified complete.

```
STEP 1: RIP OUT — Remove ALL client-side engine code (establish ONE source of truth)
STEP 2: VERIFY CLEAN — Grep entire codebase, confirm ZERO local authoritative state remains
STEP 3: FIX SERVER BLOCKERS — Card security, auto-fold bug, timer bug
STEP 4: PORT CORE — PreciseActionTimer, ServerActionValidator, StateVerifier
STEP 5: PORT SUPPORTING — TimeBankEngine, DisconnectEngine, PreActionEngine, AtomicStackService
STEP 6: PORT ADVANCED — Straddle, RIT, Insurance, MixedGame, Rakeback
STEP 7: TOURNAMENT & EXTRAS — ChipRace, TableBalancer, TableBreak, OFC, Telemetry
```

**YOU CANNOT BUILD ON A BROKEN FOUNDATION.**
You MUST remove the dual engine BEFORE fixing or building anything.
If the client still has its own HandController, nothing you build on the server matters.

---

## LAW 2: NO SKIPPING AHEAD

- You CANNOT start Step 2 until Step 1 is 100% complete and verified
- You CANNOT start Step 3 until Step 2 confirms zero client engine references
- You CANNOT start Step 4 until Step 3's three fixes are tested
- And so on for every subsequent step

**Violation:** If you catch yourself working on a later step while an earlier step is incomplete, STOP IMMEDIATELY. Go back. Finish the earlier step first.

---

## LAW 3: NO RUBBER-STAMPING

Before making ANY change, you MUST:

1. **READ the actual code** — not from memory, not from summaries. Use the Read tool. See the actual lines.
2. **DOCUMENT what exists** — write down exactly what the current code does, with line numbers
3. **DOCUMENT what you're changing** — write down exactly what you're replacing it with and WHY
4. **MAKE the change** — only after steps 1-3
5. **VERIFY the change** — read the file again, confirm the change is correct
6. **DOCUMENT what you did** — add to the migration changelog with before/after

If you skip any of these 6 sub-steps, you are rubber-stamping. STOP and go back.

---

## LAW 4: ONE CHANGE AT A TIME

- Do NOT batch multiple unrelated changes into one edit
- Do NOT "while I'm here, let me also fix..." — NO. One thing at a time.
- Each change gets its own: read → document → change → verify → document cycle
- This prevents cascading errors and makes rollback possible

---

## LAW 5: DOCUMENT EVERYTHING

Every single change MUST be recorded in `MIGRATION-CHANGELOG.md` with:

```
## Change #[N] — [Short description]
**File:** [exact path]
**Lines:** [before line numbers]
**What existed:** [exact code that was there]
**What changed:** [exact code that replaced it]
**Why:** [specific reason tied to a Law or Bible requirement]
**Verified:** [YES/NO — did you re-read the file after editing?]
**TypeScript:** [PASS/FAIL — did npx tsc --noEmit pass?]
```

No change is complete without this entry. Period.

---

## LAW 6: VERIFY BEFORE PROCEEDING

At the end of EVERY step:

1. `grep -rn "handControllerRef" src/` — must return ZERO results (after Step 1)
2. `grep -rn "broadcastLocalHandState" src/` — must return ZERO results (after Step 1)
3. `grep -rn "performAction" src/pages/TablePage.tsx` — must not call local engine
4. `npx tsc --noEmit` — must pass with ZERO errors
5. Read the files you changed — confirm they look right

If ANY verification fails, you DO NOT proceed. You fix it first.

---

## LAW 7: NO ASSUMPTIONS

- Do NOT assume a file hasn't changed since you last read it — READ IT AGAIN
- Do NOT assume a function signature from memory — READ THE ACTUAL CODE
- Do NOT assume line numbers from the migration document are still accurate — VERIFY
- Do NOT assume a grep returned all results — check multiple patterns
- Do NOT assume TypeScript will catch everything — also manually review

---

## LAW 8: WHEN IN DOUBT, STOP AND ASK

If you encounter ANY of the following, STOP and ask Dan before proceeding:

- A file that looks different from what the migration document describes
- A dependency you didn't expect between components
- A change that would affect more than the file you're working on
- Uncertainty about whether something is client-authoritative or server-authoritative
- Any situation where you're tempted to say "this should be fine"

"This should be fine" = rubber-stamping. STOP.

---

## LAW 9: THE CLIENT IS A DUMB TERMINAL

After Step 1, the client (TablePage.tsx and all components) must ONLY:

1. **SEND** actions to the server via HTTP POST
2. **RECEIVE** state from the server via Supabase Realtime
3. **RENDER** whatever the server tells it to render

The client MUST NOT:
- Calculate game state
- Determine whose turn it is
- Validate actions locally
- Run any hand logic
- Maintain any "authoritative" state
- Have any engine imports
- Have any HandController reference
- Call broadcastLocalHandState or any equivalent

If the client does ANY of the above after Step 1, it's a violation. Rip it out.

---

## LAW 10: SPEED IS THE ENEMY

This migration has failed multiple times because of rushing.
Take the time. Read the code. Document the change. Verify the result.
A correct migration that takes 2 weeks beats a broken one that takes 2 days.

There is NO deadline more important than getting this right.

---

## ENFORCEMENT

These laws are checked at every step by:
1. The agent re-reading this file before starting any new step
2. Grep verification commands after every removal
3. TypeScript compilation after every change
4. Migration changelog entries for every edit
5. Dan's review at each phase boundary

**If any law is violated, all work stops until the violation is corrected.**
