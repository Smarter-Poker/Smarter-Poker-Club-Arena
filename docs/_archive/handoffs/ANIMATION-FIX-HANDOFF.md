# AntiGravity Handoff -- 2026-04-16 Animation Root-Cause Fix

## What Was Wrong

**All table animations were non-functional** despite extensive code existing for them.
7 bugs were identified and fixed:

### ROOT CAUSE (Bug #1 -- the big one)

The game action event handler in `TablePage.tsx` was watching `lastEvent` (Supabase
Realtime), but the server stopped sending events via Supabase Realtime in PR-5 and now
sends all discrete events via the native WebSocket hub. The client receives these events
as `engineLastEvent` -- but the animation handler never looked at that state variable.
Every animation trigger was dead on arrival.

**Fix:** Changed the useEffect to watch `engineLastEvent` instead of `lastEvent`.

### Bug #2: card_slide default was false

The `DealAnimation` component (cards flying from dealer to players) was gated by
`v8Settings.card_slide` which defaulted to `false`. Deal animation never showed.

**Fix:** Changed `card_slide` default to `true` in `DEFAULT_USER_TABLE_SETTINGS`.

### Bug #3: enhanced_view default was false

Several visual effects gated behind `enhanced_view` were off by default.

**Fix:** Changed `enhanced_view` default to `true` in `DEFAULT_USER_TABLE_SETTINGS`.

### Bug #4: BLINDS_POSTED used stale ref for chip animation

The `BLINDS_POSTED` handler used `triggerChipAnimationRef.current?.()` which was
sometimes null (same race condition that was fixed for `player_action` on 2026-04-14).
Blind posting chips never animated.

**Fix:** Converted to direct `setChipAnimations()` call with inline position calculation,
matching the pattern used by the `player_action` handler.

### Bug #5: POT_WIN hand_name read from wrong payload level

The server sends `hand_name` nested in `winners[i].hand_name`, not at the top level.
The client read `evt.data.hand_name` which was always empty. Winning hand name (e.g.,
"Full House", "Two Pair") never displayed.

**Fix:** Added fallback to extract from `winnersArray[0]?.hand_name`. Also improved
per-winner amount extraction for accurate split pot displays.

### Bug #6: Winning hand name only displayed at showdown

The `pot-hand-strength` label was gated by `boardStage === 'showdown'`. PokerBros shows
the winning hand name on ALL wins including fold-around wins.

**Fix:** Removed the `boardStage === 'showdown'` condition.

### Bug #7: Server didn't emit discrete SHOWDOWN event

The server's `SHOWDOWN` case only called `broadcastCurrentState()` (state snapshot) but
never emitted a discrete `showdown` event. The client's SHOWDOWN handler (which plays
showdown sound + sets boardStage) never fired.

**Fix:** Added `this.hub?.emitEvent()` call with showdown results.

## Phase 2: Animation Wiring (same session)

### Bug #8: Fold card animation CSS orphaned

The `.seat__cards--folding` CSS existed with `cardFoldOut` keyframe but was never
applied in SeatSlot.tsx. Cards vanished instantly on fold instead of flying to muck.

**Fix:** Added `isFolding` state + useEffect trigger. Applied `seat__cards--folding`
class to BOTH hero and opponent card containers. Also extended opponent cards render
condition to include `isFolding` so the animation plays before unmount.

### Bug #9: Showdown 3D card flip CSS orphaned

The `.seat__cards--showdown` CSS existed with `cardShowdownFlip` keyframe but was
never applied in SeatSlot.tsx. Opponent cards appeared instantly at showdown.

**Fix:** Added `isShowdownFlip` state that triggers when `player.showCards` transitions
false -> true. Applied `seat__cards--showdown` class to opponent card container.

### Bug #10: Deal card slide-in CSS orphaned

The `.seat__cards--dealing` CSS existed with `cardDealIn` keyframe but was never
applied. Individual seat card arrival had no animation.

**Fix:** Added `isDealing` prop to SeatSlotProps. TablePage sets `isSeatDealing=true`
for 700ms on HAND_STARTED, passes to every SeatSlot. Applied `seat__cards--dealing`
class to both hero and opponent card containers.

### Bug #11: Position badges missing

Position badges (SB/BB/UTG/CO/HJ/MP) were intentionally removed per earlier design
decision. Re-added for PokerBros parity with color-coded CSS.

### Bug #12: HAND_STARTED missing deal sound

No sound played when cards were dealt at hand start.

**Fix:** Added `soundService.playDeal()` call in HAND_STARTED handler.

### Bug #13: TURN_CHANGE missing hero haptic + sound

No haptic or audio cue when it was the hero's turn to act.

**Fix:** Added `haptic.medium()` + `soundService.playTurnAlert()` when hero's seat matches.

### Bug #14: POT_WIN missing hero win haptic

No celebration haptic on hero win.

**Fix:** Added `haptic.strong()` when hero is in winner list.

## Files Modified

1. `src/hooks/useUserTableSettings.ts` -- Defaults: card_slide + enhanced_view -> true
2. `src/pages/TablePage.tsx` -- 7 fixes:
   - Event handler now watches engineLastEvent (root cause)
   - BLINDS_POSTED direct setChipAnimations
   - POT_WIN hand_name extraction from winners array
   - Winning hand name shown for all wins (not just showdown)
   - HAND_STARTED deal sound + isSeatDealing state for card slide-in
   - TURN_CHANGE hero haptic + sound
   - POT_WIN hero haptic
3. `server/src/engine/ServerTableEngine.ts` -- SHOWDOWN discrete event emission
4. `src/components/table/SeatSlot.tsx` -- 6 fixes:
   - Fold card animation (isFolding state + seat\_\_cards--folding class)
   - Showdown 3D card flip (isShowdownFlip state + seat\_\_cards--showdown class)
   - Deal card slide-in (isDealing prop + seat\_\_cards--dealing class)
   - Opponent cards render during isFolding for animation before unmount
   - Position badges re-added (SB/BB/UTG/CO/HJ/MP)
   - Memo comparison updated for isDealing prop
5. `src/components/table/SeatSlot.css` -- Position badge CSS (colors per position)

## Step 1: TypeScript Check

```bash
cd ~/Documents/Smarter-Poker-Club-Arena
npx tsc --noEmit
```

## Step 2: Review Changes

```bash
git diff --stat
git status
```

## Step 3: Commit and Push (Club Arena)

```bash
git add -A
git commit -m "fix: wire engineLastEvent + 14 animation bugs for PokerBros parity

ROOT CAUSE: event handler watched lastEvent (Supabase Realtime) but server
sends discrete events via native WS hub (engineLastEvent). All animation
triggers were dead.

Phase 1 (7 fixes):
- Event handler now watches engineLastEvent (root cause)
- card_slide + enhanced_view defaults changed to true
- BLINDS_POSTED uses direct setChipAnimations (ref was sometimes null)
- POT_WIN hand_name extracted from winners[] array (was empty)
- Winning hand name shown for all wins, not just showdown
- Server emits discrete SHOWDOWN event for sound + card reveals
- HAND_STARTED deal sound added

Phase 2 (7 fixes):
- Fold card animation wired (seat__cards--folding class applied)
- Showdown 3D card flip wired (seat__cards--showdown class applied)
- Deal card slide-in wired (seat__cards--dealing via isDealing prop)
- Position badges re-added (SB/BB/UTG/CO/HJ/MP with colors)
- TURN_CHANGE hero haptic + turn alert sound
- POT_WIN hero win haptic
- Opponent cards render during fold for fly-out animation"
git push origin main
```

## Step 4: Build and Deploy Frontend

```bash
npm run build
bash scripts/sync-to-world-hub.sh ~/Documents/Smarter-Poker-World-Hub
cd ~/Documents/Smarter-Poker-World-Hub
bash scripts/git-safe-push.sh "fix: animation root-cause -- wire engineLastEvent into handler"
```

## Step 5: Deploy Server (Hetzner VPS)

The server change (SHOWDOWN emitEvent) needs to be deployed to the Hetzner VPS:

```bash
# SSH into VPS and pull latest
ssh root@your-hetzner-ip
cd /path/to/server
git pull origin main
npm run build
pm2 restart poker-engine
```

## Step 6: Verify on Production

1. Navigate to https://smarter.poker/hub/club-arena/table/[any-table-id]
2. Join a table, play a hand
3. Verify ALL of these animations fire:
   - Card dealing (cards fly from dealer to each player on new hand)
   - Blind posting (chips animate from SB/BB seats to pot)
   - Player bet/call/raise (chips animate from player seat to pot)
   - Flop/Turn/River (cards slide in with flip animation)
   - Pot shipping (chips fan from pot to winner seat on win)
   - Winning hand label (e.g., "Full House" appears at pot center)
   - Winner seat glow (gold highlight on winning player)
   - Showdown sound plays
