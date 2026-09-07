# The Table Social Channel Has One Lifecycle

Overlapping connect calls could each create a Supabase channel. Disconnect kept
its channel reference while awaiting removal, allowing a late SUBSCRIBED callback
to mark it connected again and track presence. A rejected presence track escaped
the async status callback and left connect unresolved.

Connection attempts now share one promise and reuse an already connected channel.
Status callbacks belong to their captured channel. Disconnect revokes ownership
and settles a pending subscription before waiting for removal. Presence errors are
reported without stranding a working channel. Error/timeout/closed statuses clear
connection state and use the existing single retry timer.

Regression tests reproduced all three defects before the change. The table's
chat/presence transport remains separate from authoritative engine game state;
no extra socket, polling loop or game-action replay was introduced.
