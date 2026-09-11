# server/src/tournament/aDeferredBalanceIsStillOwed.law.test.ts

A balance or expansion skipped during maintenance remains owed until a lifecycle-owned callback observes the actual thaw and requests the existing scheduler. A clock boundary is not a thaw. One subscription per manager generation is cancelled by lifecycle abort; the resume wave is spread without an independent timer or polling publisher. A balance cut short by its work budget gets one fresh-budget retry per cycle and a bounded next-cycle redrive if still owed, so elimination recording continues.
