# AntiGravity Handoff — 2026-04-14 — Phase 1.3 PR-C+D (ActionErrorToast wired into TablePage)

## Context

Last piece of the Phase 1.3 action-rejection UX. The toast component + CSS already exist (shipped with the NO-GO-2 client commit). This PR wires it into TablePage by (a) routing every `submitAction` result through a thin wrapper that surfaces failures into the toast, and (b) rendering the toast next to `DisconnectToast` with a Snap-to-hint button that auto-dispatches the server-suggested action.

Client `npx tsc --noEmit` exits **0**. Vite build in staging dir produced fresh assets `index-DImokg4U.js` (328kB) + `TablePage-uj0wzy0z.js` (304kB) in 5.84s.

**Stack order:** Run after NO-GO-2 client + NO-GO-3 are both pushed. This is small (single file: `TablePage.tsx`) and is purely UX wiring — no schema, no server, no API change.

## What changed

### `src/pages/TablePage.tsx`

1. **Module-scope clarification comment** at the old `DisconnectToast` import (the real `ActionErrorToast` import already lives later in the file, around line 198 — leaving a comment so future agents don't re-add the duplicate).

2. **New state hook** `actionErrorData: ActionErrorData | null` (default `null`) just below `disconnectStates`.

3. **New `useCallback submitActionWithToast(tid, uid, action, amount?, callsite?)`** added just above `handleTimerAutoFold`. Awaits `submitAction`, inspects the resolved result, and on `success === false` populates `actionErrorData` with `{error, code, hint}`. Network-level throws fall through to a generic `'Server unreachable'` toast.

4. **All 11 `submitAction(tableId,...)` call sites converted** to `submitActionWithToast(...)`. The callsite tag is included for debugging and shows in `console.warn` only when the server actually rejects:
   - `handleTimerAutoFold` → `auto-fold`
   - standalone `handleFold` / `handleCheck` / `handleCall` → respective tags
   - `handleActionPanelAction` switch arms (fold/check/call/raise/allin) → `panel-*`
   - `handleConfirmRaise` → `confirmRaise`
   - `handleAllIn` → `handleAllIn`

5. **JSX render** — added `<ActionErrorToast errorData={actionErrorData} onClear={...} onApplyHint={...} />` immediately after `<DisconnectToast .../>`. The `onApplyHint` callback maps server-hint action strings (`fold` / `check` / `call` / `raise` / `bet` / `allin` / `all-in` / `all_in`) into the unified `handleActionPanelAction` signature so the suggested amount is clamped + validated client-side just like a manual click.

## Step 1: Pull the prior commits

```bash
cd ~/Documents/club-arena
git pull origin main
```

HEAD should be at the NO-GO-3 commit before proceeding.

## Step 2: Client typecheck

```bash
cd ~/Documents/club-arena
npx tsc --noEmit
```

Must exit 0.

## Step 3: Verify wiring (REALIGN-style)

```bash
cd ~/Documents/club-arena/src

# Every submitAction invocation should now go through the wrapper:
grep -n 'submitAction(tableId' pages/TablePage.tsx
echo "exit=$?"
# Must print exit=1 (no raw call sites left).

grep -c 'submitActionWithToast(tableId' pages/TablePage.tsx
# Must print 11.

# Toast is rendered:
grep -n '<ActionErrorToast' pages/TablePage.tsx
# Must print 1 line.

# Single import (no duplicate):
grep -c "from '../components/table/ActionErrorToast'" pages/TablePage.tsx
# Must print 1.
```

## Step 4: Vite build

```bash
cd ~/Documents/club-arena
rm -rf dist
npm run build
ls -la dist/assets/TablePage-*.js dist/assets/index-*.js
```

Both bundles should be present and TablePage chunk should hash differently from the NO-GO-2 build (the wrapper + render added ~30 lines).

## Step 5: Commit

```bash
cd ~/Documents/club-arena
git add -A
git commit -m "Phase 1.3 PR-C+D: wire ActionErrorToast into TablePage with Snap-to-hint

submitAction never throws — it always resolves with {success, error?, code?, hint?}.
The old .catch(console.warn) pattern silently swallowed every server rejection,
leaving the user with no feedback when the engine refused an action. This PR
introduces submitActionWithToast: a thin useCallback wrapper that inspects the
resolved result and pipes failures into actionErrorData state. The
ActionErrorToast component (shipped earlier with NO-GO-2 client) renders that
state next to DisconnectToast.

Coverage:
- submitActionWithToast added as useCallback above handleTimerAutoFold.
- New actionErrorData useState below disconnectStates.
- 11 submitAction call sites converted to submitActionWithToast (auto-fold,
  standalone fold/check/call, ActionPanel switch fold/check/call/raise/allin,
  handleConfirmRaise, handleAllIn). Each gets a callsite tag for warn logs.
- JSX renders <ActionErrorToast .../> after <DisconnectToast .../>.
- Snap-to-hint button maps server-hint action strings (fold/check/call/raise/
  bet/allin/all-in/all_in) back through handleActionPanelAction so amounts are
  clamped + validated client-side just like a manual click.
- Removed duplicate ActionErrorToast/ActionErrorData import (one already lived
  at line ~198; cleaned up the second import at the DisconnectToast site).

Verification:
- npx tsc --noEmit: exit 0
- vite build: 5.84s, fresh TablePage-uj0wzy0z.js + index-DImokg4U.js
- grep submitAction(tableId on TablePage.tsx: exit 1 (zero raw call sites)
- grep submitActionWithToast(tableId: 11 hits
- grep <ActionErrorToast: 1 hit
- grep ActionErrorToast import lines: 1 hit"
git push origin main
```

## Step 6: World Hub bundle sync + push

```bash
cd ~/Documents/club-arena
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub

cd ~/Documents/Smarter-Poker-World-Hub
npx tsc --noEmit
bash scripts/git-safe-push.sh "Phase 1.3 PR-C+D bundle: ActionErrorToast wired into TablePage"
```

## Step 7: Hub-vanguard deploy hook (if Vercel doesn't auto-deploy in 60s)

```bash
curl -X POST "https://api.vercel.com/v1/integrations/deploy/prj_op66GkZyZcygXQKm76iyycfVFAQx/Tw4O1eDeVc"
```

## Step 8: Live verification

After Vercel reports READY:

```bash
LIVE=$(curl -s https://smarter.poker/hub/club-arena/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
echo "Live index: $LIVE"
# Should be a fresh hash, not index-CzdZMRXP.js (NO-GO-2) or DBb46nKG (pre-clean).
```

Spot-check on a real table: deliberately submit an invalid action (e.g. attempt
to check when there's an outstanding bet, or raise below the minimum). The
toast should appear with the server's error message, and if the engine
returned a `hint`, a "Snap to RAISE 200" (or similar) button should appear —
clicking it should auto-dispatch the suggested action.

## Step 9: Log Phase 1.3 PR-C+D in after-action log

Append to `~/Documents/Smarter-Poker-World-Hub/.memory/context/after-action-log.md`:

```
## Phase 1.3 PR-C+D — 2026-04-14 — Action rejection UX live

### Atomic unit
Wire ActionErrorToast (already-shipped component) into TablePage by routing
every submitAction call through a result-inspecting wrapper, and render the
toast next to DisconnectToast with a Snap-to-hint button.

### Ship
- Commit CA <SHA>: TablePage wrapper + 11 call site conversions + JSX render
  + duplicate-import cleanup.
- Commit WH <SHA>: bundle sync.
- Hub-vanguard deploy: live index hash <hash>.
- Spot-check: invalid action surfaces server message; hint Snap-to button
  dispatches suggested action.

### Verification
- client tsc: exit 0
- vite build: 5.84s, TablePage-<hash>.js fresh
- grep submitAction(tableId: exit 1
- grep submitActionWithToast(tableId: 11
- grep <ActionErrorToast: 1
- grep ActionErrorToast import lines: 1
- live bundle hash spot-check: matches dist
```

## Next task queued

Phase 2 T1-02 vertical bet slider per POKERBROS_CLONE_SPEC.md §5.2.
