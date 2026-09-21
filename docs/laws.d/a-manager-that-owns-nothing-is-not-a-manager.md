# tests/a-manager-that-owns-nothing-is-not-a-manager.law.test.ts

Six RUNNING tournaments - 49 live seats, 4,908,000 tournament chips, the oldest
stranded since 2026-09-14 - held no lease and were not being dealt, in a process
that had been up 58 hours and reported a completely clean board. Each was held
by a manager that had lost its lease and could not be stopped;
`stopOwnedTournamentManager` keeps such a manager as the owner on purpose ("Keep
it quarantined for the next cleanup pass") and there was no next cleanup pass,
so `discoverRunningResumes` - which asks `tournamentEngines.has(id)` and skips
anything that answers yes - skipped all six for a week while /health showed
tournamentResumesFailing 0 and a full budget. This law pins the quarantine as a
named state with an age, a reason, a number and a retry: the slot is still never
released while its table engines may be live, but a stop that failed (including
one that THREW, which is how all six were stranded) is recorded and re-offered
on a backoff, a RUNNING tournament nobody is dealing is a published gauge with a
break-guarded alert, and a drained-custody read reports which of the three
outcomes it got instead of one opaque token that fired 1,551 times in ninety
minutes and told nobody anything.
