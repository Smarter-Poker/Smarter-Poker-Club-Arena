# Prepare Unused Template Schedules Before Live Proof

The hosted client suite passed all 550 cases, but its reserved template's Daily schedule reached a natural cancellation while the suite ran. Cancellation correctly created an immutable zero-value escrow receipt, so the destructive unused-fixture cleanup correctly refused it. Template provisioning now uses the existing guarded schedule-only preparation door before exposing the fixture. It verifies the exact owned receipt, inactive schedule and absence of spawned children; activity and unknown outcomes still refuse preparation. Cash templates, cash games and Spin/SNG board fixtures remain available to the existing checks.

The schedule orchestration regression failed before the repair and the complete existing account unit file passed all 82 cases afterward. The original destructive cleanup guard is preserved. This change prevents unused reserved schedule spawns; it does not delete immutable cancellation receipts or claim an existing actor has been retired.

The separate retirement correction in PR #7379 is already installed as 20261018194130, with read-back core definition MD5 217edbd4a1200e023e2d85c29b05f827. That existing installed operation is reused and is not replaced or installed again here. Retained-record retirement and account cleanup remain separate qualifications owned by the release operation.
