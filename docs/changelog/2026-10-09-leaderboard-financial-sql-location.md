# Leaderboard Financial Qualification Failure Location

Actual baseline payout run 37897427721 failed before a usable financial case receipt. Its private output was deliberately destroyed during owning cleanup, and the existing complete-case diagnostic could only report UNKNOWN. No payout or financial qualification passed.

The existing baseline client now selects psql SQLSTATE-only verbosity and stdin file execution. The bounded diagnostic admits only one exact stdin line number and five-character SQLSTATE when no case verdict exists. It emits unavailable verdicts and retains the original failing exit and cleanup; arbitrary messages, paths, SQL, identifiers and private values remain excluded. Full case receipts still require every exact case.

Focused diagnostic and generated-shell regression coverage verifies privacy, malformed/duplicate/partial refusal and unchanged failure propagation. Actual changed hosted diagnosis remains required. Frozen financial SQL, candidate postimage, authorization fixture and production behavior are unchanged.
