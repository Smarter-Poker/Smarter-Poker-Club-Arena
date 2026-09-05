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
- Keyboard tab-switching (`1`..`6`, Tab) does not reach the container while
  focus is inside the frame - the same as a real browser tab.
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
