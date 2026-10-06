# tests/a-chip-request-tells-its-approver.law.test.ts

Launch audit, 2026-10-05. A member's chip request wrote its `chip_requests` row
and told nobody; the approver (the member's agent, or the club owner) learned
of it only by opening the cashier. Migration 20261006022835 rewrites
`fn_request_chips_core_20261004` from its installed definition so the approver
is sent one notification in the same transaction, after the insert and after
the replay return, so a retry never notifies twice. The law pins that the
migration notifies through `fn_raise_notification`, skips a self-request,
refuses a definition it was not written against, asserts its own effect, and
that no later migration redefines the function without the notification.
