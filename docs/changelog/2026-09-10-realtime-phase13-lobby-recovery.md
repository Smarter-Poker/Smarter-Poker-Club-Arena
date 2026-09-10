# Phase 13: Club Lobby Recovery Ownership

The mounted ClubHomePage rebuilt its channel without retiring its occupancy
interval or jackpot watchers. Two rebuilds produced three occupancy reads per
tick. The replacement channel also reset firstSubscribe and skipped its recovery
read. Busy reads discarded reconnect invalidations, while an old club's finally
could release the current club's read lock.

Each setup now replaces its prior feeds and carries an epoch. Retired callbacks,
queries and UUID resolution cannot update the current lobby or club context.
Subscription history survives channel replacement; duplicate SUBSCRIBED signals
are coalesced. Connection state begins unconfirmed. A busy loader retains one
follow-up read, and its token owns the whole request, including finally.

Eight mounted behavioral regressions failed against baseline
37cd6a1c17b6ef92ba1ffd7c86f36a667e6aabd2 before the repair and passed afterward.
The focused suite passed 71 tests across seven files, including existing card
fidelity, scoped inventory, waterfall and refresh-frequency guards.
TypeScript passed. The production bundle compiled in 15.16 seconds; the local
publication freshness gate correctly refused a base three commits behind main.
Integrated CI34428955104 and publisher34429315574 passed, closing that gate.

This change adds no cron, database migration, engine or deployment mutation.
It preserves the existing visible-tab polling floor and admission rules.
The earlier narrowed publication does not include tables or tournaments; this
repair does not claim those streams deliver events or restore the WAL firehose.
The existing engine lobby broadcast carries presence counts, not full inventory.
PR4085 publication is verified in `docs/audits/2026-09-10-realtime-phase13-release.md`.
Post-release browser control timed out on the check and supported recovery retry.
Natural recovery and physical iPad/PWA acceptance remain open.
Stage-B and engine release coordination belong to their owner.
