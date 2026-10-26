# Save An Unassigned Player To An Agent

The upline RPC identifies the club owner as a display fallback with `assigned: false` when the player has no stored agent. The roster adapter now preserves that flag, so Player Record Save sends the actual empty source instead of the displayed owner. An explicitly assigned owner remains the current source.

The adapter-to-card regression fails before this repair. Production assignment qualification now starts with an unassigned zero-chip fixture, clicks Save to assign it through the real Player Record, then verifies the existing second Save transfer, persistence, roster scope, audit/replay and fixture cleanup. No real player is moved for testing.
