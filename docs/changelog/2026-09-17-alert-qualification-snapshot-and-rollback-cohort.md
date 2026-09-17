# Alert qualification: PR snapshots and reversible receipt cohorts

PR4778 was repeatedly blocked after successful client compilation because the
provenance stamper compared its immutable pull-request merge to main as observed
when a queued worker started. Five retained failures across runs35267982040,
35269804642 and35271777471 show the same cause. The earlier comparable
build/browser jobs in35263522609 passed when main had not advanced.

Protected accounting PR4727 concurrently delivered the fix: only the two PR
builds select ci-validation purpose, and the stamper verifies the Actions
workflow/ref, bounded regular event file, repository/base/head identity,
complete merge ancestry and the current main's descent from the merge parent.
Its validationOnly marker is rejected by both publisher predicates. This
candidate composes that already-protected mechanism instead of retaining a
second implementation. Actual behindMain/aheadMain values remain unchanged.

Two narrow safeguards remain in this candidate: failed ancestry-count commands
cannot qualify an otherwise readable merge, and explicit STRICT_PROVENANCE=1
still refuses stale source even with valid PR context. Existing subprocess
regressions now exercise both boundaries. The existing unit fixture environment
also excludes inherited PR/build-purpose variables. The classifier sends
stamper-only changes through existing build, browser and client checks.
No additional workflow or publisher change is introduced here; all changes
from the protected accounting release are preserved.

The earlier local snapshot proposal reproduced the reported stale-build failure
and passed its focused tests, but that superseded implementation is not the
final delivery. Final validation uses the composed protected mechanism.
Snapshot success does not certify integration with arbitrarily later main.

Normal integration hooks exposed five inherited lint errors in three accounting
tests and FinancialExportContract. The test fixes preserve the actual numeric
inputs, chained calls and regex behavior. CSV text admission now checks the
first character code explicitly for ASCII controls while retaining whitespace,
formula and apostrophe escaping. Existing export tests cover all 32 low control
characters plus DEL, with all 151 tests across the three affected files passing.
No assertion or required hook was disabled.

The same hook reformatted captured weekly-accounting records. Its existing
raw-byte admission check then failed on functions.json, with 69 mismatched
bindings. All 46 captured JSON/fixture-document witnesses are restored exactly
from protected main and explicitly excluded from Prettier. The 24 maintained
test/helper bindings now name their reviewed formatted source; original capture
hashes are preserved. The unchanged admission check passes after this repair,
and the existing 37-component source builder and wrapper binding checks pass.
Source generation is not database execution or accounting activation.

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
