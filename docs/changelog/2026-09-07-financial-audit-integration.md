# Financial audit integration

Integrates the already deployed guarantee journal atomicity, tournament-owned guarantee funding, original Spin reserve-owner cancellation return, and verified-zero union recipient shortfall migrations with current main. Preserves the landed aggregate Spin fee reversals and insurance runout test isolation.

Each financial correction includes its self-aborting SQL probe and a shipped invariant. Probes use temporary fixtures and stubbed external helpers; they do not certify full production wallet-trigger or concurrency behavior. No historical balance adjustment or player payment is performed by this integration.

Follow-up to the overlay investigation: the September 3 tournament 1068cd04-41c8-4168-83cb-243ebe693918 already has correction journal 5a53b250-03fb-4fb5-84f4-f8c0f87b3b1d. Recorded prize inputs plus overlay equal paid prizes (432 + 18 = 450), with bounty 540 in/out and fee 108 in/out. No additional historical overlay payment was made.

The insurance isolation commit passed server, client and TypeScript CI; the earlier SQL branches encountered runner-sensitive Omaha timing and insurance wait failures. This integration retains the existing test limits. A passing run is not capacity certification.
