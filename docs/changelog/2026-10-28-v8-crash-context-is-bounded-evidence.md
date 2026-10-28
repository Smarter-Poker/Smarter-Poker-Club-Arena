# Bounded V8 crash context

The existing read-only tournament inspector now retains up to eight numeric GC context records around each of at most eight V8 fatal signatures per signal. It exports PID and heap used/total before and after a recognized GC line, plus allowlisted native worker/main frame presence. Existing streamed history preserves eight preceding GC lines and a bounded fatal tail; timestamps must be within two seconds.

These are nearby observations, not proof that an interleaved GC line belongs to the failing isolate. Isolate ownership and allocation ownership remain unknown, and heap limit remains null: GC total is not the configured heap limit. No raw lines, addresses, arbitrary errors, cards or user strings are returned. Existing signal counts and fields remain compatible.

This is diagnostic evidence only, not a heap repair. No new host command, workflow input, executor, restart, memory limit or production operation is introduced. Focused tests exercise actual-format GC/native frames, numeric expectations, streamed capture, missing context, malicious/noisy data and bounded output.
