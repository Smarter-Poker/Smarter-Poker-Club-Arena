# A Late Entry Seated After The Proven Hand Is Movement Evidence (2026-10-02)

## What Happened

4d2afa41 "Morning Free Buy (NLH)" (347 playing) dealt nothing on table
a2953558 from 13:05 UTC with seven players seated. The table's only sealed
hand dealt six players. The seventh, a497dbb8, late-registered while that hand
was running and was seated straight into seat 7, then bought the add-on. Park
be7a4f4f could never take its movement admission: every re-admission logged
`f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED`
and the engine rebuilt the table in a loop.

## Cause

`smarter_private.f06_movement_prior` admitted a seat the last sealed hand did
not deal only through a move receipt into that exact chair. A late entry is
never moved, so it has no move receipt, and the proof refused the whole roster
for as long as the table lived.

## Fix

Migration 20261002134551 admits that seat as an entry only by its own funding
receipt: the player's latest entry (or re-entry) of the event, recorded no
earlier than the chair was taken, whose registration image is playing on
exactly this table and seat number with exactly the chips the entry grants,
with no move since and never dealt on this table since. Receipted purchases
after the entry (the add-on) are credited by the existing purchase loop. Every
other shape refuses as before, and a proof that needs no entry is
byte-identical to before.
