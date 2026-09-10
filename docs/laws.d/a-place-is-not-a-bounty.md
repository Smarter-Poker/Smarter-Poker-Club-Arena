# tests/a-place-is-not-a-bounty.law.test.ts

A bounty that cannot be settled never withholds a finishing place. The knockout
door records the elimination and assigns the place in every case; when the head
cannot be attributed - no exact pot claimant, a PKO watermark already advanced
past the hand, no head value - it writes no obligation, leaves the head in the
pool for `fn_finalize_bounty_pool` to resolve as residual, and records one
`financial_alerts` row. Every EVIDENCE gate that answers "did this bust happen"
still refuses, and so do the bounty ordering rules whenever a bounty IS being
settled. Written after 62 busts across ten events sat unrecorded behind
`exact_pot_claimants_not_found` and `pko_order_already_advanced`, holding
3,600.00 of prize escrow that had nothing to do with bounties.
