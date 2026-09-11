# tests/law/BountiesAndRefundsSettleThroughObligations.law.test.ts

Every bounty payer settles through the generic `fn_settle_tournament_obligation` authority with no direct credit. The generic eight-argument dispatcher fails closed for `kind='refund'` with `exact_refund_authority_required`; wallet-funded entries return only through `fn_settle_tournament_refund_exact` to the entitlement's recorded source wallet, while satellite-seat and tournament-ticket entitlements return only through `fn_ca_return_satellite_entitlement_as_ticket` with zero wallet chips (R3, roadmap 1.1).
