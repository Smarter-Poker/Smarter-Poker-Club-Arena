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

## LAW 11: REAL-TIME IS LAW (added 2026-04-14, Dan decree)

**EVERY aspect, feature, and detail visible in Club Arena MUST be delivered
to the client via a discrete, named, real-time event the millisecond it
happens on the server. NO snapshot diffing. NO polling. NO setInterval
clock-watch. NO "wait for the next state broadcast and figure out what
changed".**

### Architecture

- **Engine WebSocket** (`wss://engine.smarter.poker/ws/table/:id`) is the
  ONLY real-time channel. Persistent per-table connection. The server
  PUSHES events as they occur.
- Each event has a **named type** (`player_action`, `pot_win`,
  `community_cards_dealt`, `blinds_posted`, `hand_started`, `showdown_reveal`,
  `time_bank_low`, `rit_offer`, `insurance_offers`, `rabbit_hunt_available`,
  `straddle_posted`, `pot_distributed`, `seat_taken`, `seat_left`, etc.) and
  a flat top-level payload — never nested under `.data`, never inside a
  giant snapshot blob.
- Snapshots (`broadcastCurrentState`) exist ONLY as a SAFETY NET for:
  1. New WebSocket clients connecting mid-hand (need a starting state)
  2. Reconnect resync after network drop
  3. Idempotent reconciliation if a discrete event was lost in transit

  Snapshots MUST NOT be the trigger for any animation, sound, label,
  countdown, or other UX cue. UX is event-driven; snapshots are
  consistency-checks.

### What this prohibits

- Diffing previous-vs-current snapshot fields to decide "did the pot
  change so animate chips?" — animate chips when the `player_action`
  event arrives.
- Subscribing to `broadcastCurrentState` to detect a stage change —
  emit `community_cards_dealt` (flop/turn/river) and react to it
  directly.
- `setInterval` to refresh chat / chip stack / timer / online count —
  every change comes as an event.
- Polling Supabase tables for "what's new" — the engine emits the
  authoritative event the same instant it changes its own state.

### What this requires

For every visible aspect / feature / detail in the UI, the engine MUST:

1. Emit a named discrete event the moment that aspect changes.
2. The client MUST receive that event over the WS hub and update the UI
   directly from the event payload.
3. The next snapshot is sent for reconciliation only — the UI MUST
   already be up-to-date from the discrete event before the snapshot
   arrives.

### Audit obligation

Any agent shipping work in Club Arena MUST audit their changes against
this law:

- Did you add a UX feature whose trigger is "the snapshot updated"?
  → REWRITE it to fire from a discrete event.
- Did you read state from a polling interval?
  → REWRITE it to subscribe to the event instead.
- Did you observe the engine NOT emitting a discrete event for a visible
  detail (a fold animation, a stack change, a chat message, a sound,
  a countdown tick)?
  → ADD the discrete event emit on the server AND wire the client
  handler.

### Verification

Every PR that adds or touches a visible UX feature MUST include in its
commit message a one-line confirmation:

> "Real-time law: triggered by `<event_name>` discrete WS event, no
> snapshot diff."

If a snapshot-driven UX path exists in code, the migration changelog
must list it as a known violation with a remediation plan.

This law overrides all prior latency targets, snapshot intervals, and
polling fallbacks. There is no negotiation.

---

## LAW 11: DEPLOYMENT IS NOT FINISHED UNTIL LIVE-VERIFIED

**Added:** 2026-04-15 (Dan, post the duplicate-Vercel-project cascade)

Every code ship MUST follow this exact deployment contract. No exceptions. No
"I think it deployed." No "should be live in a few minutes."

### 11.1 ONLY ONE VERCEL PROJECT SERVES PRODUCTION

- `hub-vanguard` (project id `prj_op66GkZyZcygXQKm76iyycfVFAQx`) — THE REAL ONE.
  Aliased to `smarter.poker`. Every push to `Smarter-Poker-World-Hub/main` must
  flow through this project.
- `smarter-poker` (project id `prj_FNUaJmcjRnwCSh1JzblIUYuOXDGK`) — a DUPLICATE
  that was created in Feb 2026 and wired to the same repo. GitHub auto-deploy
  has been DISABLED on this project. Do NOT re-enable it. Do NOT trigger
  deploys via its deploy hooks. If you see deployment cancellations in the
  `hub-vanguard` history and the only explanation is a parallel `smarter-poker`
  build, somebody resurrected the duplicate — put it back to sleep before
  continuing any other work.

### 11.2 PUSH → WATCH → VERIFY. IN THAT ORDER. NEVER SKIP.

After ANY push to `Smarter-Poker-World-Hub/main` (or the Club Arena source
repo if you're shipping a CA bundle via the WH repo copy path):

1. **PUSH** — via the GitHub Contents API pattern or `git-safe-push.sh`. Log
   the commit SHA you pushed.
2. **WATCH** — poll `hub-vanguard`'s latest deployment (via Vercel MCP
   `get_deployment` or `list_deployments`) until `state === 'READY'`. Do NOT
   claim success on `QUEUED`, `BUILDING`, or `CANCELED`. If CANCELED because a
   later push superseded yours, confirm the LATER deploy carries your commit
   SHA as an ancestor; if not, re-push on top of the latest HEAD.
3. **VERIFY** — fetch the live URL (e.g., `https://smarter.poker/hub/club-arena/index.html`)
   and confirm the served HTML references the new content-hashed bundle name
   that matches your build output. For Club Arena: grep for the `index-*-v6.js`
   filename in the served HTML and confirm it's the hash your Vite build
   produced.
4. **COLD-LOAD TEST** (for any functional change, not just CSS) — open a
   fresh browser tab (no SPA state carryover), navigate to the affected page,
   and confirm the fixed behavior actually works end-to-end. For Chrome MCP:
   use `tabs_create_mcp` + `navigate` with a fresh URL, confirm the new bundle
   hash is loaded via a JS eval, then perform the user action.

Only after all four steps pass may you mark the work complete.

### 11.3 DEPLOYMENT WATCH TIMEOUTS

- Vercel QUEUED → BUILDING typically takes 0–120s. If still QUEUED after 5 min,
  check for a newer push that superseded yours.
  NOTE: The deploy hook (Tw4O1eDeVc) was RETIRED on 2026-04-16 because it was
  causing duplicate deployments. DO NOT call it. The git integration handles
  auto-deploy on every push to main.
- BUILDING → READY typically takes 90–180s for a Next.js build on this repo.
- If ERROR or CANCELED persists for more than 10 min after the push, INVESTIGATE
  before trying again (could be a build failure, a rate limit, or the duplicate
  project resurrecting).

### 11.4 HOW TO KNOW WHICH PROJECT YOUR COMMIT WENT TO

Use Vercel MCP `list_deployments` with `projectId: prj_op66GkZyZcygXQKm76iyycfVFAQx`
(hub-vanguard) and `since: <your push timestamp>`. You MUST see a deployment
whose `githubCommitSha` matches your push (or has your push as an ancestor).
If it only shows up under `smarter-poker` (project id `prj_FNUaJmcj...`), the
duplicate is back — stop and fix the duplicate before any further deploys.

### 11.5 LIVE-VERIFY LANGUAGE (the only sentence you may use)

A commit is "deployed" only when you have personally observed:

> "Production `<url>` served `<expected-bundle-hash>` at `<UTC timestamp>` and
> the fixed behavior was confirmed via cold-load test at that timestamp."

Any other wording — "should be live," "deploy triggered," "Vercel will pick
it up in a few minutes," "my push went through" — is NOT acceptable and does
NOT satisfy this law.

---

## ENFORCEMENT

These laws are checked at every step by:

1. The agent re-reading this file before starting any new step
2. Grep verification commands after every removal
3. TypeScript compilation after every change
4. Migration changelog entries for every edit
5. Dan's review at each phase boundary
6. **Law 11 deployment contract** — explicit READY + served-bundle + cold-load proof before claiming success

**If any law is violated, all work stops until the violation is corrected.**
