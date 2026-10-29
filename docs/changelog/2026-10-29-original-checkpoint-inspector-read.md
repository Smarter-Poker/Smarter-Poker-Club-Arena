# Read the original checkpoint inspector without changing it

The existing exact-run release recovery observer now accepts
`legacy_checkpoint_inspector`. It binds the one-shot intent and both durable
request records to the selected candidate/control, original EED container,
start/PID, immutable image and unchanged healthy instance. Fixed loopback HTTP
is read before any WebSocket. A closed listener proves only current absence;
it does not invent native memory or certify release readiness.

For an open listener, one exact original debugger line within the intent's
10-second interval must hash to the current endpoint, and no established
inspector clients may exist. Only then does one owned client read PID 1's
native V8 heap scalars and available process memory. It disconnects only itself.
No signal, inspector shutdown, GC, heap/object census, application calls, release,
DB or seating changes are performed. Missing historical ownership, identity
changes, malformed/oversized output and deadlines stay unknown/refused. Private
endpoint/log/container/PID data never crosses the output protocol.

The scalar predicate matches the qualified 32 MiB reserve and 8x process
headroom calculation; satisfying it is explicitly not readiness certification.
The existing pinned Actions observer remains the only delivery/read route.
Native scalar and exact-file/ownership/refusal fixtures cover this mode;
production access and publication are intentionally left to the owning task.

A terminal failed release retires both request records. When and only when
both are absent, the immutable private failed-result receipt supplies the
original candidate/control binding. Its recovered desired source and image
must match the still-running original engine; invocation, positive exit status
and completion time must be valid. Partial request retirement, missing or
changed receipts and every identity mismatch refuse. The failure attestation
CLI is never invoked, since it can write audit state.
