# server/src/config/acesFullOfJacksIsTheFloor.law.test.ts

Dan, 2026-10-11: hold'em's main Bad Beat Jackpot is Aces full of Jacks or better
with both hole cards playing, and both hole cards must play for the Mini too.
The main had been paying any aces full because `doesHandQualify` read the pair
of a full house as `kickers[1]`, while the engine's evaluator lists all five
ranks (AAA66 is `[14, 14, 14, 6, 6]`), so the "pair" was always the second Ace.
This pins the floor with hands taken from the real evaluator - aces full of
sixes and tens refused, jacks and kings paid, a dead hole card refused - and
pins the Mini refusing hands where either player's two cards do not both play,
including board quads. Past payouts are untouched; the rule governs new hands.
