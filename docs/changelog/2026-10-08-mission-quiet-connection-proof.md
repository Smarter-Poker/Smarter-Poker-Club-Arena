# Daily Missions quiet-connection proof

Production run 37782381046 recorded one permitted revision read while its routed socket count changed from 10 to 11. The test incorrectly described that interval as a healthy unchanged connection. The page already owns one bounded catch-up read per subscription generation; no product polling is added.

The missed-frame certificate now requires a complete uninterrupted 20-second observation before asserting zero cursor reads. A natural replacement starts a new observation, with at most three windows. Stable-socket polling fails immediately, including after reconnect; perpetual connection churn fails rather than becoming a pass. The explicit forced disconnect, degraded/live UI, bounded catch-up read, reward persistence, and fixture cleanup assertions remain.

Local regression cases cover unchanged quiet sockets, the reproduced 10-to-11-style reconnect with one read, polling before/after reconnect, and exhausted observation bounds. Production delivery and final evidence remain in the existing hamburger closeout checkpoint.
