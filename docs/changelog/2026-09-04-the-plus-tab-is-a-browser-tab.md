# The "+" tab is a browser tab (2026-09-04)

Dan, verbatim: "when you click the + button from inside the club lobby i should
be able to go anywhere, its basically opening up a new browser tab internally,
it shouldn't be limited to just poker, if i open the + tab, go to the lobby
then hit the hub button and go to social, media, or trivia or training or any
other world hub page, I should still see my action bar, I should still be able
to swipe right or left to move back and forth between pages."

## What was true before

- The "+" opened a `kind: 'lobby'` slot that could render exactly two things:
  the club lobby and a tournament drilled in from it. Every other destination
  was a real route change under the pinned strip, and a World Hub destination
  was `window.location.href`, which unmounted the container and every table.
- The lobby in that tab had NO Hub button. `AppLayout` hides `GlobalHeader` on
  `/table/*`, and the "+" lobby lives on `/table/<id>`, so the header - and
  with it hamburger, Back, Hub, VIP, Messages - was simply not there. Dan's
  flow ("go to the lobby then hit the hub button") had no button to hit.

## What is true now

**A third slot kind, `hub`.** `TableInstance.kind` is `'table' | 'lobby' |
'hub'`; a hub tab carries `hubUrl` (path + search of the World Hub page it is
on). `src/utils/tabSlots.ts` gains `HUB_TAB_PREFIX` (`hub:`), `isHubLike` and
`isPageTab` (lobby or hub). Every "is this a live table?" decision in
MultiTablePage - twenty-seven of them, all previously `!isLobbyTab(t)` - now
asks `isTableTab(t)`, so a hub tab is not counted, docked, alerted, muted or
URL-agreed as a table. It is also not a lobby: `TABLE_SEATED` still replaces
the oldest LOBBY tab, "+" still focuses the LOBBY tab, an observe still reuses
the LOBBY tab, and `isFreeSlot` now says a hub tab is never free. A page the
player is reading is not parking space.

**`HubFrame`** (`src/components/table/HubFrame.tsx`) renders the page: a
same-origin `<iframe src="/hub/...">` filling the slot. Same origin is what
makes this work without any bridge - smarter.poker sends
`X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` (verified with curl
on `/hub`, `/hub/social`, `/hub/media`, `/hub/trivia`, `/hub/training`), so the
container can:

1. attach the strip's own touch handlers to the frame's DOCUMENT (a swipe that
   starts on Social is otherwise invisible to the swipe track), re-attached on
   every `load` since a full navigation is a new document;
2. poll `contentWindow.location` every 250 ms - Next.js moves with pushState,
   which no parent can hear - to rename the pill (`hubTabTitle`) and remember
   the page, so tile view and back reopens where the player was;
3. catch anchor clicks to `/hub/club-arena/...` in the capture phase and, as a
   backstop, catch a programmatic navigation there on the next poll, and
   convert the tab IN PLACE (Dan's ruling: never boot a second Club Arena
   inside the first). `/tournaments/:id` becomes a lobby tab drilled into that
   event; `/table/:id` becomes a lobby tab plus the real navigation the route
   effect already converts; anything else becomes a lobby tab plus a real
   navigation under the pinned strip, exactly like the club bottom nav.

`src` is read once at mount: feeding the tracked `hubUrl` back into the
attribute would reload the page the player is on every 250 ms.

The frame stays mounted behind the other tabs (slots are `display:none` when
inactive, never unmounted), so a hub tab keeps its scroll position, its form
state and its media across tab switches, like a browser tab. Tile view is the
one place it remounts - the tile shows a card, not a scaled web page - and it
comes back at `hubUrl`.

**The Hub button is in the tab.** `renderLobbyTab` renders `<GlobalHeader
inTab />` at the top of both lobby branches (club lobby and tournament
drill-in), sticky under the strip. `inTab` is a real mode, not a flag with a
class:

- Hub / VIP / Messages call `InTabLobbyNav.openHub(path)`, which turns the
  lobby tab on screen into a hub tab in place (same index, same pill). If the
  container declines (not a lobby tab on screen, not a `/hub` path) the header
  falls through to the `window.location` it always did, so the button is never
  dead. `/messages` in particular used to leave for `/hub/messenger` via
  `NavigateToMessenger`; in a tab it opens as a hub page.
- Back pops the drill-in first (a drill-in pushes no history entry, so browser
  Back would have stepped out of the table route) and only then does
  `window.history.back()`.
- It does NOT claim `#global-header` and does NOT publish
  `--ca-global-header-height` on the root. The ticker anchors to the former and
  the pinned strip positions by the latter, and both describe the REAL header's
  place on the page; a hidden lobby tab's copy measuring 0px would have put the
  pinned strip over the real header on every off-route page. It publishes
  `--ca-in-tab-header-height` on its parent instead, which the tournament
  back-pill uses to sit below it.
- The window-level hamburger listeners (`HAMBURGER_TOGGLE`, Ctrl+M, the
  left-edge swipe) stay with the real header. Two headers answering one gesture
  would open two menus, and the edge swipe is the strip's swipe inside a tab.
- No safe-area padding and no black band: the strip above already pays the
  notch.

**The strip** treats a `hub:` id like a `lobby:` id everywhere a seat is
assumed (no Sit Out, no Mute, no Identity, no table sections), labels the
quick-menu close "Close Tab", and titles the menu with the page name.

## The rule this touches

CLAUDE.md 1.3 says "Never add iframe code", and 7 says "NO iframe". Both were
written against embedding Club Arena INSIDE the World Hub (the ClubArenaEmbed
era) and the postMessage bridges that came with it, and both stand. Dan
approved `HubFrame` on 2026-09-04 as the ONE exception, with three questions
put to him and answered: build it with the iframe (yes), show the full
GlobalHeader in the "+" lobby (yes), convert a hub tab that links back into
Club Arena in place rather than letting the frame load a second copy (yes).
Both CLAUDE.md sections now name the exception, and
`tests/hub-tab-is-a-browser-tab.law.test.ts` pins it exactly that wide: one
`<iframe>` in `src/`, no postMessage, no `window.parent`, no sandbox.

## What a hub tab does not do

- It is not a general browser. `isHubPath` accepts `/hub` and paths under it,
  never Club Arena itself and never another origin; a link the player follows
  off smarter.poker inside the frame is cross-origin, the location read
  throws, and the tab keeps its last name. Nothing breaks; nothing is bridged.
- (Round 1 only: keyboard tab-switching did not reach the container while
  focus was inside the frame. Round 2 below forwards it.)
- Off-route with no table open, a hub tab is as unreachable as a lobby tab was
  (nothing to borrow a URL from). Unchanged.

## Files

- `src/utils/hubTab.ts` (new): `hubTabTitle`, `clubArenaPathFromHubUrl`,
  `isHubPath`, `HUB_FRAME_POLL_MS`.
- `src/utils/tabSlots.ts`: `HUB_TAB_PREFIX`, `isHubLike`, `isPageTab`,
  `isFreeSlot` refuses hub tabs.
- `src/components/table/HubFrame.tsx` (new).
- `src/pages/MultiTablePage.tsx`: the kind, `makeHubTab` / `makeLobbyTab`,
  `openHubTab`, `handleHubLocationChange`, `handleHubClubArenaTarget`,
  `goBackInTab`, `hubSwipeRef`, the two render branches, the header in the tab.
- `src/pages/MultiTablePage.css`: `__hub-frame`, `__hub-tile*`, the back-pill
  offset.
- `src/context/InTabLobbyContext.tsx`: `openHub`, `goBack`.
- `src/components/navigation/GlobalHeader.tsx` + `.module.css`: `inTab`.
- `src/components/table/TableTabBar.tsx`: `hub:` ids.
- `tests/unit/hubTab.test.ts`, `tests/hub-tab-is-a-browser-tab.law.test.ts`,
  `docs/laws.d/hub-tab-is-a-browser-tab.md`, CLAUDE.md 1.3 and 7.

## Round 2 (2026-09-05): what a hub tab does when you are not looking, and every way in

Dan: "GO AHEAD AND FULLY BUILD ALL OF THESE AND MAKE SURE THEY ARE FULLY
WIRED IN AND TESTED BEFORE CLAIMING SUCCESS. IF THERE ARE ANY THAT YOU
CONSIDER 'HIGH RISK' FOR DAMAGING CODE OR OTHER PAGES, DO NOT BUILD THEM."

Built, each exercised in `tests/unit/hubFrame.test.tsx` (the frame mounted
for real with its own document) or `tests/unit/hubTab.test.ts`:

- **Off-site links open a real browser tab.** Stripe Checkout and OAuth
  providers send `X-Frame-Options: DENY`; a frame following one would go blank
  at the moment the player is paying. Every anchor to another origin is caught
  in the capture phase and handed to `window.open(_, '_blank', 'noopener')`.
  A programmatic redirect off-site is still the hub page's own to break out of.
- **Inactive frames are quiet.** When a hub tab leaves the screen every
  playing `<video>`/`<audio>` in it is paused (`pauseMediaIn`). Not resumed on
  return; the player presses play.
- **Idle frames are unloaded.** Fifteen minutes behind other tabs
  (`HUB_FRAME_IDLE_SUSPEND_MS`) and the frame goes to `about:blank`, its last
  page remembered; opening the tab reloads it there. Each hub tab is a whole
  running Next.js app with its own realtime socket, and the felt needs that
  memory more than a page nobody has read for a quarter of an hour.
- **Keyboard reaches the strip from inside a frame.** 1-6, Tab and Alt+Arrows
  are forwarded from the frame document through `hubKeysRef`, the same shape
  as the swipe ref.
- **Hub tabs survive a reload.** `ca_hub_tabs` in sessionStorage, 30-minute
  TTL, URLs only (validated with `isHubPath` on the way back in), restored
  after the seat rebuild, never past the cap, never duplicating a page already
  open. The mirror is suppressed until the restore has read storage, or the
  first empty render would erase the list it was about to restore.
- **`OPEN_HUB_TAB` bus event.** Browser-tab semantics: a hub tab already on
  that page is focused, any other page gets its own tab. Two callers today:
  the felt's Club Marketplace button (was `window.open('/hub/marketplace')`,
  a browser tab the felt could not see) and the strip's new "+" menu.
- **"+" long-press / right-click menu**: Open Lobby, Open Hub, Social,
  Messages, each in a new tab, so a player on a felt reaches Social in one
  gesture instead of "+" then Hub. A tap on "+" is unchanged (Quick Join), and
  the click that follows a long-press release is swallowed so one gesture is
  never two.

Not built, and why:

- **Page tabs outside the table cap.** The cap is threaded through nine code
  paths and the tile grid is a fixed 2x2 on mobile; changing what counts is a
  multi-table core change I cannot verify on a felt from here. Server
  correctness does not need it (the server caps seats, not tabs). Dan's call,
  separately.
- **Frames surviving tile view.** Needs a persistent layer wrapping the felt
  container; a layout change around `position:fixed` descendants of TablePage
  with no way to verify the felt locally. The frame comes back at its page.
- **World Hub chrome inside the frame** and **hub-side analytics**: other
  repo.
- **`document.title` for pill names**: the hub's titles are generic
  ("Smarter.Poker Feature | Smarter.Poker", measured on /hub/social); the path
  segment is the better name.
- **Prefetching `/hub`**: SSR HTML is served no-cache; a prefetch buys nothing
  measurable.

## Audit (2026-09-05): what an independent review found, and what changed

Dan: "do a deep dive and verify that every thing you've built in the previous
phase is 100% fully built, coded, wired in and tested." A second reviewer read
the whole branch diff cold. Fixed in the same PR:

1. **Two headers in the "+" tab.** `HomePage` (the fallback when no home club
   is resolved yet, which is every fresh "+" tab for a moment) renders its own
   `GlobalHeader` unconditionally - a second copy that claimed `#global-header`,
   published the root height variable, and whose Hub button still did
   `window.location`. It now skips its header when `useInTabLobby()` is set.
2. **Two lobby tabs after a hub tab linked back into Club Arena.** The
   conversion made a NEW lobby tab even when one existed, and everything that
   finds "the lobby tab" finds the first, so the route effect converted the
   wrong slot and left a dead "Lobby" pill. Now: if another lobby tab exists the
   hub tab closes and the destination lands on it (drill-in pushed, or focus);
   only with no lobby open does it convert in place.
3. **A page tab opened from the pinned strip was invisible.** Off-route the
   container is `display:none`, so "+" menu -> Social appended a pill and no
   page. Both OPEN_LOBBY_TAB and OPEN_HUB_TAB now use the round-3 mechanism
   (`revealPageTabOffRoute`: borrow a real table's URL, `pendingTabIndexRef`).
4. **The in-tab hamburger was clipped.** `HamburgerMenu` is `position: fixed`
   and the tab is `contain: layout paint`, so the drawer was sized to the tab
   and scrolled away with the lobby. Portaled to `<body>` in `inTab` mode only.
5. **The Take Seat bar vanished on scroll.** It and the in-tab header are both
   `sticky; top: 0` in the same scroller and the header is above it in z-order.
   The bar now sits at `--ca-in-tab-header-height`.
6. **Tab and digits were stolen from the hub page.** Only Alt+Arrow (reorder)
   crosses the frame boundary now; Tab moves focus and a digit may answer a
   Trivia question, and a browser tab does not take those from the page.
7. **Restored hub tabs booted three apps behind a live hand.** A frame now has
   no `src` until its tab has been on screen once (`armed`), and the idle unload
   ignores a frame that never loaded.
8. **`/clubs/<other club>` rendered the home club.** Only the SPA root, its
   aliases and the player's own home club count as "the lobby itself"; any
   other club navigates for real.
9. Smaller: same-page detection ignores a trailing slash (`sameHubPage`); the
   location tracker returns the same array when nothing changed (no re-render
   per poll); the storage mirror is keyed on the hub URLs, not on `tables`
   (which changes every pot tick); dead `SavedHubTab` type removed.

Still true and unchanged: tile view remounts frames (documented cost), and the
merge with main resolved one conflict in the urgency-alert loop (kept both
sides: `isTableTab` and main's expired-decision guard).

### CI told the truth twice (2026-09-05, after the audit)

Two failures on the pull request that the local suite did not show, both fixed:

- **Entry chunk grew by one module.** `GlobalHeader` is in the chunk every
  player downloads before first paint; round 1 gave it a value import of
  `InTabLobbyContext` for `useInTabLobby`, and `entry-chunk-delta` refused.
  The header now takes the container's `InTabLobbyNav` as a PROP with a
  type-only import (erased at build), so the runtime dependency stays with the
  lazy MultiTablePage. Verified locally: 205 modules, +0kB, unchanged.
- **`multi-table-page__hub-frame` did not resolve on its route.**
  `classNamesResolve` requires a class a component renders to come from a
  stylesheet THAT component loads, not from a chunk it happens to share. The
  frame rule moved from MultiTablePage.css into `HubFrame.css`, imported by
  HubFrame.

## Round 3 (2026-09-05): browser-tab parity, and the Hub button never kills a table

Dan: "find any and all ways to improve, enhance and upgrade this page and
functionality to the max." Shipped in `feat/hub-tabs-polish`:

- **A page that is still coming says so.** A hub tab shows a spinner and
  "Loading Social" until the frame's own `load` event; after 12 s
  (`HUB_FRAME_STALL_MS`) it offers Reload, the only recovery a browser tab has
  either. Shown again when an idle-unloaded frame is brought back; never on a
  frame that has not been armed.
- **Quick menu on a hub tab: Reload Page, Open In Browser.** Reload remounts
  the frame at its last known page (a fresh tab id, since the frame reads `src`
  once); Open In Browser hands the same page to a real tab for anything a
  frame cannot do.
- **The pill sub-line is the page within the section**, where a table shows
  its stakes: `/hub/training/drills/3` reads "Training" over "Drills / 3", so
  two Training tabs are told apart. Title-cased, capped at 18 characters.
- **The real GlobalHeader stops killing tables.** Off-route, above the pinned
  strip, Hub / VIP / Messages used `window.location`, which unmounted every
  felt the strip was holding. MultiTablePage now publishes
  `data-ca-live-tables` on `<body>`; with any live table open those buttons
  emit `OPEN_HUB_TAB` and the page lands in a hub tab beside the game (revealed
  by borrowing a table URL). With none open, the navigation is unchanged. The
  helper is inline in GlobalHeader on purpose: the header is in the entry
  chunk and a shared module would grow it.
- **Jarvis from Hand History** follows the same rule: a hub tab with a table
  open, a browser tab otherwise.
