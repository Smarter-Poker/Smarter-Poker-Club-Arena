# The horse history deadline fix goes live off-cycle

Owner order, Dan, 2026-10-25 20:44 Chicago, in this chat: "GO ONTO THE NEXT
PHASE AND MAKE IT LIVE NOW, NOT AT 4AM", on the live verification of the
independent horse reads (#8075).

That verification found about a quarter of each horse's own-history reads
abandoned at the engine's 1,500 ms deadline although the database answered
every one within 1,330 ms. PR #8119 (merge b0fd60ee4) waits 5,000 ms instead.

This adds one bounded entry to `server/release/owner-maintenance-windows.json`
anchored to that exact merge, first in the list so a later release reads it
before an older entry whose commit is already serving. Announced at :53 or :54 Chicago so the pause meets the hourly tournament break; valid 03:15 to 08:50
UTC, spent once the containing engine serves. Every existing safeguard stays:
last-hand notice, hand-boundary drain, database freeze, certificate, rollback
reserve, thaw, and the seal's one window per rolling hour. No migrations.
