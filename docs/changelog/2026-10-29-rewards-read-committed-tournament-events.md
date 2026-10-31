# Rewards refresh from committed tournament events

Rewards previously refreshed its bounty ledger only when the number of eliminated entries changed. Committed bounty changes and reconnects with the same count left the opening amounts on screen. A rendered regression fails before the change.

Rewards now shares the existing tournament standings event subscription. One active read and one coalesced trailing invalidation preserve event updates without overlapping ledger responses. Unmount/event change retires the subscription and queued work. The complete-read and event-scope guarantees remain intact. No polling or payout writes are added.

Verification: 1 rendered regression fails before; 10 ledger cases and 71 connected tests pass after, including event coalescing, unsubscribe, queued-read cancellation, ledger read failure and arena units. Root TypeScript and diff checks pass. Source reread confirms the connected subscription. Hosted checks and publication remain pending. This client change uses the existing engine event contract and does not require a new engine API.
