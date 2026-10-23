# MTT ranks follow committed hands across all tables

The HUD refreshed its field only for eliminations and lifecycle changes. The
stats panel polled independently every ten seconds. The lobby's Postgres Changes
subscription could not receive chips: tournament_players is intentionally absent
from the publication because of its write volume.

After the exact hand settlement is proved, the current table owner announces
standings_changed on the existing authenticated tournament channel. A shared
client subscription coalesces events for 100ms, invalidates the table HUD, stats
panel and both lobby entry owners, and catches up on connection and visibility
recovery. Reads remain serialized and retired owners cannot paint late answers.
The event discloses only table ID and hand number. Transport failures cannot
change an accepted settlement into a failed hand. No financial writer or database
publication changes, new poller or scheduled repair are introduced.

All these surfaces use competition chip ranks: tied stacks share 1,1,3 rather than
mixing row positions with chip ranks. Recorded eliminated places and satellite
qualifications remain separate. Snapshot reads paginate past the former 500/1000
row caps and refuse a partial result if a later page fails. Zero-chip entries
remain zero when the lobby maps a snapshot.

This includes an engine runtime change. Client publication alone cannot certify
the new event; protected engine activation and actual-hand live proof are required.
Validation and release results are recorded in the task's retained checkpoint.
