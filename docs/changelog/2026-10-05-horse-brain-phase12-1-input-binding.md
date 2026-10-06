# Horse Brain Phase 12, P12.1: a Short Deck, Pineapple, FLH or FLO8 proposal records what it used

Every eligible Phase 12 proposal now carries a frozen input binding
(`remaining-variant-input-binding-v1`): the dealt census with the engine's
posted blind seats, positions derived from those blinds, the betting
structure's own geometry (the no-limit wager cap, or the fixed-limit street
bet, completion increment, wager count, cap and canonical wager), depth, rake
and ante, board facts, the pack's seat ceiling for the table's mode, the
hand-shape entry score (labelled not a probability), Pineapple's private
discard as a count only (never a card value), and the sampler's range
provenance (public action line only, uniform escapes counted, 36 or 52-card
deck, the declared flop-only Pineapple discard prior, requested and completed
samples). The execution witness commits to it (`phase12Inputs`), the journal
reviewer refuses a changed commitment, and the worker boundary validates it,
dropping a shadow-only receipt that fails rather than taking the worker down.

Five defects, each reproduced on main first, are fixed at the owner:

1. A tournament dead button (an empty dealer seat) was refused as
   `canonical_state_unavailable`; it is now evaluated.
2. An occupied button with a dead small blind labelled the big-blind poster
   `small_blind`; positions now come from the seats that actually posted.
3. A valid census above the pack ceiling was named unavailable; it is now
   `seat_count_outside_pack`, outside the domain.
4. The receipt held the caller's equity object by reference, even where it
   consumed none; it now holds a frozen copy of what it consumed, or null.
5. Proposals were not in the horse legalizer's form (cent-floored cash wagers
   at whole-chip tables, raw calls that cover the stack, near-stack wagers,
   float noise); the real legalizer rewrote 20 to 92 per variant and mode on
   natural controller spots. Every proposal is now already in legal form, and
   fixed-limit wagers equal the controller's canonical amount.

P12-A remainder, tests only: the chosen and the forced Pineapple discard are
set side by side at the join (different round, public node, lane and
follow-up decision; the same kind of private record), and stale, crossed,
impossible and duplicate discard answers are shown never to reach the private
record, on a real controller and the engine's own discard handler.

Every Phase 12 pack stays shadow and unpromoted; no live action changes.
Record: `docs/horse-brain-phase12-1-input-binding-2026-10-05.md`.
