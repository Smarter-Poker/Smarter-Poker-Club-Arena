# Retired tournament dealers do not expire live managers

A tournament manager renewed every retained dealer, including an original F06
source that had already finished physical teardown. When that retired object's
old proof expired, its refusal fenced the freshly renewed manager and healthy
peer tables. The connected regression reproduces this with a real manager, two
real dealers, a retained F06 permit and actual teardown: the prior implementation
fails the renewal assertion while the six existing deadline checks pass.

`ServerTableEngineBase` now records successful physical teardown separately from
the terminal fence. Its typed retirement predicate verifies exact table,
tournament and generation identity, fresh proposed authority, no current process
owner, no controller and no outstanding owned work. `TournamentManagerBase`
skips extending that retired object's proof only while GameServer still owns the
same object. The original proof and unresolved permit remain unchanged. This
does not authorize dealing, financial disposition, park withdrawal or revival.

Active, draining, unsuccessfully stopped, differently owned and mismatched
dealers still refuse renewal; an expired manager cannot resurrect. Existing
server test discovery enforces the connected tests. No timers, repair loops,
SQL or release safeguards change.

Validation: server and client TypeScript compilers passed. The existing deadline
suite plus connected F06 manager flow passed 64 assertions; the engine lease
deadline suite passed eight more. The preimage failed the new connected case.
Independent review accepted the final runtime predicates and ownership wiring.
Observed production cascades are consistent with this counterexample, but the
first rejecting production dealer was not logged and is not claimed as proven.
Protected merge, canonical engine publication and affected live behavior remain
separate release requirements.
