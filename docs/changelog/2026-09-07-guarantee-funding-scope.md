# Final guarantee funding follows tournament ownership

The final guarantee RPC selected the club's current union. The start-time trigger uses the tournament's recorded union and private flag. An isolated actual-function test showed a club move redirecting the final overlay to the new union.

The original finalization RPC now uses tournament ownership too. Private and standalone events fund from club treasury. Existing absent-union-bank fallback, advertised guarantees, arithmetic and replay behavior remain unchanged.

Original reproduction failed; candidate and installed probes passed event union, private and standalone funding, full replay and missing-bank fallback. Tests used temporary tables and self-aborted; actual ledger/escrow triggers and concurrent sessions were not covered. Fresh stored-overlay inspection found no matching private/wrong-event-union debit records. No historical balances were changed.

Applied migration: 20260907221633. Missing-bank success handling, finalized-record proof and complete funding/escrow integration remain separate audit work.

Historical overlay follow-up: the 18-chip failure 704 already has correction journal 5a53b250-03fb-4fb5-84f4-f8c0f87b3b1d, posted September 3. A fresh escrow read shows prize 432 + overlay 18 = paid 450, bounty 540 in/out and fee 108 in/out. No historical adjustment was needed or made for that journal failure.
