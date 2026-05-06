# Bible v8 — Poker Engine Compliance Skill

## Purpose

This skill is the **SINGLE SOURCE OF TRUTH** for building, fixing, and verifying the Club Arena poker engine. Every code change, every fix, every feature MUST be verified against this Bible before it can be considered "done."

## When to Use

- **ALWAYS** when working on ANY poker engine code (HandController, ServerTableEngine, TablePage, etc.)
- **ALWAYS** when fixing bugs in the game flow
- **ALWAYS** before marking any task as "complete" or "verified"
- **ALWAYS** when adding new features to the poker table

## How to Use

### Step 1: Read the Bible Reference

Read `BIBLE-V8-REFERENCE.md` in this skill folder for the complete specification.

### Step 2: Check Compliance Tracker

Read `COMPLIANCE-TRACKER.md` in this skill folder to see current status of every requirement.

### Step 3: Cross-Reference Before Committing

Before ANY commit that touches engine code:

1. Identify which Bible requirements your change affects
2. Verify the change complies with the Bible specification
3. Update the COMPLIANCE-TRACKER.md with the new status
4. Include the Bible requirement IDs in your commit message

### Step 4: Never Rubber-Stamp

- "It looks like it works" is NOT verification
- You must trace the ACTUAL data flow against the Bible's prescribed flow
- You must verify the ACTUAL state transitions match the Bible's state machines
- You must confirm ACTUAL timing behavior matches Bible's timer specs
- You must check ACTUAL card security matches Bible's anti-god-mode requirement

## Architecture Mandate (from Bible + Gap Analysis)

### THE FUNDAMENTAL RULE:

**The SERVER is the ONLY authority. The client is a DUMB TERMINAL.**

```
Client Action Flow (THE ONLY VALID FLOW):
1. Player clicks button in UI
2. Client sends HTTP POST to server (/action endpoint)
3. Client WAITS (shows pending state)
4. Server validates, processes via HandController
5. Server broadcasts authoritative state via Supabase Realtime
6. ALL clients (including the actor) update from server broadcast
7. UI renders server state
```

### FORBIDDEN PATTERNS:

- Client-side HandController instances (handControllerRef)
- Client-side broadcastLocalHandState()
- Client-side performAction() calls
- Fire-and-forget server calls
- Any architecture where the client determines game state

## Files That Matter

| File                                     | Role                              | Bible Chapters |
| ---------------------------------------- | --------------------------------- | -------------- |
| `server/src/engine/HandController.ts`    | Server hand lifecycle             | Ch 1, 3, 4     |
| `server/src/engine/ServerTableEngine.ts` | Server dealing orchestrator       | Ch 1, 3, 6     |
| `server/src/index.ts`                    | HTTP endpoints + game server      | Ch 1           |
| `src/pages/TablePage.tsx`                | Client UI (must be dumb terminal) | Ch 5           |
| `src/lib/supabase.ts`                    | Realtime subscription             | Ch 1           |
| `src/services/GameServerAPI.ts`          | HTTP client to server             | Ch 1           |

## Verification Checklist (Quick Reference)

Before saying ANYTHING is "working":

- [ ] Does the server's HandController handle this case?
- [ ] Is the client only receiving state from server broadcasts?
- [ ] Are hole cards scrubbed from broadcasts to other players?
- [ ] Does the timer run on the server (not client)?
- [ ] Does validation happen on the server (not client)?
- [ ] Is the state machine transition correct per Bible Chapter 3?
- [ ] Does the settlement sequence follow Bible Law 1.9?
- [ ] Is the action validated per Bible Chapter 4 requirements?
