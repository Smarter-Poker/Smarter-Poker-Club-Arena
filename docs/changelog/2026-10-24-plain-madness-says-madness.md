# Madness without Lightning says Madness (2026-10-24)

Dan, looking at the board: "THERE IS NO PLO5 MADNESS GAME RUNNING SMH".

The PLO5 1/2 Madness game (migration 20261024200548) was live with six players,
but its row read "PLO5 1/2 / Classic". Lightning Games own the Madness template,
so the game is a Classic must-move game carrying the Madness rules, and every
card printed the template's word.

- `plainMadnessStyleOf` (lobbyEntries) names a Classic game "Madness" when its
  tables carry a big blind ante and a VPIP floor, the two rules a plain Classic
  table never has, and prints "Big Blind Ante, 50% Minimum VPIP" from the
  table's own floor. The desktop row, the compact row and the phone/premium
  cards all read it through `cashTitleLines` and `cashStyleNote`.
- The felt masthead reads the game's `rules_profile` and says Madness for the
  same game.
- It stays an ordinary game: no Lightning icon, no Lightning door.
- Pinned by `tests/unit/plainMadnessSaysMadness.test.ts`.

## Madness is its own style

Dan, same day: "THERE IS ONLY LIGHTNING AND CLASSIC. NO STRAIGHT MADNESS GAME
WITHOUT LIGHTNING". The Stakes menu, the Game Style filter and the style counts
now offer three styles: Classic, Lightning Games and Madness
(`straight_madness`, decided by `cashStyleKeyOf` from the same table rules).
Picking Classic no longer shows the Madness game, and picking Madness shows it
alone.
