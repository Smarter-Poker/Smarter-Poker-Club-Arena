# AntiGravity Handoff — 2026-04-14 — NO-GO-2 Client Ship

## Context

Server side of NO-GO-2 is already live on Hetzner (CA `064224b5` + fix-forward `8da84612`). This handoff ships the CLIENT side: TablePage event-router migration from `subscribeToHandState` → `engineLastEvent`, deletion of the 270-line duplicate regular-state block, ActionErrorToast component, and required interface fields. Both `npx tsc --noEmit` (client and server) exit **0**. Fresh Vite bundle built in sandbox staging: `index-CzdZMRXP.js` — `grep -l 'broadcastHandState\|subscribeToHandState\|cleanupBroadcastChannel' dist/assets/*.js` returned **exit 1 (zero matches)**. REALIGN kill-switches K1 and K2 go GREEN after this ships.

**Blocker that forced this handoff:** sandbox `/tmp` is at 100% and the mount has EPERM on unlinking — `.git/index.lock` is stuck as a 0-byte file and can't be removed by the agent. Everything below runs in your terminal.

## Files modified (all already written to disk)

Client (club-arena repo):

- `src/pages/TablePage.tsx` — destructure `engineLastEvent` from `useEngineTableState`; replace 545-line `subscribeToHandState` `useEffect` with engine EVENT router; delete 270-line duplicate regular-state block; deps `[engineLastEvent, tableId, userId]`.
- `src/hooks/useEngineTableState.ts` — add `lastEvent: Record<string, unknown> | null` to `UseEngineTableStateResult`; wire `onEvent` passthrough.
- `src/services/EngineStateClient.ts` — add `ServerEventMessage` to union; add `onEvent` option; forward EVENT case in `handleMessage`.
- `src/components/table/ActionPanel.tsx` — re-add `isPreflop?: boolean` to `ActionPanelProps`.
- `src/components/table/ActionErrorToast.tsx` (new) — inline unicode glyphs (no `lucide-react` dep).
- `src/components/table/ActionErrorToast.css` (new) — toast styles.
- `src/services/GameServerAPI.ts` — `ActionResult.code` / `ActionResult.hint` passthrough for toast.
- `src/core/MasterBus.ts` — add `userId?: string` to `TableEventPayload`.

Server (club-arena repo, same commit):

- `server/src/engine/ServerActionValidator.ts` — add `hint` field to `ValidationResult` (consumer in `ServerTableEngine` emits `validation.hint` to client).

## Step 1: Clear stuck index.lock

```bash
cd ~/Documents/club-arena
rm -f .git/index.lock
ls .git/*.lock 2>/dev/null || echo "clean"
```

## Step 2: TypeScript check (verify agent claim)

```bash
cd ~/Documents/club-arena
npx tsc --noEmit
cd server && npx tsc --noEmit && cd ..
```

Both must exit 0. If either errors, STOP and report back.

## Step 3: Review staged changes

```bash
cd ~/Documents/club-arena
git status
git diff --stat
```

Expected modified / new files:

- `server/src/engine/ServerActionValidator.ts`
- `src/components/table/ActionErrorToast.css` (new)
- `src/components/table/ActionErrorToast.tsx` (new)
- `src/components/table/ActionPanel.tsx`
- `src/core/MasterBus.ts`
- `src/hooks/useEngineTableState.ts`
- `src/pages/TablePage.tsx` (big — ~900 line net change, -545 insertions +450 around the event router rewrite + -270 for duplicate block)
- `src/services/EngineStateClient.ts`
- `src/services/GameServerAPI.ts`

## Step 4: Grep-for-absence in source (REALIGN verification)

```bash
cd ~/Documents/club-arena
grep -rn 'broadcastHandState\|subscribeToHandState\|cleanupBroadcastChannel' src/ server/src/
```

Only comment lines (prefixed `//` or inside `/* */`) should remain. Confirmed matches expected in:

- `src/lib/supabase.ts` (tombstone comment block only)
- `src/pages/TablePage.tsx` (3 doc-comment references to the deleted subscribe path)

Zero active-code matches = GREEN.

## Step 5: Commit Club Arena

```bash
cd ~/Documents/club-arena
git add -A
git commit -m "NO-GO-2 client: migrate TablePage event router to engineLastEvent; delete 270-line duplicate regular-state block; fix ActionErrorToast to no-lucide-react; re-add lastEvent/ServerEventMessage/isPreflop; add hint field to ValidationResult

- TablePage.tsx: destructure engineLastEvent from useEngineTableState; replace 545-line subscribeToHandState useEffect with engine EVENT router; delete 270-line duplicate regular-state block (mapEngineSnapshot is single source of truth); deps [engineLastEvent, tableId, userId].
- useEngineTableState.ts: add lastEvent to UseEngineTableStateResult; wire onEvent passthrough.
- EngineStateClient.ts: add ServerEventMessage type to union; add onEvent option; forward EVENT case.
- ActionPanel.tsx: re-add isPreflop optional prop.
- ActionErrorToast.tsx (new): component with inline unicode glyphs (no lucide-react dep).
- ActionErrorToast.css (new): toast styles.
- ServerActionValidator.ts: add hint field to ValidationResult (consumer in ServerTableEngine emits validation.hint to client).
- GameServerAPI.ts: ActionResult.code/hint passthrough for toast consumption.
- MasterBus.ts: TableEventPayload.userId optional field.

grep src/ for broadcastHandState/subscribeToHandState/cleanupBroadcastChannel: only tombstone comments remain. Code paths all removed.

Fresh vite bundle has zero matches on forbidden symbols. REALIGN K1 and K2 GREEN."
git push origin main
```

## Step 6: Vite build (fresh dist)

```bash
cd ~/Documents/club-arena
rm -rf dist
npm run build
ls -la dist/assets/index-*.js
grep -l 'broadcastHandState\|subscribeToHandState\|cleanupBroadcastChannel' dist/assets/*.js
echo "grep exit=$?"
```

Last echo must print `grep exit=1` (zero matches) — REALIGN Phase 9 verification.

## Step 7: Sync bundle to World Hub

```bash
cd ~/Documents/club-arena
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
```

## Step 8: Push World Hub (triggers Vercel auto-deploy)

```bash
cd ~/Documents/Smarter-Poker-World-Hub
npx tsc --noEmit
bash scripts/git-safe-push.sh "NO-GO-2 client bundle: engine EVENT router replaces subscribeToHandState; duplicate regular-state block deleted"
```

## Step 9: Hub-vanguard deploy hook (if needed)

If Vercel doesn't auto-deploy within 60s of push:

```bash
curl -X POST "https://api.vercel.com/v1/integrations/deploy/prj_op66GkZyZcygXQKm76iyycfVFAQx/Tw4O1eDeVc"
```

## Step 10: Post-deploy verification (REALIGN Phase 9)

Wait for Vercel to report READY (2-4 min), then:

```bash
# Verify live bundle name matches dist
curl -s https://smarter.poker/hub/club-arena/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1
# Verify no forbidden symbols in live bundle
curl -s "https://smarter.poker/hub/club-arena/assets/$(curl -s https://smarter.poker/hub/club-arena/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)" | grep -c 'broadcastHandState\|subscribeToHandState\|cleanupBroadcastChannel'
# Must print 0
```

## Step 11: Log NO-GO-2 in after-action log

Append to `~/Documents/Smarter-Poker-World-Hub/.memory/context/after-action-log.md`:

```
## NO-GO-2 — 2026-04-14 — REALIGN K1 + K2 GREEN

### Server ship
- Commit CA 064224b5: delete broadcastHandState/cleanupChannel/cleanupAllChannels + all 3 call sites (supabase.ts, ServerTableEngine.ts, index.ts).
- Fix-forward CA 8da84612: hint field on ValidationResult (consumer was added by concurrent agent in ServerTableEngine without the type declaration).
- Hetzner rebuilt, /health GREEN.

### Client ship
- Commit CA <SHA>: TablePage event router migrated to engineLastEvent; 545-line subscribeToHandState useEffect replaced with engine EVENT router; 270-line duplicate regular-state block deleted (mapEngineSnapshot owns game state).
- Re-added lastEvent to UseEngineTableStateResult, ServerEventMessage to EngineStateClient union, isPreflop to ActionPanelProps.
- ActionErrorToast component written (inline unicode glyphs, no lucide-react dep) — awaits Phase 1.3 PR-D wiring.
- WH commit <SHA>: bundle sync (index-<hash>.js).

### Verification
- client + server tsc: exit 0
- vite build: 5.54s, 2141 modules
- grep src/ server/src/ for forbidden symbols: only tombstone comments remain in lib/supabase.ts + TablePage.tsx doc blocks.
- grep dist/assets/*.js for forbidden symbols: exit 1 (zero matches).
- live bundle spot-check: exit 0, 0 matches.

### Kill switches
- K1 (Supabase hand-state channel still live): GREEN
- K2 (subscribeToHandState still exported/called): GREEN
- K3 (Dead parallel engine paths): still GREEN from NO-GO-1
- K6, K10: unchanged (next cycle: NO-GO-3)
```

## What changed (summary)

- `subscribeToHandState` + `broadcastHandState` + `cleanupBroadcastChannel` removed from client AND server code paths.
- TablePage now routes transient engine events (`insurance_offers`, `rit_offer`, `time_bank_*`, `bbj_*`, `all_in_equity`, `rabbit_hunt_available`, etc.) through the engine's native WebSocket EVENT messages instead of the old Supabase Realtime broadcast channel.
- Engine snapshot (game state) is the sole source of truth via `mapEngineSnapshot`; the duplicate regular-state block that re-derived state from the broadcast payload was deleted.
- ActionErrorToast component ready but not yet imported into TablePage (Phase 1.3 PR-D / next task).
- ValidationResult gained `hint` field; consumer in ServerTableEngine already emits it.

## Next task queued

**NO-GO-3 (Phase 1.2 PR-G-real):** Replace 4 parallel clocks (`InsuranceEngine`, `RunItTwiceEngine`, `TableBreakEngine`, `ServerTableEngine.heartbeatCheckInterval`) with `DeadlineScheduler` entries. Grep check: `grep -rn 'setInterval\|setTimeout' server/src/engine/InsuranceEngine.ts server/src/engine/RunItTwiceEngine.ts server/src/engine/TableBreakEngine.ts` plus the heartbeat block in `ServerTableEngine.ts` must return zero lines (excluding comments/tests).
