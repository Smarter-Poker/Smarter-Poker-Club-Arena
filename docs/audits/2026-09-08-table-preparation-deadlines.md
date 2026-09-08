# Table preparation cannot remain pending forever

The lobby's warm roster promise is inherited by TablePage on its first prefetch attempt. A read that never settled therefore prevented that attempt's retry handler from running. Separately, a hanging token request left a warm entry's socketPending flag set. Repeated visible-row refreshes reused that entry and extended its lifetime without releasing the stalled attempt.

Warm roster waits now fail after five seconds, allowing the existing real-table prefetch retry to make its own read. Warm token waits fail after fifteen seconds, releasing socketPending so a later intent can try again. The shared-lobby transport preparation also has that token deadline. Underlying SDK requests remain observed; a late response cannot populate the cache or acquire a stale warm socket through the expired wait. The shared auth SDK itself is not cancelled.

Regression coverage drives never-settling roster and token promises, verifies deadline recovery, and resolves both old requests late to ensure no stale rows/socket appear. Existing observer preparation and warm-slot ownership tests are retained. Client TypeScript passed. Production verification remains required after publishing.
