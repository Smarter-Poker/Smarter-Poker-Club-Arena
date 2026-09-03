# SESSION START PROMPT

## Paste this EXACTLY at the start of every new Claude session for the migration

---

```
MANDATORY: Before doing ANYTHING, read these files in this EXACT order:

1. Read /sessions/dreamy-quirky-sagan/mnt/club-arena/MIGRATION-LAW.md (the 10 laws — zero exceptions)
2. Read /sessions/dreamy-quirky-sagan/mnt/club-arena/MASTER-MIGRATION-DOCUMENT.md (Sections 1 and 8 minimum)
3. Read /sessions/dreamy-quirky-sagan/mnt/club-arena/STEP1-REMOVAL-CATALOG.md (exact removal targets)
4. Read /sessions/dreamy-quirky-sagan/mnt/club-arena/MIGRATION-CHANGELOG.md (pick up where we left off)
5. Read /sessions/dreamy-quirky-sagan/mnt/club-arena/skills/bible-v8/BIBLE-V8-REFERENCE.md (the spec)

RULES:
- Do NOT skip any of these reads. Do NOT summarize from memory. Actually READ them.
- Do NOT start any code changes until you've confirmed which STEP you're on and what the NEXT change is.
- Every change follows Law 3: READ code → DOCUMENT what exists → DOCUMENT what you're changing → MAKE change → VERIFY → DOCUMENT in changelog.
- Every change follows Law 4: ONE change at a time. No batching.
- After EVERY change, run grep verification and npx tsc --noEmit.
- Tell me which Step and which specific sub-task you're starting before you touch any code.

Current status: [TELL ME WHAT STEP YOU'RE ON AFTER READING THE CHANGELOG]
```

---

## What each file does (for Dan's reference):

| File                           | Purpose                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `MIGRATION-LAW.md`             | 10 laws preventing skipping, rubber-stamping, building before cleanup                                              |
| `MASTER-MIGRATION-DOCUMENT.md` | Complete architecture: 22 engine files, server gaps, 7-step execution order                                        |
| `STEP1-REMOVAL-CATALOG.md`     | Every handControllerRef (51), broadcastLocalHandState (14), performAction (14), import (6) with exact line numbers |
| `MIGRATION-CHANGELOG.md`       | Running log of every change made — the agent reads this to know where to resume                                    |
| `BIBLE-V8-REFERENCE.md`        | The full Ultra-Master System Bible v8 spec the engine must comply with                                             |

## Correct Phase Order (SACRED — see Law 1):

```
STEP 1: RIP OUT — Remove ALL client-side engine code
STEP 2: VERIFY CLEAN — Grep confirms ZERO local authoritative state
STEP 3: FIX SERVER BLOCKERS — Card security, auto-fold, timer
STEP 4: PORT CORE — PreciseActionTimer, ServerActionValidator, StateVerifier
STEP 5: PORT SUPPORTING — TimeBankEngine, DisconnectEngine, PreActionEngine
STEP 6: PORT ADVANCED — Straddle, RIT, Insurance, MixedGame, Rakeback
STEP 7: TOURNAMENT & EXTRAS — ChipRace, TableBalancer, OFC, Telemetry
```

## How to check if the agent is following the laws:

1. **Is it reading the files first?** If it starts coding without reading, stop it.
2. **Is it telling you which Step and sub-task?** If it just starts editing, stop it.
3. **Is it making ONE change at a time?** If it batches edits, stop it.
4. **Is it documenting in MIGRATION-CHANGELOG.md?** If no changelog entry, stop it.
5. **Is it running grep + tsc after changes?** If no verification, stop it.
6. **Is it working on the right Step?** If it jumps ahead (e.g., fixing server before ripping out client), stop it.

## What to say if the agent starts rubber-stamping:

```
STOP. You are violating Law [N]. Go back and [specific instruction].
Read MIGRATION-LAW.md again before continuing.
```
