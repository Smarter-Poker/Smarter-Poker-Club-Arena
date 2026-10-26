# 2026-10-26: no Lightning player is left with no way forward (Lightning transition, phase 2 of 5)

Client only. No engine (`server/`) change and no database change. Every new
branch is gated on the room being a Lightning pool session, or on the table
being a Lightning game's anchor table; Classic tables are unchanged.

## What a player saw, and why

1. **A player who busted sat on an idle felt with nothing to press.** The cash
   table's bust prompt stands down in any Lightning room, and the only
   automatic way back was the opt-in auto top-up, which every live Cluster had
   off. Formation never deals a zero stack ('NO_STACK'), so the player waited
   until the disconnect reaper ended the session. Production, read on
   2026-10-26: the four most recent human sessions that ended
   `disconnect_expired` had all busted to 0.00 first, one after 2h53m.
2. **"Joining Lightning..." stayed up after a buy-in nobody could confirm.**
   `buyIntoLightning` marks the join intent before the purchase, and its two
   unconfirmed returns left it standing, so the anchor table showed
   LightningJoining (waiting for a pool session) until the player pressed
   Cancel, instead of the table and its saved buy-in. The table's own buy-in
   sheet at a Lightning game did the same on an unknown or refused outcome.
3. **Two endings read "Your Lightning Session Has Ended".** `cluster_unfrozen`
   (an operator bringing a frozen game back) and `lightning_off` (the game going
   back to MUST MOVE) had no words of their own.

## What changed

1. **The rebuy sheet, once per bust.** `src/lightning/lightningBustRebuy.ts`:
   - `lightningBustCandidate`: a zero is a candidate only between hands (no live
     hand, hero not in the roster), with the room open and the player not
     sitting out. An all-in hero's roster zero never counts.
   - `useLightningBustRebuy`: the database confirms it (`readLightningTopUp`:
     not in a hand, the pool session active, the anchor seat theirs, live, not
     leaving, not sitting out; and the allowed maximum). A read with no answer
     yet (a hand still settling) is asked again, up to six times. With the
     opt-in auto top-up on, it waits 2.5 s first so the auto top-up lands
     instead. It fires once per bust and is armed again only once chips are seen.
   - TablePage opens the existing cash rebuy sheet (BuyInModal, rebuy mode, the
     owner-approved purchase artwork) capped at that maximum. It shows the
     honest busted state and the player's wallet balance.
   - **Funding**: `confirmBustRebuy` has a Lightning branch ahead of the Diamond
     and chip branches. It calls `handleAddChips` with the Lightning scope (the
     anchor seat, re-read around the request, only this pool session's own
     receipt accepted) and holds ONE key per bust and amount across retries
     (`bustRebuyKeyRef`), so a lost answer replays the same request, which
     `fn_lightning_top_up_request` answers from its receipt without moving
     chips. A refusal the engine proves terminal releases the key.
   - **Leave**: the sheet's painted secondary plate reads LEAVE (BuyInModal
     `onLeave`, rebuy mode only; omitted everywhere else, so every other table's
     sheet is exactly as before). It runs the room's own `handleLeaveTable`,
     which cashes out the anchor seat and opens the Lightning session summary.
     The corner close only closes.
   - The sheet closes on its own if chips arrive by another path or the room
     closes. Nothing here moves the player (CLAUDE.md 10.6). There is no horse
     branch (CLAUDE.md 10.5). Horses fund through their own input device.
2. **Not confirmed is not joining.** `buyIntoLightning` clears the intent on both
   unconfirmed returns (unknown outcome, and an earlier request to review), as
   it already did on a refusal. TablePage's buy-in sheet clears it on unknown,
   refused and review-original outcomes at a Lightning game's anchor table. The
   player sees the table with the saved buy-in. Retrying through the sheet
   marks the intent again under the same request key. If the purchase did in
   fact commit, the funded seat's existing conversion read offers VIEW GAME when
   the pool session appears. Cancel is unchanged.
3. **The words.** Both paths keep the seat and every chip, as their own
   migrations prove: `fn_cash_cluster_unfreeze` asserts the seats' chip total
   did not move, and `fn_cash_cluster_commit_must_move` writes no `table_seats`
   row and refuses to release a player whose anchor seat is not theirs and live.
   - `cluster_unfrozen`: "Your Lightning Session Ended While The Game Was Paused."
   - `lightning_off`: "Lightning Has Ended For This Game."
     The seat line ("Your Seat Is Ready At Your Table.") follows, as for every
     ending, only when `fn_lightning_reconnect_state` names the seat (it does only
     while the player still owns it). That is why the suggested fixed wording
     "Your Seat Is Kept." was not baked into the title: the notice would have said
     it even after the player had stood up.

## Tests

- New: `tests/lightning/lightning-stuck-players.test.tsx`. It covers the bust
  candidate and verdict rules; the hook firing once per bust, re-arming after
  chips, ignoring a contradicted zero, retrying an unanswered read, deferring
  to the auto top-up and standing down behind another money sheet; the rebuy
  sheet's LEAVE and close; the Lightning funding branch and its held key; the
  intent clearing, checked through the real anchor hand-off hook; and the two
  endings' words rendered in the ended notice.
- No existing test needed changing. The stand-down comment in the cash bust
  watch keeps the phrase `tests/a-lightning-player-between-hands-shows-their-balance.law.test.ts`
  anchors on.
