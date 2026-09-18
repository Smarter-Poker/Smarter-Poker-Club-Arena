# Leave room for hosted verification after runner assignment

Hosted run35289592499 waited from00:04:11UTC to00:13:40UTC, then completed successfully at00:14:05UTC. Its normal pre-push caller exhausted the old ten-minute total deadline while consuming the successful proof. The queue had consumed virtually the whole execution budget.

The existing bounded coordinator now allows21minutes total: ten minutes of observed queue allowance, the existing ten-minute hosted execution limit, and one minute for authenticated artifact consumption. The catalog proof still expires after five minutes from its actual observation. Exact source/head identity, successful trusted-run provenance, the three-attempt limit, head-change refusals and deadline checks before/after consumption are unchanged.

The delayed-queue regression failed before this change and passes afterward. Existing expiry, forged-timestamp, wrong-head, cancellation, refresh-bound and over-deadline refusals remain in the same directly invoked suite. This changes neither database content nor the application runtime; publication and live behavior need their own evidence.
