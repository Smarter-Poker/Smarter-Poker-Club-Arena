# Approved Poker Table

Owner selection: October 31, 2026, option 1 from the October 27 Game Lobby comparison board. The attached close-up is the visual reference. `table.png` is the built-in imagegen alpha extraction used by `scripts/art/build-game-lobby-footer.mjs`.

Prompt: Extract only the approved oval poker table, chairs, chrome rails, champagne gold trim and black felt/spade. Preserve perspective and design. Remove quilted leather and GAME LOBBY text; transparent outside, opaque felt inside. No added objects, lettering or redesign.

Rebuild from repository root with `node scripts/art/build-game-lobby-footer.mjs`. The builder retains the previous masters and quilt fill, changes only the Game Lobby cell, and writes new immutable asset versions. Keep prior image URLs available for existing clients.
