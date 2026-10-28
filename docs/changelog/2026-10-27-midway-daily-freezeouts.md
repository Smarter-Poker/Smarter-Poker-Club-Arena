# Midway daily freezeouts and complete union Games list

Owner request: daily NLH events at noon, 4 PM and 8 PM America/Chicago, beginning October 28. Each is 40 total chips, 20,000 starting chips and eight-minute levels without rebuys, re-entry or add-ons. Noon guarantees 2,500; 4 PM and 8 PM guarantee 5,000. The 8 PM event awards a fixed 10-chip bounty inside the 40-chip entry.

The union Games page selected only the latest 50 tournament starts, hiding tomorrow behind later days. It also displayed nonexistent buy_in and registered_count columns as zero. Page the complete union-owned set with stable start/id ordering, show nearest registering starts first, and paint the stored entry total, player count, guarantee, starting stack and bounty. Existing event subscriptions still refresh the same read; no new polling.

The owner explicitly reaffirmed the 8 PM freezeout after being told the general bounty rule forces rebuys. A database trigger exception is scoped to the exact already-created event and its exact recurring schedule, union, entry price and fixed bounty. Other bounty events keep the October 21 rule. The persisted row normalizes any existing spawner defaults, using current engine APIs without engine replacement. No wallets, seats, payouts or registered contracts are changed. Native PostgreSQL regression reproduces the old override, proves future daily occurrences retain freezeout terms, and checks unrelated clubs, prices, mystery bounties and running contracts. The existing required native CI shard runs it.

Production changes and live evidence remain in the task checkpoint under /Volumes/SmarterArchives/agent-evidence/freezeouts-20261028-01a180cc. Source submission, installation and publication are recorded separately there.
