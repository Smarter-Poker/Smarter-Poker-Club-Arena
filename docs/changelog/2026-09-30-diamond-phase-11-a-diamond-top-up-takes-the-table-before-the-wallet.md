# 2026-09-30: the arena knows its limits (Diamond Phase 11 line 5)

Phase 11 line 5 asks for lobby fan-out, action latency, event-loop load,
database locks and reconnect storms to be measured, and the phase exit asks
for a measured operating envelope. The envelope, with every raw number, the
commands and the machines, is in
[docs/evidence/diamond-phase-11/operating-envelope.md](../evidence/diamond-phase-11/operating-envelope.md).
Production was only read (the engine's /health and /ws-metrics every 20 and 60
seconds for 81 minutes across the busy :35 to :53 stretch and an engine
restart in the hourly break, Prometheus through the estate's monitoring reader, pg_stat_activity,
pg_locks and pg_stat_statements); everything that needed load ran in
isolation. Measuring found four defects, all fixed here (PR #5651).

## A lobby join answered everyone

Every page holds the lobby channel (the maintenance banner) and every
reconnect replays JOIN_LOBBY. The engine answered each join with a lobby
update to every lobby subscriber, so N clients arriving together - which is
what happens after every engine restart - cost N(N+1)/2 messages on the main
realtime loop. Measured on the engine's real transport: a 2,000-client
reconnect storm sent 2,002,467 messages, took 12.4 s of main-loop CPU, and
needed 16.5 s and 650 failed connects before everyone was back. A lobby join
now answers the joiner only (nobody else learns anything from it: it changes
no club's online count, and the 30-second interval still refreshes everyone).
The same storm now sends 2,000 messages, takes 0.8 s of CPU, and everyone is
back in 0.45 s. ChannelHub also serialized every fan-out once per recipient -
the defect TableStateHub fixed as C16 and ChannelHub never received - so every
lobby, club and tournament fan-out, and every presence join and leave, now
serializes once. Pinned by
`server/src/transport/aLobbyJoinAnswersOnlyTheJoiner.law.test.ts`.

## A Diamond top-up took the wallet before the table

The hand settler, the buy-in and the cash-out all lock the table row and then
the player's wallet row. The top-up locked the wallet and then the table,
under a comment claiming it matched the settler. On an isolated PostgreSQL 17
with the live doors (`scripts/qualification/diamond-lock-waits.py`), hands
settling while the players seated at them top up deadlocked on every run; with
the table taken first, never. Migration
`20260930130000_a_diamond_top_up_takes_the_table_before_the_wallet` takes the
table row first - one lock, bare, so every refusal and replay answers as it
did - rehearsed, applied and recorded. Pinned by
`tests/a-diamond-top-up-takes-the-table-before-the-wallet.law.test.ts`.

## A top-up raced the settlement of the hand it followed

The engine clears a hand's controller when the hand ends, but the settlement
commits afterwards. A top-up asked for in that window went straight to the
database, into the race above - and a top-up that won it left the settler an
opening stack that no longer matched the seat, which the settler refuses.
Until the settlement lands, a Diamond top-up is now an intent exactly as mid
hand, applied after the settlement and before the next deal
(`ServerTableEngineSeating`, two cases in `DiamondCashBoundary.test.ts`).

## The deadlock counter counted every engine restart

`poker_db_deadlocks_total` mirrors `pg_stat_database.deadlocks`, which an
engine restart does not reset, but the engine published 0 until its first read
of it. Prometheus takes a counter that goes down for a reset, so after every
restart `increase()` counted the database's whole total again: 3,577 real
deadlocks in a day read as 17,797, a worst ten minutes of 123 read as 5,424,
and the critical `DatabaseDeadlocksElevated` fired on a restart alone twice in
the day. The counter now has no sample until its first read, so a restart
is a gap rather than a spike (one new case in
`server/src/services/theFleetReportsWhatItCannotFinish.law.test.ts`).
