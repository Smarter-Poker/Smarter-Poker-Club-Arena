# 2026-10-02 Lightning Phase 7 (Of 14): LIGHTNING To MUST MOVE Reversion, Engine And Client

Spec Phase 10. The database half (fn_cash_cluster_begin_pending_off,
commit_must_move, abort_pending_off, the tick-driven conversion, and the new
`seat_table_id` / `seat_number` from fn_lightning_my_session) ships in its own
pull request. This is the engine and client half. Dark in production:
`cash_games.lightning_enabled` is false everywhere.

## Engine

- **Discovery finds draining Clusters.** `discoverLightningClusters` now asks
  for `cluster_mode in ('lightning', 'pending_off')` with Lightning enabled and
  reports which are draining. A `pending_off` Cluster keeps its worker.
- **A draining worker forms nothing.** `LightningClusterWorker.setDraining`:
  each pass calls neither `fn_lightning_match_and_form` nor the matcher,
  a freed player does not wake it, and a keepalive line is logged once per
  keepalive interval. Hands already dealt keep their hosts (and their instance
  keepalives) and play on to settlement; nothing is abandoned. A Cluster that
  returns to `lightning` (abort) forms again on the next pass.
- **MUST MOVE stops the worker and closes the rooms at once.** When the Cluster
  leaves discovery the worker stops and the ended-room sweep runs immediately.
  `LightningRegistry` closes a room whose Cluster is `must_move` with
  "Lightning Has Ended"; any other ended session keeps
  "Your Lightning Session Has Ended". A mode that cannot be read still closes
  the room with the ordinary words.
- **Anchor tables resume on the settled stacks.** Verified: the halt poll runs
  every 5 s while halted, the reason ('lightning') is log copy only, and the
  FSM returns to 'running' when the halt clears. Found and fixed: the roster
  and the halt are read side by side, so the read that saw the halt lift could
  carry a roster answered before the last Lightning settlement committed, and
  the first hand back would be dealt on stale stacks.
  `readNextHandInputs` now reads the seats once more when the halt lifted in
  that read (one extra read per lift, nothing on any other hand).

## Client

- `parseLightningMySession` reads `seat_table_id`; `lightningReturnTableId`
  answers the player's table only for "no pool session, Cluster MUST MOVE, a
  live seat".
- **The room never goes dead.** `useLightningReversion` asks
  fn_lightning_my_session on each 4404 of a Lightning room; when it names the
  seat, the room shows the MUST MOVE notice ("Lightning Has Ended. Your Seat Is
  Ready At Your Table.") with one VIEW GAME button to `/table/<seat_table_id>`
  (the multi-table view is re-pointed by the same press). Law 10.6 makes no
  exception for a mode change, so the player is never moved automatically. The
  older "Your Lightning Session Has Ended" toast is not repeated over the
  notice.
- **The Lightning route** on a MUST MOVE Cluster where the caller is seated
  offers their table (VIEW GAME), never JOIN LIGHTNING or a second join.
- **The lobby** mapping was verified and pinned through the sequence:
  LIGHTNING LIVE ACTIVE / JOIN LIGHTNING, then LIGHTNING LIVE THIN / JOIN GAME
  while `pending_off`, then MUST MOVE / JOIN GAME.

## Tests

- `server/src/lightning/LightningPhase7Reversion.test.ts` (11)
- `server/src/engine/LightningReversionResume.test.ts` (3)
- `tests/lightning/lightning-phase-7-reversion.test.tsx` (14)
