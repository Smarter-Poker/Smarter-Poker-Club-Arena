# Resolve known terminal refusals without repeating the money request

The ordinary and satellite settlement helpers retried every database error five
times. A missing original fee source or incomplete durable elimination sequence
therefore held an elimination scheduler slot through four unnecessary backoffs
(three seconds total) and four additional identical settlement requests before
the existing serialized outcome check.

Both helpers now end that retry loop only for structured `P0404` responses whose
exact message identifies the requested event and one of those two evidence gaps.
They still enter the same serialized resolver with the same request identity.
Only its verified committed receipt or definitive non-commit response can resolve
the caller; an unavailable, mismatched or invalid response remains unknown. A
previous lost response may have committed even when the next request is refused.

Other SQL errors, lock and statement timeouts, deadlocks, transport exceptions,
and unrecognized messages retain the existing retry budget. Stored-receipt
disagreement adoption, proposal identity, manager fencing, subsequent scheduler
wakes and financial alerts are unchanged. Unknown-outcome messages report the
number of write attempts actually made.

The existing RPC-helper tests reproduce the old amplification and cover the
early serialized check, held resolver, prior ambiguous commit, exact proposal
identity, invalid receipts and preserved transient retries. Connected manager,
recovery, receipt and scheduler checks remain required. These are local engine
regressions with mocked RPC transport, not proof of financial reconciliation or
production throughput. The missing historical evidence still requires its own
supported correction; this change does not bypass a financial refusal.
