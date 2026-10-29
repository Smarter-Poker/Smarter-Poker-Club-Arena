# Read the original continuation failure category

The existing scoped runtime reader omitted the exact table context used when a private hand continuation fails. Its later watchdog consequence could therefore be observed while the original capture, retention, or event-consumer failure stayed invisible.

The same bounded reader now accepts `hand_continuation_unproven` only for explicitly selected tables. It emits a fixed error category and fixed owner call-site phase, preserving unknown outcomes. It exports no exception text, stack frames, file paths, private cards, deck, or arbitrary payload. A generic write refusal remains unproven and is never relabelled as a timeout or database lock conflict. The existing 20,000-record window, byte bounds, explicit invocation and read-only transport are unchanged.

Three regression cases failed against the previous parser because it omitted the original context. All 52 native parser/process/transport/privacy tests pass with this change. This is diagnostic tooling, not an engine recovery fix or proof of the underlying RPC failure.
