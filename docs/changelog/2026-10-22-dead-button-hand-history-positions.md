# Dead Button Hands In Hand History And The Replay

Follow up to `2026-10-21-dead-button-position-labels.md` (PR #7681, the felt
and the recorded hand facts).

`src/utils/pokerPositions.ts` is the client's one position derivation, used by
Hand History, Hand Detail, the shared-hand export and the replay. When the
button seat was not among the dealt seats it returned nothing, so a
tournament dead-button hand such as #43306703 showed no SB or BB badge and the
replay could not say which seats posted the blinds.

The empty button seat now keeps its place in the order, exactly as the engine
and `derivePosition` in `handFacts.ts` treat it: the seat after it is SB, the
next BB, the rest UTG through CO, and nobody is BTN. An unknown button (null)
and a heads-up hand still return nothing. The two unit tests that pinned the
empty result for a dead button are updated in the same commit.
