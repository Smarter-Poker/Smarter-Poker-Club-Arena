# tests/a-diamond-rebuy-proves-its-generation.law.test.ts

When a tournament player busts, the engine records a knockout generation
(tournament_knockout_candidates) from the accepted hand. If the player buys
back in and busts again, the older generation must be resolved as bought back
before the newer bust can be recorded; otherwise every later bust of that
player is refused, an alert asks for a ruling, and the event cannot finish.
Both knockout doors - fn_eliminate_tournament_player_atomic for a plain event
and fn_claim_tournament_bounty_elimination for a bounty event - prove "bought
back" the same way: a posted chip_ledger 'rebuy' leg moved that player's own
wallet into the event's prize liability after the generation was captured and
before the next one was.

A Diamond rebuy or re-entry writes no chip leg. Phase 8 routed it through the
same purchase core into fn_poker_diamond_tournament_charge, which writes a
'rebuy' or 'reentry' row on the Diamond tournament ledger and moves the
Diamonds into custody. So in a Diamond rebuy event the proof could never be
found: the first player to bust, buy back and bust again would have been
stuck, with the event behind them. The Phase 9 survey found it while mapping
the bounty doors, which read the same proof.

Migration 20260914111558 adds the Diamond proof beside the chip proof in both
doors, in place: the same window (after this generation, before the next),
the same player, the same event, a Diamond ledger row of kind rebuy or
re-entry with a positive amount. The chip proof is kept verbatim; the two are
one predicate. The live md5 of each door is pinned, each clause occurs once,
and the reverse substitution reproduces the pinned text. The law pins those
mechanics and the closing assertions: both doors read both proofs, the
window is named once for each, and every watched guard is on its baseline.
The proof was read on real rows in the bounty rehearsal (a Diamond rebuy
between two captured generations proves the older one; see
a-diamond-bounty-is-paid-from-its-own-bank).
