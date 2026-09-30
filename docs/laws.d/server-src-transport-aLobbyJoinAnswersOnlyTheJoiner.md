# server/src/transport/aLobbyJoinAnswersOnlyTheJoiner.law.test.ts

A JOIN_LOBBY is answered to the joiner only (N joins cost N lobby frames, not N(N+1)/2 - measured as the reconnect-storm cost in Diamond Phase 11 line 5), the joiner still gets its immediate update on every tab and the 30 s interval still reaches everyone; every ChannelHub fan-out (lobby, club, tournament, presence join/leave) serializes once and sends the identical frame, skipping closed sockets
