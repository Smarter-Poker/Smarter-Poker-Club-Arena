# Diamond Custody Failures Reach Management

The final Phase 3 audit found that the server custody adapter propagated failed or invalid receipts without invoking the existing management alert path. Both reserve and release now await the established, service-only financial alert reporter before rethrowing the original error. The alert identifies the operation and stable request/custody or target identity. Its wording reports an unverified outcome, because a lost response does not prove whether the transaction committed.

The reporter already persists operator-visible alerts, applies its existing flood guard and escalates undelivered critical alerts through the existing error reporter. No custody retry, compensating credit, recovery worker, balance mutation or arena lockout is introduced. Successful calls and locally invalid amounts do not create alerts. Gameplay integration remains Phase 6.

Verification: 22 custody-contract cases and 8 existing alert cases passed. Cases cover response loss, one monetary call only, invalid receipts, failed alert delivery preserving the original error, and no alert on success or locally invalid input. Production alert delivery is not triggered with a synthetic financial incident.
