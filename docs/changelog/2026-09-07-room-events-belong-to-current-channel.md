# Room Events Belong To The Current Channel

Replacing a table channel updated outgoing broadcasts but left its old inbound
callbacks active. Delayed chat, join, leave and presence sync callbacks could
reach current consumers or overwrite current presence. Leaving a room could also
be followed by a stale callback repopulating the cleared presence cache.

All four inbound callbacks now check that their captured channel is still the
registered owner before reading presence or delivering a message. Same-channel
registration remains idempotent; current-channel delivery is preserved.

Two behavioral regressions failed before the fix. The tests also cover delivery
from the replacement and duplicate registration. No extra connection is created.
