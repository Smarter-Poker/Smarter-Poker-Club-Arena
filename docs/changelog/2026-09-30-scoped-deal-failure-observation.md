# Scoped observation of original deal failures

The manual runtime reader accepted a selected table's later watchdog record,
but omitted the engine's original `deal_error_attempt_1` through
`deal_error_attempt_10` and `too_many_errors_stopping` records. This prevented
the bounded observation of the September 30 table stall from showing its
recorded symbolic refusal.

The reader now accepts those exact call sites only when their header names a
selected table UUID. Its existing symbolic-error sanitizer, record and byte
caps, fixed read-only command, host identity checks and transport permissions
remain unchanged. Other tables, arbitrary call sites and invalid attempt
numbers remain excluded, even if their message mentions a selected UUID.

The existing `tournament_log_window_start` input already selects a completed
15-minute interval within the last 24 hours. The incident can be observed with
`2026-09-30T12:05:00Z`, ending at 12:20 UTC, without increasing log access.

The new native-pipe regression failed against the previous reader (zero of
11 expected records retained). All 16 maintained native reader tests pass
after the change, including redaction, invalid scope, size limits, historical
window admission and the fixed remote command. The existing
`tests/scopedRuntimeErrors.test.ts` invokes this fixture in client CI.

This is a diagnostic delivery correction. It changes no engine runtime or
production state and does not establish or fix the underlying table refusal.
