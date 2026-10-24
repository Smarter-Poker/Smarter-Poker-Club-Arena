# tests/unit/committedFoldIdentity.law.test.ts

Folded player identity disappears only after the serving engine confirms the same player, seat, table and hand, and only once the action has reached that seat: a fold pressed out of turn (a Lightning fold is committed immediately since #7896) stays on the felt until the turn passes the seat, the street changes or the hand ends. Queued pre-actions cannot hide it, occupied seats remain owned, horses and humans are treated alike, and the next hand restores the avatar.
