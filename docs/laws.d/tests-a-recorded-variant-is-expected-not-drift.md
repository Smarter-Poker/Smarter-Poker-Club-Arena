# tests/a-recorded-variant-is-expected-not-drift.law.test.ts

The estate audit must treat a deliberate, reviewed difference in a shared
guard as an expectation rather than a permanent drift, and must do so without
ever expecting "something else". Measured 2026-10-05: issue #3931 had been open
for 27 days, re-raised every four hours, over World Hub's
`.husky/reference-transaction` - a hook the owner had accepted and the audit
already explained in a note that "does NOT suppress the drift finding" - and
the real findings beside it went unread with it (CLAUDE.md 10.83). The law
pins the record to the exact reviewed bytes stored at
`.github/estate-variants/<repo>/<path>`: a copy that matches is noted and
leaves the agreement set; a copy that does not is a STALE finding and goes
straight back into the comparison; the other repos still have to agree with
each other; a stored copy with no reason in `DELIBERATE_VARIANTS`, or for a
repo or path the audit does not compare, is itself a finding; and the live
record is the `AGENT_REF_GUARD_OK` variant Club Arena's own copy must never
carry.
