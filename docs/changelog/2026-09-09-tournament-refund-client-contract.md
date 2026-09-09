# Tournament Refund Client Contract

The live fn_ca_tournament_unregistration_receipt returns refunded_chips. TournamentService.unregisterPlayer still read refunded, suppressing balance refresh after a confirmed chip refund. Its old mocks also used that obsolete field.

The client now reads the live field and requires boolean ok plus a finite, nonnegative numeric refunded_chips before returning success. Confirmed zero-chip outcomes remain valid. Server refusals retain their existing messages. No wallet mutation or refund calculation was added to the client.

Verification: the malformed-receipt regression initially failed seven cases; the corrected service suite passes all 89 cases, including positive and zero refunds. TypeScript passes. The live contract was inspected read-only; no production transaction was executed. Production build passed with behind-main=0; publication remains pending.

Initial registration still lacks durable request identity, and unregistration callers still need request-key wiring. This change does not close CA-03-11 or the full phase. Existing published purchase-retry evidence remains valid and will not be rerun without a relevant change.
