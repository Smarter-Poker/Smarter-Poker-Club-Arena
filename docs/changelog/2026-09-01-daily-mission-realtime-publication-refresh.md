# Daily Mission Realtime Publication Refresh

Production had the expected Daily Missions revision table, private read policy,
three revision triggers, full replica identity, and publication catalog row.
New authenticated subscribers still joined without receiving any revision
change. The release refreshes that one table's publication membership so the
Realtime tenant reloads the relation.

The migration also removes accidental direct browser write grants from the
revision cursor. Authenticated players retain private read access, while
authoritative server triggers remain the only writers.

The production certification creates an isolated reserved player, joins the
filtered Realtime channel, writes a revision through service authority, proves
the browser receives the change, and hard-deletes the fixture afterward.

Before the refresh, the Postgres Changes slot was roughly 323 MB behind and a
fresh authenticated subscriber received no database events. The managed worker
reconnected after the publication refresh, reduced the lag to roughly 1.6 MB,
and the same isolated probe received the expected revision `UPDATE` frame.
