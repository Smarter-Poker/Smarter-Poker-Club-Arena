# The weekly scheduler alarms close when their condition ends (2026-10-17)

`fn_process_weekly_accounting_scope` raises two `union_accounting_scheduler`
alarms, and until now nothing closed either one:

- "A weekly accounting scope did not finish its scheduler visit": 41 were
  open on 2026-10-17 for the Midway union and club 2a1132b9. The latest visit
  to both scopes had already finished.
- "Weekly union accounting is incomplete": 7 were open for the Midway week of
  2026-10-05. That week is still running and the alarms are true.

`20261017132354` closes each alarm at the place its condition ends:

- where a visit's outcome is recorded, a finished visit closes that scope's
  unfinished-visit alarms;
- where a union week is recorded complete, that week's incomplete-week
  alarms close.

An alarm whose condition still holds is not touched. This adds no sweep and
changes no money, run, receipt or certificate. It applies to the live body,
the postimage of `20261017121500` (`6bd020f0` -> `7065a449`).

Verified on native PG16: the migration runs twice cleanly and the readback
and ACL are exact. With five fixture alarms, only the finished scope's visit
alarm and the completed week's alarm close; the other scope, a later week and
an unrelated seal alarm stay open.
