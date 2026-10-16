# Lightning Recovery Phase Observation

The finite recovery witness previously discarded snapshot state and could not prove whether its connection drop interrupted idle, reservation or dealing. It now brackets the existing single outage with authenticated own-session and scoped reservation, slot and instance reads, retaining pool and hand identities and actual timing. A nonnull hand ID alone cannot prove dealing. Changed, incomplete, wide or stale observations remain unknown; each missing phase remains unknown independently of transport recovery.

This is manual evidence tooling, with no runtime change, new interruption, automatic retry or phase controller. The reads describe a bounded observation immediately before disconnect, not an atomic phase at the disconnect instant. Nineteen focused helper/recovery tests pass, including the valid query traversal and refusal of false phase claims. Actual private observations remain pending.
