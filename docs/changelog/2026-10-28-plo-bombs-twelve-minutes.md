# PLO bomb pots every twelve minutes

Owner request: PLO bomb pots must run every twelve minutes. Production open
PLO bomb tables used 600 seconds, and the default promised timed_10m.

Change the authoritative PLO template to timed_12m, admit that token through
creation and both table projections, and update open non-retired PLO games
and tables to 720 seconds. Preserve Classic games with bombs disabled,
non-PLO timing, stakes, antes, board counts, and already armed or owed bombs.
Existing engine hand-boundary configuration reads consume this setting
without an engine restart. The existing final hand-count transition remains.

Delivery and verification are recorded in the task checkpoint.
