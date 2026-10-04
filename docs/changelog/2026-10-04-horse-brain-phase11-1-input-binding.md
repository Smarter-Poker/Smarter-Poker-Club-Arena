# Horse Brain Phase 11, P11.1: a PLO5, PLO6 or PLO8 proposal records what it used

Every eligible Phase 11 proposal now carries a frozen input binding
(`omaha-variant-input-binding-v1`): the dealt census with the engine's posted
blind seats, positions derived from those blinds, pot-limit geometry, depth,
board, the pack's own seat ceiling for the table's mode, the hand-shape entry
scores (labelled not probabilities) and the variant sampler's range provenance
(public action line only, uniform escapes counted, completed work). The
execution witness commits to it (`phase11Inputs`), the journal reviewer refuses
a changed commitment, and the worker boundary validates it, dropping a
shadow-only receipt that fails rather than taking the worker down.

Four defects, each reproduced on main first, are fixed at the owner:

1. A tournament dead button (an empty dealer seat) was refused as
   `canonical_state_unavailable`; it is now evaluated, positions counted from
   the posted blinds.
2. An occupied button with a dead small blind labelled the big-blind poster
   `small_blind`; positions now come from the seats that actually posted.
3. A valid census above the pack ceiling was named unavailable; it is now
   `seat_count_outside_pack`, outside the domain.
4. The receipt held the caller's equity object by reference, even where it
   consumed none; it now holds a frozen copy of what it consumed, or null.

Every Phase 11 pack stays shadow and unpromoted; no live action changes.
Record: `docs/horse-brain-phase11-1-input-binding-2026-10-04.md`.
