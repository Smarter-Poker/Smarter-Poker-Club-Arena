# Lightning: one tap to join, a remembered amount, and the last waiting-list doors closed (2026-10-24)

Follows the one-question Join Lightning (#7905). Dan approved the list on
2026-10-24 ("GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE").

- **One tap.** `lightningJoinRoute(id)` (`/lightning/:id?join=1`) is the door
  from the club lobby's Lightning card, from PLAY AGAIN on the session summary
  and from Join Lightning on a Lightning table. The entry page opens the amount
  question at once; a player with a pool session still goes straight to their
  room.
- **Remembered amount.** The amount question pre-fills the player's last
  confirmed Lightning buy-in for that game (per device, `ca.lightning.last-buyin.v1`),
  clamped to today's range and wallet. The first visit keeps the standing
  default (the maximum, capped by the wallet). Nothing is spent without the
  confirm.
- **No seat is picked at a Lightning table.** A chair tapped on a physical
  table of a Lightning game opens the Join Lightning door; a `SEAT_RESERVED`
  refusal there goes to the same door instead of a waiting list; the
  must-move box (seat change, waiting list) is not shown on a Lightning table.
- **The page says why.** At the device's table limit, or with joins stopped by
  an operator, the entry page prints the reason under the card.
- **Dead code out.** The unused `LIGHTNING FOLD` / `FOLD & WATCH` labels, the
  Shift+V Fold & Watch hotkey branch and an unused busy state are removed;
  Shift+V in a Lightning room does nothing (it never becomes a call).

Pinned by `tests/lightning/join-lightning-is-one-buy-in.law.test.ts`.
