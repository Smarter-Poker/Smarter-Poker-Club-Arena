# tests/a-re-entered-release-refuses-by-name.law.test.ts

An Interrupted Release Reads Its Durable One-Shot Intent Before It Enters The
Legacy Checkpoint Again, Refuses By Name Before Any Break Or Lock, And Names
"Already Entered" As Its Own Exit Code 70 - The O_EXCL Guard Is Never Weakened
And The Intent Is Never Retired To Permit A Retry.
