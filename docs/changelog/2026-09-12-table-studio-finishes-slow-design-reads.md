# Table Studio finishes slow saved-design reads

The release browser check stopped at a disabled Carbon Club tile in its second
tab. A component regression reproduced a matching failure: the two-second
refresh starts a new read and invalidates the previous effect, so a slow initial
snapshot never enables the editor.

Refreshes now share an unfinished read within the current account and game
bucket. The newest effect still owns applying the result. The original mutation
revision travels with the read, preserving newer local and realtime changes.
Changing account, bucket or open state discards that scope's shared read.

The regression failed before the change. All 30 Table Studio hardening tests
pass afterward, including slow initial loading, account changes, missed events,
hidden-tab reconciliation and stale snapshots after newer edits. The browser
check must still pass in CI; this is not production-release certification.
