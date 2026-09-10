# tests/one-refused-bust-does-not-freeze-an-event.law.test.ts

A bust the knockout door will not accept may cost that player their place for a
few seconds; it may never cost the event. The assignment pass still aborts on
the first two refusals of the same player - a CAS miss or an evidence defer
clears itself and hand order is worth keeping - but a player refused
BUST_REFUSAL_SKIP_AFTER times running is passed over, said out loud
(`Tournament.bust_blocked_player_skipped`), and the rest of the field is
recorded, because the finishing places are re-derived from bust chronology
before the event pays. And a player id is validated as a UUID, never as a UUID
of a particular version: the version-checked pattern refused 95 of 1,198
accounts - 62 horses and 33 humans - as `invalid_claimants` and froze every
bounty event they played in (10.5: horses are players).

And a manager's scheduler entry is bound to the lifecycle it was registered
under, so a re-registration REPLACES the old one rather than being ignored:
resume() begins a new epoch without always passing the stop fence, and an entry
left on the dead epoch is skipped or dispatched into a run that returns at its
first line - for ever, with nothing logged, while the blind clock ticks on.
