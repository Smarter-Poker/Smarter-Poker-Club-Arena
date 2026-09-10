# Phase 3 funded bounty add-on evidence

One previously open T01/T05 subset is verified: a real funded PKO entry followed by the actual public add-on purchase preserves the bounty liability and player head. This does not declare either control or Phase 3 complete.

| Boundary | Entry | After add-on |
| --- | --- | --- |
| Cumulative wallet charge | 200 | 215 |
| Prize pool and prize escrow | 175 | 190 |
| Bounty pool and bounty escrow | 5 | 5 |
| Fee total and fee escrow | 20 | 20 |
| Player bounty head | 5 | 5 |
| Seat and roster chips | 500, seeded playing state | 600 |

The add-on's immutable refund entitlement is exactly 15 prize, zero bounty and zero fee. Repeating the request with another client token returns the stored response and leaves all tracked rows unchanged. No bounty obligation, payout or completion marker is synthesized.

The group uses the existing isolated PostgreSQL 17 runner and purchase setup, with a callback that sets the bounty format before real registration. The shared runner is unchanged. Existing seven registration, thirteen purchase, fourteen cancellation and nine guarantee groups were reused, not repeated.

The read-only catalog check at 2026-09-10 05:02 UTC found the purchase money core unchanged. The public purchase RPC now calls the installed tournament-scoped settlement lock helper; the seat trigger now uses two scalar tournament IDs rather than an array lookup. The focused overlay composes those exact current bodies onto the reused fixture and verifies all 34 purchase/helper hashes. Registration request `c80d08529c03284adc51c6cb03764a55` calls the two-argument core `233acf6219e11af17d2c44b4b4460bc0`; both match the captured fixture.

One group passed. Evidence: `/tmp/ca-registration-funding-pg17-v8yfkjbv/results.json`; normal private-cluster cleanup was confirmed at 2026-09-10 05:11:47 UTC. The committed fixture records this result.

T04 funded-bounty rebuy/re-entry remains open because its real public authority requires a completed prior bounty payout and exact completion marker. No reusable actual payer fixture is available in these lanes. Actual hand settlement, engine consumption of the grant, startup, and full HTTP/RLS remain separate acceptance. This change contains test code and evidence only, with no production migration or financial mutation.
