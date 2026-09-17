# Horse committed-opponent pricing audit, September 14

The actual reference decision path now retains the complete committed opponent population and its matching reads. Rake tiers and ante orbit costs use the dealt table population, including folded or away dealt seats, while explicit undealt seats remain excluded. These are source repairs, not a Phase 8 promotion or completion of all fifteen phases.

## Reproduced failures and corrections

- An actual three-dealt-player river call received heads-up marginal rake (0.05 instead of 0.10) after one dealt player folded and sat out. All seven reference rake/ante/table-size counts now use the dealt census. Paired actual river-call inputs prove the three-player and explicit two-player cap; paired satellite reads prove the 18BB versus 14BB forced-orbit runway.
- In PLO4, PLO5, PLO6, PLO8, FLO8, FLH, Pineapple and Short Deck, the V38 preflop path sampled four committed opponents as three when present and as one when away. It supplied ranges from the broader player list, which could assign a waiting player's range to a different committed opponent. Sixteen negative cases reproduce this. The actual sampler now receives all four committed players and their own ordered bands. All-in showdown rights survive sitting out.
- A player must actually match the current price to enter the already-committed group; an unpaid difference is not rounded away with the former one-percent tolerance. Another live responder is required before attempting isolation. Tests retain the real pot-limit legalization: the fixture's isolation intent becomes a legal raise to 202, whereas a closed all-in group is called for 48.
- Impossible committed holdings are rejected before sampling rather than accepting the evaluator's exhausted-deck neutral return. The exact `v38_preflop_price_unavailable` receipt exposes the fallback. The existing range path remains responsible for its resulting decision; this is not a priced-equity success.

## Verification

Five focused files: 98 tests passed. Final complete server suite: 12,923 passed, 157 declared skips, 845 files passed and one skipped. The server TypeScript build passed. No checks or sample-governor safeguards were weakened.

The local Darwin arm64 Node 22.23.2 counterbalanced component measurement covered eight variants with both present and away committed opponents, ten warmups and fifty measured decisions per case. All 960 calls per implementation reached the real V38 price path. Corrected case p99 ranged from 1.043ms to 5.927ms. Full-governor sample budgets remained 136, 149 or 360 depending on variant. Four-player pricing naturally costs more than the erroneous away-player heads-up calculation. This is a bounded component measurement, not fleet latency, the strict Phase 8 completion gate, or evidence of GTO optimality.

Preserved evidence in the task workspace: `horse-rake-dealt-population-before.log`, `horse-committed-opponents-before.log`, `horse-population-focused-final.log`, `horse-population-full.log`, `horse-population-build-final.log`, and `horse-population-latency.json`. An initial new isolation test incorrectly expected an unrestricted all-in; it was corrected to assert the real legal pot-limit amount, without altering the legalizer.

## Remaining scope

Continue reviewing response-versus-showdown player filters, especially tournament coverage and table-wide exploit summaries. Full Phase 14 causal learning and complete source coverage, Phase 15 durable private decision/execution records and fresh-process replay, native publication and natural qualification remain unfinished. The added over-10BB review records remain unverified until matched decision and reference evidence exists.
