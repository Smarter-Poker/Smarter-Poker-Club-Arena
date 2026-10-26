# The Lightning Certificate Fixture Survives A Busy Union

Run 40153826373: the reserved account's admin promotion on the Midway union house club hit the service role's statement timeout (`57014`) and the operator certificate never got its authority; re-measured, the same update takes 71 ms, so the club was momentarily busy. The promotion is idempotent and a timed-out statement commits nothing, so `prepareProductionE2EStaffMembership` now asks again through the repository's bounded `retryTransient` (2, 4, 8, 16 s); a refusal is never retried.

Same run: the live lobby-join check passed end to end at 393px. At 1440px its readiness wait used the phone wallets button, which that width hides; it now waits for a visible game row, true at every width.
