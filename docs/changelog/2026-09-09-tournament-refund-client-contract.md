# Tournament Refund Client Contract

The live fn_ca_tournament_unregistration_receipt returns refunded_chips. TournamentService.unregisterPlayer still read refunded, suppressing balance refresh after a confirmed chip refund. Its old mocks also used that obsolete field.

The client now reads the live field and requires boolean ok plus a finite, nonnegative numeric refunded_chips before returning success. Confirmed zero-chip outcomes remain valid. Server refusals retain their existing messages. No wallet mutation or refund calculation was added to the client.

Verification: the malformed-receipt regression initially failed seven cases; the corrected service suite passes all 89 cases, including positive and zero refunds. TypeScript passes. The live contract was inspected read-only; no production transaction was executed. Production build passed with behind-main=0; publication remains pending.

Initial registration still lacks durable request identity. This change does not close CA-03-11 or the full phase. Existing published purchase-retry evidence remains valid and will not be rerun without a relevant change.

## Original Refund Request Identity

The client now authenticates the requested account, persists the refund request ID before the RPC, and calls the already deployed two-argument fn_unregister_from_tournament overload. Only a receipt matching that ID and the live refunded_chips contract completes the intent. Unknown responses retain their identity through reloads. Web Locks serialize storage and submission across tabs; an older pending tab cannot replace a newer shared intent. The live server already binds a request to its original player, event and registration lifecycle and refuses using it against a later registration. No database migration is needed for this wiring.

Verification: 91 service tests and four storage/intent tests passed. TypeScript and production build passed. The storage failure fixture initially spied on an unused browser prototype; it was corrected to inject failure into the actual sessionStorage dependency, with the same no-submission assertion. No production financial transaction was executed. PR4013 publication remains pending.
