# Tournament displays use the engine's committed blinds

The live midnight freeroll displayed Level 370 with 2,000,000/4,000,000 blinds and a 500,000 ante. Its engine record for that level held 52,500/105,000 with a 105,000 ante. The client fetched the level index but omitted `blind_level_state`, then reused the final row of the original 40-level schedule. Different events with the same schedule could therefore show identical incorrect blinds.

Tournament snapshots now include the engine's committed amounts. The current-level reader accepts them only when their index matches the event's current level and their numeric values satisfy the existing engine bounds. It normalizes both field spellings, retains the event's real index and clock, and does not modify the published ladder. Legacy events without a snapshot can still use an in-range schedule row. An overflow level without valid committed amounts remains unknown instead of displaying the final scheduled amount.

The overview, Blinds tab, HUD, clock and ranking calculations consume that current state. Historical schedule rows remain historical. There is no new blind formula or gameplay, financial, entry-limit or maintenance change.

Regression checks reproduce the wrong overflow values, separate events sharing a schedule, engine-capped in-range values, field aliases, absent/stale/invalid snapshots and the initial/refresh projection. The prior assertion accepting the final schedule row as current overflow blinds is intentionally replaced with an unknown-value assertion; the real level-index assertion and purchase-gate checks remain.
