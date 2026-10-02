# Read existing anonymous subscription phases for an explicit incident

The bounded manual engine-log reader previously retained only selected tournament failures. Initial connection investigations could not recover the serving engine's existing anonymous subscription phase measurements. An explicit `mux_subscription_timing: true` now includes up to 50 validated timing records from the same completed fifteen-minute incident window.

The fixed host, container, log command, transport pin, byte/time limits and before/after identity checks are unchanged. Extra fields, secrets, malformed/nonfinite/out-of-range values and invalid requests are rejected. These anonymous records cannot identify a table or user; enqueue timings do not establish browser receipt, and missing records remain unknown. No engine logging, production state, release authority or scheduled behavior changes.

Regression protection runs through the existing scoped runtime reader test: native process capture, strict redaction and truncation, real remote entry, opt-in transport framing, mismatched response refusal and ephemeral credential cleanup. The three new parser/opt-in cases first failed against the prior reader; the extended native suite now passes.
