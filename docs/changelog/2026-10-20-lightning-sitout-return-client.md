# Lightning Sit Out Keeps Its Return Control

The idle pool snapshot intentionally has no physical hand seat. TablePage's
hero-seat-only sit-out expression and earlier spectator footer hid I'm Back
while the owner's actual anchor chair was paused. The Sit Out notice offers
Leave Table; the existing footer owns return.

TablePage now accepts the existing successful sit-out/sit-back HTTP result for
its exact current pool and account, including settings and multi-table labels.
The existing footer wins over spectator/reserved branches for that paused owner.
An authenticated own-session lookup resolves the actual anchor chair and reads
its exact table/user/seat/occupancy and persisted server timestamp at initial
connection and reconnect. It refuses replaced pools, exited chairs and pending
leaves. Generation and identity fencing prevents an old read or action result
from changing a replacement room/account, or a read overwriting a newer ACK.
No hand seats, stacks, timers or financial state are fabricated.
Settings shares the same in-flight request guard as the menu/footer, preserving
refusal rollback and refusing stale room/account completions.

The legacy physical-table seat poll/subscription remains for ordinary tables
and is disabled for Lightning pool IDs. No new poll, subscription, socket,
retry, funding action or engine API is introduced. Existing freeze, one-hand,
formation and financial guards stay authoritative. The accepted action result
supplies immediate local presentation; bootstrap/reconnect reads are recovery.
The named persisted `lightning_sitout_changed` event on the existing pool
socket renders the persisted transition directly for cross-device changes.
Only matching pool/player events with a UUID occupancy and valid persisted
timestamp are accepted; older bootstrap reads cannot overwrite that event. Its containing server follow-up remains a live
verification prerequisite. Successful action ACKs remain immediately usable. A persisted event newer than
the request wins over its delayed HTTP ACK, including another device returning
the owner; the settings intent and notice follow the persisted transition.

Verification: focused regressions cover exact own-anchor lookup, replaced
identity/invalid timestamp/pending exit, initial idle/reconnect state, stale
read and ACK fencing, failure reporting, immediate resume and actual footer
wiring. Existing ordinary sit-out clock/switch/return/seat-tag checks pass.
Protected checks, static publication and actual paused-return/funding witness
remain required; this document claims no live completion or rollout approval.
