# Two F06 Doors That Held Stranded Events

## A Never-Started Dead Hand Leaves Its Own Park To The Successor

Event 41eb379e has not dealt since 2026-09-26 05:21 UTC. Its dead generation
asked to break its only table and then reserved a hand it never dealt. The
abandoned-generation door refused `F06_ABANDONED_PARK_CHANGED`, because a
park of the dead generation's own origin could only be withdrawn against a
hand receipt with a snapshot. The door now leaves that pre-manifest park for
the adopting successor exactly as it leaves a foreign one, only when the hand
never started (no snapshot, no hole card, no dispatch). Migration
`20260927145416`. No money moves.

## A Stranded Mixed Original Hand Is Voided With Every Stack Unchanged

The 2026-09-26 09:33 UTC collapse left 71 RUNNING events (23ef2d58 among
them) with an open mixed custody transfer and 1 to 4 reserved hands of the
dead origin generation, each dealt preflop and never dispatched. The
successor's admission refuses until each original hand has a terminal
disposition, and only the dead origin could give one, so these events held
no lease for 30 hours. `public.fn_f06_void_stranded_mixed_original` proves
from rows that every chair already holds its pre-deal stack (snapshot stack
plus everything put in), writes the mixed abort receipt the admission reads,
and disposes the origin generation only. The engine then admits the
successor, completes the transfer and resumes dealing. Migration
`20260927145449`. No chip, registration, ledger row or wallet is written.

### The First Apply Refused, And Why The Void Now Admits The Successor Holder

The first apply of `20260927145449` (2026-09-27 16:17 UTC) rolled back with
nothing committed: engine 4946473b had just restarted and was claiming the
successor generation of these events while the void ran, and the post-image
required that no lease exist. A holder of the never-admitted successor
generation cannot act (its admission is refused until the void's receipt
exists, and every F06 write needs the lane the void holds), so the void and its
post-image now admit exactly that holder and still refuse any other. The file
was never applied, so it is corrected in place, and its time budget is 6 s.
