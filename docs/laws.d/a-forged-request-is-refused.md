# tests/a-forged-request-is-refused.law.test.ts

A forged request is refused by name at every Diamond door (Diamond Phase 11,
line 1). Every Diamond staff door asks for platform staff and then for a live
session, and refuses a signed-out token, a token without a session id and an
expired session by name (`diamond_staff_session_required`, or
`authentication_required` at the incident desk): four doors learned it from
migration 20260930120000, ten from 20260930131500 the same morning and five
had it since Phase 10, and the law holds all nineteen to it. The Diamond Arena is never a club-games host
(`fn_wheel_host` finds no host for a Diamond club), and another host's club
games are operated and read by platform staff only, never by whoever owns some
club, some union or receives incident pages (`fn_wheel_can_operate`). Every
change is an asserted substitution against a pinned live text; nothing is
granted, no switch opens and no Diamond moves. The attack matrix that proves
each door's refusal is `docs/evidence/diamond-phase-11/request-forgery-and-access.md`.
