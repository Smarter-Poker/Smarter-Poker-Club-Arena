# A live appearance row outlives an earlier read

A table's account-scoped Realtime channel can reconnect while its authoritative
settings read is still pending. If a newer cross-device appearance row arrives
first, the late read used to repaint its older snapshot over that row and replace
the first-paint cache. The channel still reported live, leaving the second
browser on the previous felt.

The hook now fences each successful read against accepted live changes since
that read began. A newer live patch retains ownership of the paint and cache;
later independent reads remain authoritative. Account and bucket checks, pending
mutation fencing, errors, channel recovery and the original persistence request
remain unchanged. No polling or request replay was added.

The real hook and MasterBus regression reproduces the late-read overwrite before
the fix and passes afterward. The hosted gameplay journey additionally attaches
a fixed safe persistence/paint/Realtime projection when its original assertion
fails, without replacing that error, retrying the write or relaxing its deadline.
Run37572996368 demonstrated successful HTTP followed by a stale second-browser
felt, but its earlier report did not retain enough event evidence to prove which
transport ordering caused that particular failure. Current live proof is still
required separately.
