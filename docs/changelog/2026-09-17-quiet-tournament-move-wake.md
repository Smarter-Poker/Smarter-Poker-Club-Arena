# Wake a quiet tournament source before claiming its move boundary

A table with one player can sleep for 60 seconds between roster reads. A tournament move armed its pause owner but did not wake that sleep, so the manager's existing one-second boundary probe returned false. The table parked later and could lose its unclaimed owner before the manager returned, leaving players separated across tables.

Arming the move owner now wakes the existing roster loop. The loop still has to enter its physical pause gate and drain accepted hand writers before the manager can claim or move anything. Probe duration, owner expiry, settlement barriers, lease checks and move receipts are unchanged.

Two regressions drive the actual start loop into its 60-second pause. Both fail before the correction and pass afterward, including pending settlement, claimed-owner retention beyond the unclaimed deadline and exact-owner release. The existing quiet-table and manager/engine move-boundary suites pass 23 tests; the server compiler passes. This is local source qualification, not production movement or end-to-end financial proof.
