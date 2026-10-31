# Published failover proof follows the healthy reader

PR #8846 fixes the repeated Player Management Live Sync Failed banner by retaining
an acknowledged independent record gateway through primary engine reconnects.
The existing explicit production proof still expected a recovered primary to
retire that healthy gateway. Align the proof and its fail-closed receipt validator
with the corrected behavior: after isolated engine interruption and restoration,
the gateway must remain open, deliver another genuine record event, and update
the reserved account's visible avatar. Paid-source isolation, before/after
publication pins, two bounded cosmetic writes, and owned-account cleanup remain
mandatory. Missing gateway delivery or a closed gateway cannot certify success.

This changes verification only. It does not republish client runtime, alter the
gateway, restart the engine, or mutate a real player's record.
