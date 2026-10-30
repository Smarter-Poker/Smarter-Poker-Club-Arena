# Channel admission preserves existing tabs

A live channel socket was closed with code 1001 and reason `too many connections for this user`. ChannelHub evicted the oldest socket above eight while ChannelWebSocketServer admitted up to the existing ten-socket limit. The ninth tab therefore displaced an established tab before transport admission could refuse an excess arrival, causing reconnect churn and repeated authorized member reads.

ChannelWebSocketServer is the only production caller of ChannelHub.addConnection. Remove the hub's conflicting oldest-socket eviction and retain the existing transport admission limit unchanged: ten admitted sockets coexist; the eleventh arrival receives 4429 without disturbing existing connections. Per-socket teardown and final-socket subscription cleanup remain intact.

Regressions fail on the previous source for nine/ten hub sockets and the actual transport admission method. Focused tests cover survivor delivery, lobby/tournament subscription preservation, duplicate late close, replacement admission and refusal of the eleventh socket. This is an engine runtime change requiring the approved protected release and daily maintenance activation; source merge or local checks alone do not prove live recovery. No restart, deployment, migration, client retry suppression or cap increase is performed by this change.
