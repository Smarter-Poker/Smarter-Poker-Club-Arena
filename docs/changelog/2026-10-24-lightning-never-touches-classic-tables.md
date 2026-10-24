# Lightning Never Touches Classic Tables

Player report relayed by Dan 2026-10-24 (Jerry): "the tables are pretty glitchy after every hand the avatars disappear and reappear even on classic". Dan: "NO PART OF THE LIGHTNING GAMES OR FUNCTIONALITY SHOULD BE TOUCHING THE CLASSIC GAMES. MAKE SURE THATS HOW ITS WORKING!"

## Cause

#7910 (`fed15a735`, "a folded player disappears once the action reaches the seat") implemented the Lightning fold ruling in the shared table renderer with no format filter; its law test even pinned "without a format filter". On every Classic table each folded player's avatar, plate and action tag went `visibility: hidden` once their fold landed, and came back when the next hand reset `is_folded`. Most seats fold most hands, so a Classic table looked like avatars vanishing and reappearing every hand.

## Fix

- `TablePage.tsx`: `foldCommitted` is passed to `SeatSlot` only when `lightningRoom != null` (the pool-session lookup, null for every Classic table), and the `nextFoldReveal` tracker does not run outside a Lightning room. Classic tables are back to normal poker: a folded player stays seated and visible for the whole hand.
- `lightningLobbyFeed.ts` / `TablePage.tsx`: the table page's "is this game Lightning?" check (added in #7894 for the spectator Join Lightning entry) polled `fn_cash_game_lobby` and pool health every 30 s on every Classic table. With `settleClassic`, a game whose first clean answer has no Lightning state is never asked again; a failed read is retried. The club lobby board's refresh is unchanged.

## Audit of today's other Lightning work (no Classic contact found)

- #7896 early fold: only `LightningHandHost` calls `performImmediateFold`; the observer projection requires a Lightning-halted table in a Lightning-enabled cluster.
- #7884 seat arrivals: `arrival` is already `lightningRoom ? ... : undefined`; `useSeatArrivals` receives an empty roster on Classic.
- #7894 waitlist swap: shows Join Lightning only when the table's game reports a Lightning state.

## Pins

`tests/unit/committedFoldIdentity.law.test.ts` (Classic never hides a folded player) and `tests/unit/lightningLobbyFeedSettlesClassic.test.tsx` (a Classic game is asked once).
