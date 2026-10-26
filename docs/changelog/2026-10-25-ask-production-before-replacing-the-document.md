# Ask Production Before Replacing The Document

Follows #8140, which made a stylesheet failure ask production
(`readLiveBuild`) before reloading, after post-deploy run 40260290873 (WebKit)
hijacked the Kings Club lobby navigation with #8100 and #8101 live. Two other
recovery paths still replaced the document on a clock:

1. **The deferred departure recovery** (`afterNavigationGrace`) recovered at
   the grace whenever the live build could not be read. WebKit refuses a
   leaving page's new fetches, so an unreadable answer is what a pending
   navigation looks like from inside it. It now keeps waiting on `this` or
   `unknown`, up to `CURRENT_BUILD_PATIENCE_MS`, and recovers at once only on
   `other`. Once it decides, the departure is cleared so recovery proceeds.
2. **A failure that arrives after the grace** while a departure is still
   undecided (a lazy import's retry backoff can outlast ten seconds) reloaded
   on the spot, because `documentIsNavigatingAway()` had expired. It now goes
   through the same confirmation, and a lazy route keeps suspended meanwhile.

A failure with no departure still recovers at once, and no waiting spends
reload budget.

Tests: `tests/chunk-load-recovery.test.ts`. Two existing cases pinned
"recover at the grace when the live build is unreadable", the defect, so they
now assert waiting until the patience ends; one #8100 case is replaced by
"keeps waiting while the live build cannot be read", and one new case covers a
late failure after the grace. All four fail on the previous code.
