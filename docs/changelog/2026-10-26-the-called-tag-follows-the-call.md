# The "Called" tag follows the call, not the muck (2026-10-26)

Dan, 2026-10-25: a hand that called the river must be visible in Previous Hand,
and (Phase 1) such a hand is tagged "Called". Phase 2 then made the engine table
every hand whose last river decision was a call, win or lose.

That left a gap: the tag keyed off `calledMuck` - a seat the engine ruled
MUCKED whose cards the record still holds. From the engine release onward a
losing river caller is SHOWN, never mucked, so the tag would have disappeared
from every new hand.

The replay now records, per seat, whether its last river decision was a call
(a call, or an all-in that put in no more than the level it faced - the same
rule the engine and `fn_ca_called_river_mucked_cards` use) and marks a shown
hand that called and won nothing as `calledRiver`. Every surface that tags a
called muck tags it too: the hand detail modal, the hand detail page, the
replay seat strip and the text summary ("showed X (called the river)").

Older hands keep `calledMuck` exactly as before; the export still writes a
mucked call as a muck and a tabled call as a show, which is what happened.

Pinned in `tests/a-called-river-hand-shows-in-previous-hand.law.test.ts`.
