# The Recovery Reader Accepts Systemd Native Sequence Metadata

The exact existing-release audit failed at its read step with a generic refusal. Systemd v255's `output_json` unconditionally emits `__SEQNUM` and `__SEQNUM_ID`, including when `--output-fields` selects the four witness fields. The previous seven-field exact profile therefore rejects a legitimate nine-field native record. This is a demonstrated protocol counterexample; the original live refusal's underlying cause remains unconfirmed until the qualified reader observes it.

The same maintained reader admits exactly the original seven fields or those seven plus the complete sequence pair. It validates a positive unsigned 64-bit decimal sequence and a 32-character hexadecimal ID, then discards them. Extra fields, partial pairs, malformed values and every existing invocation/unit/time/literal/sign/size/ambiguity boundary still refuse. Missing journals remain UNKNOWN.

Remote failures now return only a closed, exact-run/full-SHA/read-only refusal envelope with literal allowlisted phase/code. The client verifies the envelope and reports that code; raw exception text, journal data, transport stderr, state paths and credentials never reach logs or artifacts. Unknown remote exceptions retain a generic `evidence_refused` code. A wrong identity or untrusted error response remains a generic transport refusal, never a witness or success.

Native enforcement executes 25 scenarios, including the v255-shaped real handler, sequence boundaries, actual remote failure handling, exact refusal identity and client transport cleanup. Source-only audit tooling; no engine producer, runtime replacement, financial write, second publisher or automatic retry.

Primary producer reference: https://github.com/systemd/systemd/blob/v255/src/shared/logs-show.c#L1010-L1033.
