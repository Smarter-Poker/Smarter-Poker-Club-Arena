# Lightning room Sit Out and return

The table controls sent the Lightning pool-session room ID to `/sitout`,
which looked up only physical engines and returned 404. Resolve an open room
through the existing authenticated player-to-anchor lookup before calling
the anchor engine's normal Sit Out or Sit Back implementation.

The original cash one-hand gate, occupancy persistence, clock behavior and
matcher eligibility remain authoritative. A sitting-out anchor is already
excluded by Lightning legality; this adds no pool state, RPC or periodic job.

Focused handler regressions reproduce both direction failures before the fix
and cover the physical route, engine refusal, unavailable engine, unauthenticated
caller and denied room resolution. Production proof must observe the persisted
seat flag and future matching, because the existing seat persistence is asynchronous.
