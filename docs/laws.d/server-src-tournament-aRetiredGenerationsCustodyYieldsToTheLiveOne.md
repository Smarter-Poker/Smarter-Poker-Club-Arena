# server/src/tournament/aRetiredGenerationsCustodyYieldsToTheLiveOne.law.test.ts

A Retired Generation's Retirement Reservation Yields To The Live One: on
2026-09-29 from 01:15Z the $100 Freeroll 6:00 PM (cb8f2dd1, 171 players) dealt
nothing because lease generation 83b3ec21 lost its lease while break e487977d
(table b6af1747) awaited seats, and the process-local reservation it kept for
its own replay refused every successor's resume with
`f06_retirement_custody_held`, forever (87a68e55, 6a18ddaa, 1f918c8c and
4ed38a9f in the same loop). With the real TournamentManager and GameServer
this pins that the live manager reads each such break under its own lease
(`fn_f06_break_state`) before resume builds any dealer, and the reservation is
yielded only when that receipt names the same break, table and lifecycle and
nothing of the old generation (registered, stopping or quarantined manager,
unconfirmed lease release, drained or mixed transfer, registered engine)
remains; every other case keeps refusing admission.
