# tests/a-stale-read-never-lands.law.test.ts

An effect that reads for a key (a club, a player, a table) drops the answer
to the previous key rather than letting it land last: useClubRole and
useIsMember cancel on club change, PlayerNotesPanel resets the form before it
reads and refuses to save over a note it could not read, AgentManagementPage
tickets every agents load, RealTimeResultPanel claims its channel ref before
the await its cleanup races, AnimatedCounter cancels its frame, SortableTable
keys rows by record, and StatsFactsService.normaliseRakeStats promises every
field the Rake tab formats so a missing column is a 0 and not a TypeError
that unmounts the tab.
