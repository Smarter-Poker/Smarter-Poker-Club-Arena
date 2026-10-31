# MTT table identity and observation

The felt now prints the persisted tournament table number alongside the event information. Rankings print each seated player's table beside their name and explicitly say Tap To Observe Table. The existing confirmation opens that table in the table workspace while preserving other open tables.

Watch confirmation uses the current realtime entry, including a table move received during the short display-coalescing interval. Closed tables and players without a live assignment do not offer an observe link. Numbers come from the explicit persisted Table suffix, never a buy-in or the position in an array. The final-table name remains truthful when no numbered suffix exists.

Regression coverage includes table-number parsing, every ranked seated row, realtime moves before parent refresh, and closure during confirmation. No engine, schema, admission, payout or wallet change.

Watching a player from Ranking or Entries now carries the tournament/player identity into the observer tab and its reload URL. The explicit watch follows authoritative seat assignments on realtime events and reconnect; ordinary table watching stays on that table. Stop Following removes the intent, elimination ends it, transient unseated states wait for the assignment, and stale reads after stop or later events are ignored. Existing destination tabs are deduplicated, background follows preserve the active tab, and played seats are never replaced. At capacity a played source remains intact and following stops with an explanation. This is the owner's October 30 exception to the no-urgency-switch law, recorded in CLAUDE.md.

Validation: 78 focused tests and 776 related tests passed; compiler and four copy gates passed. Regression coverage includes follow moves, deduplication, background focus, played-seat/cap handling, refresh metadata, reconnect reads, temporary null assignments, terminal exit, query errors, closed destinations, unmount and stale-read rejection. Production games were not moved or created for testing.
