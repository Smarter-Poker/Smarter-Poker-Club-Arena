# Reserved Presence Admission

The Table Studio production journey reached real appearance and account sync,
then failed because one reserved Presence peer was missing. That result alone
cannot identify a provider failure or a product defect: the old transport helper
returned before subscribe and track finished, and did not surface failed
admission to its caller. A local real-SDK/socket witness reproduced premature
success for delayed and rejected tracking.

The helper now validates the reserved session, awaits explicit SDK token
propagation, and returns only after subscription and a successful track
acknowledgement. Reconnect uses the same admission contract. SDK join/track
budgets remain unchanged. Failed admission disconnects its own transport and
signs out only its own local session. Sanitized subscription and track outcomes
are included in the production journey receipt and failure diagnostics.

Five direct real-SDK/socket cases cover normal admission, delayed join, delayed
track, track rejection and join rejection, retaining real two-peer state,
leave/rejoin and local teardown checks. The production journey still requires
both exact peer identities, the original 60-second peer assertions, the
65-second quiet interval with real heartbeat replies, leave and fresh rejoin.
No retry, fabricated Presence frame, union access, funding, or runtime change
was added. Local harness hardening is not proof that the managed provider or
live production journey has recovered; those require separate live evidence.
