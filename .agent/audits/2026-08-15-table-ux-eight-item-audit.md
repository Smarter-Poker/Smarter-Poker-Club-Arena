# 2026-08-15 — Club Arena in-game table: eight-item audit

Dan raised eight defects/gaps in the live poker table. This records what each
one actually is against the code, what shipped, and what remains. Item numbers
are Dan's original numbering.

Ruling captured this session (binding, supersedes any conflicting code):
**Rake is credited EVENLY to every player dealt in. Only that model survives;
anything conflicting gets deleted.** See item 8.

---

## Status

**ALL EIGHT SHIPPED 2026-08-15.** Every row below was verified by fetching the
live production bundle and grepping for the shipped code, not by trusting the
push. Final verification snapshot at prod `ccfe1668`:

```
TablePage-Dc7Q5A60-v6.js   hand_history_saved 1 · recordHand 2 ·
                           OPEN_LOBBY_TAB 1 · throw-animation-container 1
index-*.js                 "client staleness watchdog" 1
```

| #   | Item                            | Root cause                                            | Commit          | State                |
| --- | ------------------------------- | ----------------------------------------------------- | --------------- | -------------------- |
| 7   | Action buttons off-center       | `.pre-action-buttons` lacked `margin:0 auto`          | `9cb4ebd2`      | SHIPPED + VERIFIED   |
| 5   | Time-bank clock icon            | Existed; gated on `isHandInProgress`                  | `6f3c91bb`      | SHIPPED + VERIFIED   |
| 1   | Session Stats dead              | `recordHand` never called; session owned by the modal | `6f3c91bb`      | SHIPPED + VERIFIED   |
| 2   | "+" opens Cashier not 2nd table | Wired to CashierModal; `returnToMulti` read by nobody | `ee0d642c0`     | SHIPPED + VERIFIED   |
| 4   | Throwables wrong                | Fictional 800x500 ellipse; container outside scaler   | `a1d062b15`     | SHIPPED + VERIFIED   |
| 6   | Reconnect / self-healing        | No CLIENT staleness detector; only `onclose` recovery | `85df59c08`     | SHIPPED + VERIFIED   |
| 3   | Prev Hand / Replay / Share      | Lazy "most recent hand" lookup RACED the insert       | `ad6548c83`     | SHIPPED + VERIFIED   |
| 8   | Rake / BBJ attribution conflict | Two settlement engines writing one table              | WH `eabff063dc` | SHIPPED (preventive) |

### Corrections to this document's original findings

Three original diagnoses were wrong or incomplete:

- **Item 4** — the broadcast half was NOT missing. `receiveThrow` resolves the
  thrower's seat from the sender id in `useTableChat`. Only the geometry was
  broken.
- **Item 3** — the defect was worse than "shows an empty state". Once the lazy
  lookup landed, Replay could show the PREVIOUS hand: a silently wrong answer,
  which is worse than the empty state it replaced.
- **Item 8** — the conflict was **latent, never realised**. Production held
  2,376 `rakeback_periods` rows, zero duplicate `(user_id, club_id,
period_start)` tuples, and zero master-period rows (`user_id IS NULL`). The
  World Hub `close` branch needs an open master period to reach its insert, so
  it had never executed. No player was ever double-credited; the deletion is
  preventive, not a repair.

### Fixed along the way (not in Dan's list)

- **`main` was red.** `ee1a310f5` passed the snake_case `hand_history` row
  straight into the camelCase `HandHistoryPanel` view-model — two different
  `HandRecord` types. Every deploy was going out un-typechecked. Explicit
  adapter added in `85df59c08`.
- **Every Club Arena deploy was corrupting the repo.** `sync-club-arena.sh`
  used `cp -r "$f" "$DEST/$fname"`, which nests when the destination already
  exists. `game-card-icons/` buried itself one level deeper per deploy; one
  sync staged 51 duplicate PNGs (~6 MB). Fixed in WH `b94e755ae1`.
- **Unpushed freeze work was minutes from destruction.** Three local-only
  commits (Supabase fetch timeout, zombie-engine reaper, table watchdog) sat on
  `fix/table-freeze-and-dead-actions` while the reflog showed the
  `reset --hard origin/main` loop had already fired once. Pushed to a remote
  branch; later landed on main as `f041ccb1`.
- **A live GitHub PAT is printed to stdout** by
  `Smarter-Poker-World-Hub/.git/hooks/reference-transaction` whenever it blocks
  a reset. Flagged for rotation; it should use a credential helper.
- **The arena pre-commit guard blocks merge resolutions.** It rejects any
  commit touching `public/hub/club-arena/` without `ARENA_BUILD=1`, including
  merge-conflict resolutions, which `sync-club-arena.sh` cannot perform. It
  should exempt `MERGE_HEAD`.

---

## 7 — Action buttons must be dead-center (SHIPPED)

Root cause: `ActionPanel.css` `.action-row` has `margin: 0 auto`;
`PreActionBar.css` `.pre-action-buttons` had none. `.pre-action-bar` uses
`align-items: stretch`, and a stretched flex item capped by `max-width` falls
back to flex-start — so the row hugged the LEFT edge on every frame where the
action was not on the hero, then snapped to center when the turn arrived.

Second, independent cause: `.action-panel--raise-vertical` reserved the 56px
slider gutter with `padding-right` only, pushing raise mode left of center on
desktop (>=1024px).

Fix (CA `9cb4ebd2`):

- `.pre-action-buttons`: `margin: 0 auto` + `align-self: center`, `max-width`
  420 -> 500px to match `.action-row`, so both states occupy an identical
  footprint and the buttons do not move horizontally at all.
- `.action-panel--raise-vertical`: gutter mirrored on the left; both sides
  reset together in the `<=1023px` block where the rail goes inline.
- `.raise-layout`: capped at 500px with `margin: 0 auto`.

Verified live: `https://smarter.poker/hub/club-arena/assets/TablePage-DPYscDP9-v6.css`
serves `.pre-action-buttons{...max-width:500px;margin:0 auto;align-self:center}`
at prod SHA `50de7259`.

Note: `TablePage.css:1794` deliberately side-docks the whole action wrapper in
landscape under 500px height. Left as-is — that is a layout decision, not this bug.

---

## 5 — Time-bank clock

`TimebankCounter.tsx` already exists, already renders a clock SVG + count, and
is already anchored bottom-left (`TimebankCounter.css:6-32`, `position:fixed;
left:12px; bottom:calc(96px + safe-area)`). It is mounted at
`TablePage.tsx:5620` and reads a real count from
`table_seats.time_bank_uses_remaining` (migration `20260313_time_bank_persistence.sql`).

The only defect is the visibility gate: `isHandInProgress && heroSeat > 0`, so
it disappears between hands. Relax to seated-only.

Related: `time_bank_remaining` / `time_bank_uses_remaining` are missing from
`src/types/database.types.ts`, hence the `as any` casts at `TablePage.tsx:3274`.
Server default is `maxUses = 120` (VIP monthly) vs the client's seed of `4` —
worth reconciling.

---

## 1 — Session Stats records only time

`SessionStatsService` is complete and correct: `recordHand()`
(`SessionStatsService.ts:133-169`) computes handsPlayed, VPIP, PFR, P&L, BB
won, hands/hr, trajectory. `recordRebuy()` handles buy-ins.

**Neither is called anywhere in `src/`.** Only `startSession`/`endSession`/
`getStats` are, all from `SessionHUD.tsx` itself. Every field is frozen at its
zeroed initial value; the visible clock is a separate local `setInterval` at
`SessionHUD.tsx:76-88`. That is exactly "records the time and nothing else".

Knock-on: `endSession()`'s Supabase insert into `session_history` is guarded by
`if (session.handsPlayed > 0)`, so that write never fires either.

The data already exists and is already correct elsewhere — `vpipCountRef`
(`TablePage.tsx:5147`), `handsPlayedRef`/`handsWonRef` (`TablePage.tsx:4636`),
`biggestPotRef`/`peakStackRef` (`useTableSession.ts:90-100`). This is pure
wiring, not a feature build.

Same pattern repeats in `usePlayerStats.ts`: `recordVPIP`/`recordPFR`/
`recordThreeBet`/`recordWTSD` are destructured at `TablePage.tsx:1769` and
never invoked.

Dead imports to remove: `SessionAnalytics` (206), `SessionTimer` (163),
`SessionTrajectoryMini` (207), `handPersistenceService` (156), `HandReplay` (59).

---

## 3 — Previous Hand / Replay / Share

`PreviousHandCard` (`TablePage.tsx:5874`) itself works — hand #, W/L delta.
Its two buttons do not:

- **Replay** -> `setShowHandReplay(true)` -> `TableModalsLayer.tsx:554` renders
  `HandReplay` only `if (lastHandId)`. `lastHandId` is declared at
  `TablePage.tsx:937` and **`setLastHandId` has zero callers repo-wide**, so it
  is permanently null and the modal always shows "No recent hand to replay".
- **Share** -> `setShowShareHand(true)` -> `TableModalsLayer.tsx:922` renders
  only `if (showShareHand && sharedHandData)`. **`setSharedHandData` has zero
  callers**, so the modal never mounts — a silent no-op.

`HandReplay.tsx` and `ShareHand.tsx` are both complete, working components.

Architectural blocker: the server writes `hand_history` and gets the row id
back (`server/src/services/supabase/handHistory.ts:157`) but never returns it
to the client. The engine snapshot carries no `handId`, and
`masterBus`'s `HAND_COMPLETED` (declared with `{handId, tableId}` at
`MasterBus.ts:374`) is **never emitted**. So the fix requires emitting the id
on hand completion, not just client wiring.

---

## 4 — Throwables

Two independent bugs.

1. **Only the sender sees it.** `useTableAnimations.ts:50-65` pushes the
   `ThrowEvent` into local `activeThrows` and broadcasts only a bare chat
   string `[THROW:<id>:<targetSeat>]` — which omits `fromSeat` entirely. The
   receiver (`useTableChat.ts:361-364`) matches the regex and `return true;
// Don't add to chat`, reconstructing nothing. No other listener exists.
   The villain never sees the throw.
2. **Coordinates are fictional.** `getSeatPositions()`
   (`useTableAnimations.ts:71-99`) builds a hardcoded 800x500 virtual ellipse
   and returns raw px on that grid. Every other animation on the table uses
   `SEAT_POSITIONS_6MAX`/`9MAX` percentages (`TablePage.tsx:418-437`) converted
   via `seatPctToViewportPx(tableScalerRef.current, ...)`. Throwables never
   call it. Worse, `ThrowAnimationContainer` mounts inside `TableModalsLayer`
   (`TablePage.tsx:6751`), a _sibling_ of `.table-scaler`, so its
   `position:absolute; inset:0` resolves against the wrong ancestor.

Also: `SeatSlot.tsx` exposes no ref or `data-seat` attribute, so there is no
way to measure a live seat rect today.

Fix = broadcast `fromSeat`+`toSeat` properly, reconstruct on receive, and
reuse `seatPctToViewportPx` with the container mounted inside `.table-scaler`.

---

## 6 — Reconnect and self-healing

Already present and solid: exponential backoff + jitter in `EngineStateClient`
(`:333-351`), fixed ladder in `TableWebSocket` (`:225-235`), explicit `RESYNC`
on reopen (`:197-209`) and on sequence gaps, server PING/PONG with 60s timeout
(`EngineWebSocketServer.ts:424-442`), and a full per-player `DisconnectEngine`
with grace FSM and auto-fold.

Landed today by the parallel agent (WH `f041ccb1` / CA branch
`fix/table-freeze-and-dead-actions`, since merged): Supabase fetch timeout via
AbortController (there was previously **no fetch timeout anywhere in the
server**), zombie-engine reaper in `GameServer.ts`, table watchdog +
loop-death detection in `ServerTableEngineBase.ts`.

**Still missing — the biggest remaining freeze risk:** there is no _client_
staleness detector. If the engine stalls while the socket stays OPEN,
`engineWsStatus` reads `'connected'` forever and the UI freezes silently with
no recovery. Nothing tracks time-since-last-message anywhere in
`EngineStateClient`, `useEngineTableState`, or `TablePage`.

Also outstanding:

- Player heartbeat is a plain `setInterval` (`TablePage.tsx:911-921`), not
  routed through the throttle-proof worker timer in `useTabKeepAlive.ts`. A
  backgrounded tab throttles it to ~1/min against a 30s server disconnect
  timeout — players get auto-folded for being in another tab.
- `DisconnectToast.tsx:73-79` dead-ends the `DISCONNECTED` state with "Session
  lost. Refresh to rejoin." — manual reload, no auto-recovery.
- `HAND_SAFETY_TIMEOUT_MS` is 10 minutes (`ServerTableEngineDealing.ts:602`)
  and merely abandons the hand. Far too blunt/slow.

---

## 2 — The "+" button

The top-left "+" on the table HUD (`TablePage.tsx:5841-5858`) does
`if (heroSeat > 0) setShowCashier(true)` — Cashier only. There is a second,
identical "+" at `TablePage.tsx:5674` inside `.table-header`, but that bar is
`display:none !important` (`TablePage.css:2034`), so it is invisible.

Multi-tabling already works. `App.tsx:373` routes `table/:tableId` to
`MultiTablePage`, which holds a `tables[]` array capped at `MAX_TABLES = 4`,
lazy-loads one `<TablePage embeddedTableId=... isMultiTable />` per table, and
keeps inactive tables **mounted** (hidden with `display:none`, not unmounted),
each with its own independent engine WebSocket — `useEngineTableState` creates
a fresh `EngineStateClient` per hook call, not a module singleton.

`TableTabBar` has its own "+" (`:179-189`) but the tab bar only renders when
`tables.length > 1`, so a single-table player never sees it. And its
`handleAddTable` (`MultiTablePage.tsx:288`) just does
`navigate('/?returnToMulti=true')` — **nothing in the app reads
`returnToMulti`**; the file's own comment admits the lobby round-trip used to
drop every open tab.

So the work is: rewire the HUD "+" to open a lobby picker overlay that adds a
tab in place, rather than navigating away. Do NOT build new multi-table
plumbing. `src/components/multitable/*` (MultiTableView, TableSwitcher,
MiniTable, TableTabs, MultiTableManager) is fully orphaned — zero importers
repo-wide — and should be deleted.

---

## 8 — Rake and BBJ

**Collection is CORRECT and server-authoritative.** Rake is computed in
`PokerEngine.calculateRake` (`:572-598`) and applied in
`HandController.completeHand` (`:990-1022`) as
`totalWinnings = pot - rake - bbjFee`. Schedule is a hardcoded table
(`server/src/config/RakeConfig.ts:92-107`): flat 10% with per-stake absolute
caps, heads-up/3-handed cap reduction, no-flop-no-drop honored. Uncalled bets
are returned _before_ pot formation. Payouts use integer cents with a
remainder-correction loop, so `sum(payouts) + rake + bbj == pot` exactly.
BBJ is a real deduction banked through atomic RPCs
(`bbj_record_contribution`, `bbj_atomic_payout_v2`) with unbanked-fee queuing
on failure — not cosmetic.

Caveats worth fixing:

- Chip-conservation checks exist (`StateVerifier.ts:353-435`) but are
  advisory only — they log and continue rather than blocking settlement.
- The rake schedule is duplicated by hand in client `RakeService.ts:90-231`
  (dead path) — two tables that must be kept in sync manually.
- Client `RakeService.executeWaterfall` and `BBJService.executePayout` are
  dead code that should be deleted outright.

**The real problem — per-player attribution.** Genuine per-player contribution
IS captured (`ServerTableEngineHandEvents.ts:362-376`) and stored in
`rake_records.player_contributions`. Two different systems then consume it:

- `RakebackSettlerService.ts:133-149` — **equal share** among dealt-in players
  (marked DECISION D-001 / FIX 144).
- World Hub `pages/api/club-arena/rakeback.js:216-310` — **contribution
  weighted**.

Both write to the same `rakeback_periods` table with no coordination. Per
Dan's ruling, **equal share is canonical**: keep `RakebackSettlerService`,
delete the contribution-weighted "close" action in the World Hub API, and
check settled periods for double-crediting.

Out of scope but flagged: `Smarter-Poker-World-Hub/src/lib/poker-engine/`
contains a second engine with its own `record-rake.js` -> `record_rake` RPC.
If it still serves real games it needs its own audit.

---

## Process notes for the next agent

- **Two agents were writing this repo simultaneously today.** Antigravity
  landed `f041ccb1` mid-session while this audit was in progress. Check
  `git log --oneline -5` and file mtimes before editing `TablePage.tsx`.
- **Do not run git write commands from a Cowork sandbox VM.** The mount cannot
  unlink, so `git stash pop` silently writes nothing and `git commit` strands a
  `.git/index.lock` that then blocks git on the Mac host. Use the host
  terminal, or the GitHub MCP. Clear a stranded lock by `mv`, not `rm`.
- **A stranded `.git/rebase-merge` in World Hub** (left by a `pull --rebase`
  that the reference-transaction hook aborted) silently reverted an edit and
  made `commit --amend` a no-op. Check for it when git behaves oddly.
- **`.git/hooks/reference-transaction` in World Hub prints a live GitHub PAT**
  in its error output. Flagged to Dan for rotation; the hook should reference
  a credential helper instead of embedding a token.
- The `sync-club-arena.sh` nesting bug found this session (WH `b94e755ae1`)
  had been silently doubling `game-card-icons/` on every deploy. If any other
  unpreserved top-level dist dir appears, it would have had the same fate.
