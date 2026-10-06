# The mission art budget counts each file once (2026-10-04)

`Post-Deploy E2E`, run 37242346969 (the run after #6111 named the counted assets): the Daily Missions cold-load step summed **six** resource entries of one 45,698-byte `daily-missions-casino-v2.webp`, plus the 2,640-byte diamond, to 276,828 bytes against the 180,000-byte budget.

The hero `<img>` mounts in the route fallback, the loading state and the dashboard. Each mount of the same URL can add a resource-timing entry carrying the full `encodedBodySize`, even when the bytes came from the HTTP cache or when routing in the test context had turned that cache off. The art a player actually downloads is about 48 KB.

`tests/e2e/support/dailyMissionArtObservation.ts` now records each art file once, at its largest observed size, and keeps a `requests` count beside it. The budget therefore measures payload, not mounts. The credential-free `tests/e2e/routes/daily-mission-art-observation.spec.ts` pins this: it requests the hero twice, uncached, and expects one entry with `requests: 2`.
