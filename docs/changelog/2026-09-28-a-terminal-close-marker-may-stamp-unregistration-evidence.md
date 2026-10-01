# A terminal close marker may stamp unregistration evidence (2026-09-28)

## What was frozen

c7f21a83 "Sunday Funday Six-Card Closer" has been decided since 01:10 UTC
(15c38b11 holds all 120,000 chips; three players eliminated). Its winner was
never paid. The engine's finish attempt was refused at 16:23:19 UTC:

    [Tournament.atomic_finish_refused] TerminalSettlementRefusedError:
      committed tournament unregistration rake evidence is immutable

## The line that refused

A rolled-back probe of `fn_complete_tournament_terminal` (one psql DO block
ending in RAISE, 16:41 UTC) named it:

- `fn_complete_tournament_terminal_pre_seat_guard` line 811 sets the event
  `COMPLETED`;
- the AFTER trigger `fn_stamp_tournament_terminal_evidence_markers` stamps
  `terminal_closed_at` on every `rake_records` row of the event (and raises if
  any row stays unstamped);
- the BEFORE trigger `fn_ca_unregistration_rake_evidence_is_immutable` refuses
  EVERY update of a rake row named by a `tournament_unregistration_receipts`
  row, the close marker included.

The event carries one such receipt: the owner-directed release of a
never-seated satellite entry (migration 20260926054204) named fee source
`1ad31e6e` (5.00) and reversal `860694cf` (-5.00). So the two rules together
meant any event with a committed unregistration fee reversal could never
complete or cancel.

Everything before line 811 (places, prizes, escrow) computed without complaint
in the probe.

## The fix

`20260928163959_a_terminal_close_marker_may_stamp_unregistration_rake_eviden.sql`
gives the unregistration guard the same early return every sibling rake guard
already has (`fn_satellite_target_rake_is_immutable` on the very same rows):
an UPDATE is admitted only when `fn_ca_terminal_marker_transition_is_exact`
holds, that is, the marker goes from NULL to the event's own finite
`ended_at`, the event is already COMPLETED/CANCELLED, and every other column is
unchanged. Every other update and every delete is refused with the same
message and SQLSTATE. Same owner, ACL, SECURITY DEFINER and search_path;
pre-image and post-image are asserted by md5 inside the one transaction; the
trigger is untouched.

No money moves in the migration. After it is installed the engine's own next
finish attempt (refusal back-off capped at 15 minutes) settles c7f21a83
through `fn_complete_tournament_terminal`, whose stored terminal receipt makes
the payment happen exactly once.

## Pinned

`tests/a-terminal-close-marker-may-stamp-unregistration-evidence.law.test.ts`
(`docs/laws.d/a-terminal-close-marker-may-stamp-unregistration-evidence.md`).

## Not proven before merge

A probe cannot carry DDL (CLAUDE.md section 2 rule 3), so the full terminal
door with the new guard body is exercised only after the migration is
installed: a second rolled-back probe of the same door, then the engine's own
settlement, are the evidence.
