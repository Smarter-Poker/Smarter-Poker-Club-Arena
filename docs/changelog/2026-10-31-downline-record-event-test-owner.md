# Deliver the downline refresh test event after initialization

The HUD publisher's component shard failed the existing downline committed-event case while the unchanged file passes in isolation. That case dispatched its one-shot mocked event as soon as a downline row painted, before React necessarily completed the resolved-club passive effect that owns authority refresh. The adjacent stale-record test already establishes the same initialization boundary.

The downline case now completes initialization within async `act` before delivering the event. It retains the visible updated-row and unchanged-range assertions and additionally requires exactly one initial read and one event-driven refresh for both detail and downline. No product source, timeout, assertion, publisher or production behavior changes.

Validation: unchanged baseline file passed 35 tests; corrected focused file is validated separately. The retained hosted failure is the reproduction evidence; a deterministic local failure was not reproduced.
