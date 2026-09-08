# Satellite Recovery Requires Readable Evidence

The original stuck-COMPLETING satellite recovery discarded survivor, payout-record and source-seat count errors. Missing or invalid counts could select revival or completion without reliable evidence.

F42 rejects failed, missing, negative, fractional and unsafe counts before the corresponding status decision. The existing per-tournament catch reports the error and leaves the event eligible for a later recovery pass. Confirmed undecided-field and lone-survivor recovery remain intact.

Verification: the actual recovery function failed all 12 new adverse cases on the baseline. After the fix, 14 behavioral cases and 10 existing satellite law tests pass. Server TypeScript passes; the full local suite passes 6,627 tests across 468 files.

This does not certify complete satellite award delivery. The older any-payout-or-seat completion predicate, original-path atomic funding, immutable award evidence and complete recipient recovery remain open. No wallet adjustment, repair sweep, gate bypass or forced restart is included.
