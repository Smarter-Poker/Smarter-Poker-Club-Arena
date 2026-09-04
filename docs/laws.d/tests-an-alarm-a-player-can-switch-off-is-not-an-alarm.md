# tests/an-alarm-a-player-can-switch-off-is-not-an-alarm.law.test.ts

No migration grants an alert-CLEARING routine (resolve/clear/dismiss/silence/acknowledge) to anon or authenticated; `fn_resolve_settled_financial_alerts` is revoked and its revoke is guarded by `to_regprocedure` so a clean rebuild does not fail on a routine it never created; `fn_raise_financial_alert` keeps its grant because raising an alarm is not clearing one
