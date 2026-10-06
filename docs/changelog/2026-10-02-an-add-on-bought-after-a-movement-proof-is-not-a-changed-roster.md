# An Add-On Bought After A Movement Proof Is Not A Changed Roster (2026-10-02)

## What Happened

f8c6f298 (11 playing) dealt nothing on table 199a1efc from 04:51 UTC. The
table was the source of park 7ef06537, whose movement proof was taken at
04:57:09 during the add-on break. Player 1c7fc49a then bought the event's
add-on (2,500 chips: seat stack 2,755 to 5,255, add_on false to true). Every
begin and every successor re-admission logged
`F06_MOVEMENT_ROSTER_CHANGED`, so nine players sat frozen.

## Cause

`smarter_private.f06_assert_movement` compares each live seat and registration
with the immutable proof. A legitimate add-on, already recorded on the
registration, made that comparison false for ever.

## Fix

Migration 20261002055945 admits exactly the add-on shape (add_on false to
true, exactly the event's addon_chips more on the seat and the registration,
nothing else different) in the roster comparison, and the same add-on on a
moved member's winner receipt. Everything else refuses as before. The release
contract pins and the shared-hand lane carry the new digests.
