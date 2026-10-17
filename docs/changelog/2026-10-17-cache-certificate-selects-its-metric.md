# Select the metric owned by the cache certificate

Post-deploy run 39003467512 passed the live Cashier contract and all other certificate groups, but its broad sweep found a new leaderboard cache assumption: the test read the global Profit cache while the club's published prize plan correctly selected another default metric. The production default was introduced in PR #7193 and must stay.

The cache certificate now explicitly clicks Profit and verifies its selected state before entering Global on each cold, warm and expired document. All existing network success, ranked entries, held-response cache paint, expiry eviction and fresh revalidation assertions remain. No product, financial or timing change, and no retry.

The unchanged test failed in the hosted production run. The corrected maintained case passed against production at 393px (27.7 seconds), including cold data, warm paint before the held response and expired-record eviction. The reserved zero-balance account was hard-deleted and Auth absence verified. All 38 cache/recovery/hardening tests and TypeScript compilation passed locally. Protected checks and the complete post-deploy result remain required.
