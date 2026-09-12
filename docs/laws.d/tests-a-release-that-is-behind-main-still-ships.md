# tests/a-release-that-is-behind-main-still-ships.law.test.ts

The engine release path required, in four places, that the target BE the newest
commit touching `server/**` on protected main. A release waits in a FIFO and then
waits again on the box for its `:55` break window, up to fifty minutes,
re-checking that as it waits; at about nineteen merges an hour the answer is
almost never still yes. Measured 2026-09-12: the engine ran `d68cc549` for four
and a half hours while eight consecutive release transactions built their image,
waited, and died on this check, one of them carrying the fix for a live fault
that was killing every cash table every twenty seconds. The gate was refusing the
remedy for the outage it sat on top of.

Every deploy is behind main the instant it lands, so being behind cannot be what
makes one unsafe. Two properties are what matter and both are kept: CONTAINMENT,
the target is an ancestor of protected main, which catches a rewind or a build
off other history and is still a hard failure in all four places; and NO
REVERSAL, the engine never moves backwards, now proved on the box against the
runtime it has sealed, which also serialises two racing releases. Identity was a
blunt approximation of NO REVERSAL made where the sealed runtime is not knowable;
it is replaced by NO REVERSAL itself, asserted where the answer is known.

The law pins that the swap happened and has not quietly reverted: containment
still exits non-zero, the sealed-runtime ancestry proof exists, and no high-water
identity comparison is a hard failure again.
