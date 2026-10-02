# The September 8 Busts Carry Their Stamp, and the Four Duels Are Refunded

After #5754 launched the 26 September 8 Spins and heads-up Sit & Gos, the
engine's finish lane reached the terminal authority on every pass and was
refused: "tournament has no complete durable elimination sequence". The
refusal comes from `fn_settle_tournament_places`, which requires every
eliminated entrant (field minus the survivor) to carry a distinct
`tournament_players.elimination_sequence`. That value is the durable record of
a bust, stamped by the knockout door's trigger when a row moves into
`eliminated`. The 37 busts of these events were recorded on 2026-09-08, before
the stamp existed for them, so they had a place and a bust time but no stamp
(the two Spins that played on after #5754 had their new 2nd-place busts
stamped and still lacked the 3rd).

Migration `20261002014932` writes that one value exactly as the door would,
through the NULL-to-value acquisition the trigger permits on a row already
eliminated, in finishing order: `nextval` per bust, earliest first, and for
6d359f61 and 8904c10b the value just below the existing 2nd-place stamp. The
door itself cannot be called: it needs a knockout candidate and an accepted
hand, and retention removed those. Every row and event is pre-image guarded;
the post-image proves each event's sequence is complete, distinct and ordered
and that nothing else moved. The file pays nobody: the engine's finish lane
pays each survivor the first prize.

Migration `20261002014954` cancels the four heads-up duel satellites (097e3601,
20c75b67, 92c93927, a4262ba0) through `atomic_cancel_tournament`, as the
service role, refunding every entrant the whole buy-in and fee: 8 entries,
390.00 (370.50 prize escrow plus 19.50 fee escrow). They could not be settled
because their pre-agreement fee cannot be attributed, and the seats they were
played for no longer exist (their targets completed 2026-09-09 to 09-15).
