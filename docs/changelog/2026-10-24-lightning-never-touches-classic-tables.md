# Lightning Never Touches Classic Tables

Player report relayed by Dan 2026-10-24 (Jerry): "the tables are pretty glitchy after every hand the avatars disappear and reappear even on classic". Dan: "NO PART OF THE LIGHTNING GAMES OR FUNCTIONALITY SHOULD BE TOUCHING THE CLASSIC GAMES. MAKE SURE THATS HOW ITS WORKING!"

## Cause

#7910 (`fed15a735`, "a folded player disappears once the action reaches the seat") implemented the Lightning fold ruling in the shared table renderer with no format filter; its law test even pinned "without a format filter". On every Classic table each folded player's avatar, plate and action tag went `visibility: hidden` once their fold landed, and came back when the next hand reset `is_folded`. Most seats fold most hands, so a Classic table looked like avatars vanishing and reappearing every hand.

## Fix

- `TablePage.tsx`: `foldCommitted` is passed to `SeatSlot` only when `lightningRoom != null` (the pool-session lookup, null for every Classic table), and the `nextFoldReveal` tracker does not run outside a Lightning room. Classic tables are back to normal poker: a folded player stays seated and visible for the whole hand.
- **Every Classic table was treated as a Lightning anchor (#7894).** `fn_cash_cluster_lightning_state` answers with a full object for every cash game, Classic included (read from production 2026-10-24: 246 `must_move` games with `lightning_enabled: false`, 17 `lightning`, 2 `must_move` with the switch on). The table page took any non-null answer as "Lightning", so on every Classic table that belongs to a game:
  - a spectator was offered "Join Lightning" (to the Classic game's Lightning route) instead of the waiting list;
  - every buy-in set a Lightning entry intent, which put the full-felt "Joining Lightning..." overlay over the table until two Lightning reads came back;
  - a funded seat opened a `lightning-anchor-conversion` realtime channel and read `fn_lightning_my_session` on every update of its game row;
  - the table polled `fn_cash_game_lobby` and pool health every 30 s.

  Now `parseLightningLobbyState` carries `lightning_enabled`, and `isClassicLobbyState` names a Classic game (switch off and not in a Lightning mode). A table is a Lightning anchor only while its game's mode is a Lightning mode (or the engine is showing a Lightning hand on it). The conversion watcher is given a game only when that game can be Lightning. With `settleClassic` a Classic game is asked once and never again; failed reads retry. The club lobby board's refresh is unchanged.

## Audit of today's other Lightning work (no Classic contact found)

- #7896 early fold: only `LightningHandHost` calls `performImmediateFold`; the observer projection requires a Lightning-halted table in a Lightning-enabled cluster.
- #7884 seat arrivals: `arrival` is already `lightningRoom ? ... : undefined`; `useSeatArrivals` receives an empty roster on Classic.
- Snapshot mapping, engine payloads, hub publishing, sit-out persistence and the keyboard/pre-action Lightning folds all require a Lightning room or a Lightning-halted anchor.

## Pins

`tests/unit/committedFoldIdentity.law.test.ts` (Classic never hides a folded player; a non-null answer never makes a Lightning anchor; the handoff never watches a Classic game), `tests/unit/lightningLobbyFeedSettlesClassic.test.tsx` (production-shaped answers: Classic asked once, Lightning and switched-on games keep refreshing) and `tests/lightning/funded-anchor-handoff.test.tsx` (a funded Classic seat makes no Lightning read).
