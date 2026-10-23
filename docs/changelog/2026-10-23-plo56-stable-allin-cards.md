# Stable PLO5 and PLO6 all-in cards

Five- and six-card tabled hands now share one size at the hero and every opponent: the board size normally, with a shared readable side-lane size on dense mobile rings. Their fixed half-card spacing leaves each rank and suit index visible. The layout no longer compresses these hands to 27% spacing or shrinks selected seats to 85% during the runout.

Revealed-hand placements belong to the current table/hand and viewport geometry. Board, pot, highlight and animation events reuse those placements. Existing hands reserve their locations before a later seat reveals; a new hand or real geometry change allocates them again. The board width comes from the table's settled geometry rather than an animated board-card measurement. Top pods also retain their placement rather than following avatar breathing.

All-in and winner cues animate the avatar; the big-win shake animates the table artwork. Card reveal turns the inner artwork within a fixed card slot without scaling the layout. Dealt-card indexes still govern winner highlighting and privacy; display slots retain their DOM identity during reveal.

Regression coverage extends the occupied six- and nine-seat phone renders to PLO5/PLO6 all-in hands, uniform sizing, fixed geometry after animation events and minimum readable spacing. The existing board/player/wager/hand-overlap assertions remain enforced. Focused seat, card-geometry, placement and animation tests also apply.

Short phones reserve the card-and-marker lane throughout every hand: six-seat tables remain shorter than nine seats, with enough height to keep the top all-in marker clear of the player plate and pot. The narrowest phones and dense mobile rings share a fixed tabled-card width rather than compressing individual hands.
