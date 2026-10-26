# Repair the digest client errors at their callers

Recovered the current compatible heartbeat and shared tournament-channel fixes
from PR8016. A Lightning pool room has socket presence but no table engine,
so none of the three HTTP heartbeat callers addresses it. A heartbeat404
checks the table row at bounded points in the existing heartbeat; a positive
closed verdict stops it, and a connected engine socket releases the verdict.
Unknown or live rows never stop a live player's presence.

The tournament hook no longer unsubscribes the shared MasterBus break channel
under its other holders; TablePage retains the refcounted release it owns.
Dead-channel errors remain visible.

An anchor in Lightning mode also cannot run the ordinary snapshot-triggered
auto top-up. Its actual committed-hand receipt continues through the existing
useLightningAutoTopUp original-intent path, with all custody and idempotency
guards unchanged. The old PR's polling hold is not recovered.

The new boundary contract fails before the gate and passes afterward, alongside
the actual event-driven top-up tests. No engine API or database change.
Real-time law: Lightning top-up stays triggered by hand_history_saved discrete
WS event, no new snapshot funding or polling.
