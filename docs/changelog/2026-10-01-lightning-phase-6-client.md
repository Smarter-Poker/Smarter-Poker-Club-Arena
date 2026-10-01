# Lightning Phase 6 (Client): One Room, One Continuous Stream Of Hands

**Status:** built and tested on a branch. No PR opened, nothing deployed. Dark in production: no Cluster is Lightning, so every path below is inert for current players.

## What It Adds

- **Route `/lightning/:clusterId`** (`src/pages/LightningEntryPage.tsx`, inside the app shell). Calls `fn_lightning_my_session(p_cluster_id)`. With a live pool session it registers the room and opens `/table/<pool_session_id>` in the current tab. Without one it shows the Cluster's entry with JOIN LIGHTNING (JOIN GAME while the Cluster is MUST MOVE). The join runs the existing door `fn_cash_game_join` and the table's own buy-in. No table list, no seat choice. Nothing is printed while the answer is quick; after 2.5 s a neutral "One Moment..." line appears.
- **Pool-session registry** (`src/lightning/lightningSession.ts`). Remembers which room ids are pool sessions (in memory and in sessionStorage). The felt's description comes from the Cluster's `cash_games` row, never from a `tables` row.
- **TablePage on a pool-session id.** `useLightningPoolSession(tableId)` is null for every table. For a pool session, all four `tables` reads are skipped: the bootstrap, the BBJ club lookup (it uses the Cluster's club instead), the kill-rules read and the 4404 row check. The seat prefetch and the hole-card recovery read are skipped too. The felt is seeded from the Cluster (`lightningTableSeed`), then updated from the snapshot's optional `lightning` block (`lightningSnapshotPatch`). The seat count still comes from `max_seats`. The engine room is the route id for the whole session.
- **LIGHTNING FOLD / FOLD & WATCH** (`LightningFoldBar`). Always mounted in a Lightning room while the hero is seated, and lit only while folding is available, both on the hero's turn and before it. Sends POST /action `{tableId: pool_session_id, action: 'fast_fold' | 'fold_watch', amount: 0}` through the shared `submitAction`.
- **Capability map** (`src/lightning/lightningCapabilities.ts`). Covers `fast_fold, fold_and_watch, multi_table, hotkeys, session_stats, replay, sound` per platform. FOLD & WATCH is desktop only by default, and platform detection is kept apart from the rule.
- **Pre-action safety.** In a Lightning room an armed pre-action is bound to the hand key (the engine `hand_id`, otherwise the hand number). It is dropped the moment the key changes. A failed clear never restores an arm there. The arm request carries `handId`, and only from a Lightning room.
- **"Next Hand..."** appears only when the gap between hands passes 2.5 s.
- **Lobby.** The chain read embeds `cash_games.cluster_mode`. For Lightning Clusters only, the board reads `fn_cash_game_lobby(...).lightning` (fn_cash_cluster_lightning_state). The card then shows LIGHTNING LIVE, the pool's player count and a pool status: BUILDING below the on threshold, ACTIVE, HOT at twice the on threshold or more, and THIN at or below the off threshold or in pending_off. Its door is JOIN LIGHTNING, which opens `/lightning/:clusterId`. VIEW GAME opens the same route. Every other card is unchanged (MUST MOVE).
- **JOIN LIGHTNING hand-off** (`useLightningAnchorHandoff`). After the buy-in at the anchor table the player joined through, the tab follows the player's chair into the pool-session room through the existing `movedToTableId` re-point, the same mechanism as a must-move. It only runs for an anchor table with an intent set by the Lightning route.

## Contract Assumptions For The Engine And DB Engineers

1. `fn_lightning_my_session(p_cluster_id uuid)` is granted to `authenticated` and returns `{pool_session_id, state, cluster_mode, stack, in_hand, hand_id?}`. Pool session states `closed/ended/left/cashed_out/expired` mean no room.
2. The engine accepts SUBSCRIBE to a room id equal to `pool_session_id`, sends every hand of the session in that room, publishes `max_seats`, and sets a per-hand `hand_id`, either top-level or in `snapshot.lightning.hand_id`. It may add `snapshot.lightning = {cluster_id, hand_id, name, small_blind, big_blind, variant}`. An unknown or ended room closes with 4404.
3. POST /action accepts `fast_fold` (whenever a fold is legal, including before the player's turn) and `fold_watch` with `tableId = pool_session_id`.
4. POST /preaction with `tableId = pool_session_id` may carry `handId`. The engine must refuse an arm for any other hand and drop every arm at a hand change.
5. A player who buys in at a Lightning Cluster's table gets a pool session readable through rule 1 within about 60 s.
