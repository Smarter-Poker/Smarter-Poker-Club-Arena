# tests/a-member-can-leave-deep-stack-society.law.test.ts

Launch audit, 2026-10-05. Deep Stack Society's delete guard refuses every
`club_members` DELETE that has not set `app.deep_stack_teardown`, and
`fn_member_leave_to_treasury` never set it, so no member could leave the one
public club and no owner could remove one. Migration 20261006041001 has the
authorized leave door declare for its own single-row delete and restore the
setting straight after; the guard itself is untouched and every other delete
is still refused. The law pins that order, that the guard is not altered, the
migration's own assertions, and that no later migration redefines the door
without the declaration.
