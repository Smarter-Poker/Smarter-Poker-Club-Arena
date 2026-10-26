# Original tournament payout observations

The horse context read already fetched `prize_pool_finalized` but discarded
its value after deriving entry windows. It also never read the payout asset.
New versioned observations preserve true, false and unknown finalization,
Bubble Promise state and the denomination from the original clubs join.

For explicitly finalized regular prizes, the capture uses the same canonical
payout structure, pool-funded Bubble Promise reserve and denomination-aware
place arithmetic as settlement. It records the complete contiguous funded
ladder, integer cents, reserve and content digest. Bounty and satellite award
models remain outside this ladder contract. Missing inputs produce no ladder.
These observations retain the existing context source interval; they are not
an atomic settlement certificate and do not authorize an award.

The table projection detaches these terms into the original private FAST
snapshot. Its full input digest covers them, while policy sampling excludes
the new observational metadata. Worker admission and replay reject malformed
present versions and retain compatibility with absent legacy observations.
No historical values are inferred, financial records changed or strategy
selection activated.

Validation: seven capture regressions failed on the prior source; the source,
cache and replay group passed 77 tests after repair. The final capture and
worker group passed 325 tests, including original journal roundtrip, digest
mutation and policy-sampling neutrality. Server TypeScript passed. Protected
delivery, the deployed join and natural live capture still require proof.
