# Checkpoint refusals retain their native evidence

The checkpoint transport received the guard's reason, stage and progress counts,
then discarded them when returning `native checkpoint did not qualify`. This
prevented the release owner from distinguishing the failed prerequisite in run
`35415689014` without another runtime investigation.

The existing transport now includes the validated scalar summary under
`checkpoint`. A native refusal code becomes the top-level reason when cleanup
succeeds. If cleanup fails, its refusal remains the primary reason and the
original checkpoint observation stays attached. Unknown responses and raw
exceptions keep their existing static transport messages; no retry is allowed.
Summary fields accept only the defined schema/stages/outcomes, bounded refusal
codes, proper booleans and nonnegative numeric progress. Unknown fields, private
payloads, card arrays, credentials and malformed summary values are excluded.

The existing isolated transport suite reproduces failure on the old source and
passes with native refusal, failed cleanup and malformed-value cases added.
Those cases use the existing disposable child process and real inspector
transport, verify only one guard invocation, prove the same target remains alive,
and close its port normally. No application runtime or production inspector was
attached. Runtime qualification, database evidence and release ownership remain
unchanged; this change does not infer the historical failed guard's actual reason.
