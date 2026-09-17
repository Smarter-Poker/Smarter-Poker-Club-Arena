# Alert qualification: PR snapshots and reversible receipt cohorts

PR4778 was repeatedly blocked after successful client compilation because the
provenance stamper compared its immutable pull-request merge to main as observed
when a queued worker started. Five retained failures across runs35267982040,
35269804642 and35271777471 show the same cause. The earlier comparable
build/browser jobs in35263522609 passed when main had not advanced.

The stamper now verifies a pull_request event against the exact checked-out
GITHUB_SHA, its two ordered base/head parents, repository, PR ref, main base,
complete and readable ancestry, and the observed main's descent from that base.
Only that temporary test snapshot can continue after main advances. Actual
behindMain/aheadMain values remain unchanged. Malformed or mismatched context
fails closed, and explicit strict publication retains the original refusal.
Push, manual, repository and pull_request_target events receive no exception.
The classifier now sends changes to the stamper through the existing build,
browser and client checks. No workflow, protection or publisher is changed.

Real Git subprocess regression cases retain the old strict/local/shallow
behavior and exercise current and advanced-main PR snapshots, missing objects,
wrong event/ref/repository/parents and explicit strict publication. The tests
execute the publisher's existing admission expression against actual stamped
artifacts: both PR variants are refused, and an exact clean main build passes.
A standalone before/after reproduction observes old exit1, corrected exit0,
strict-release exit1 on the same unchanged merge with real distance1behind/2ahead.
Snapshot validation does not certify integration with later main commits.

A connected review of the current tournament terminal found a separate defect:
the receipt installer could accept a terminal/places cohort that its matching
reverse refused. Forward admission now requires the same two complete original
function definitions as its unchanged reverse. The existing native catalog
qualifier reproduces the original install/reverse mismatch using an independently
pinned original installer and tests four missing/changed prerequisite refusals.
All controls must restore the original catalog and business state. Actual
observed results, including the before reproduction, are required by the existing
wrapper. Runtime financial bodies and the reverse component are unchanged.

The local source/wrapper tests, typecheck and client build have been executed;
final required hosted checks remain separate. The SQL qualifier requires its
existing non-root Linux PostgreSQL17 environment. These source changes do not
install the financial packet, recover the415 missing original histories, repair
the entire oldest incident, or connect external events to this desktop chat.
The newly observed finish-lane terminal is deliberately refused until the
current financial contract has its own exact qualification. No new schedule,
repair loop, service, synthetic history or production mutation is introduced.
