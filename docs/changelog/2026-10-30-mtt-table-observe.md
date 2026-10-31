# MTT table identity and observation

The felt now prints the persisted tournament table number alongside the event information. Rankings print each seated player's table beside their name and explicitly say Tap To Observe Table. The existing confirmation opens that table in the table workspace while preserving other open tables.

Watch confirmation uses the current realtime entry, including a table move received during the short display-coalescing interval. Closed tables and players without a live assignment do not offer an observe link. Numbers come from the explicit persisted Table suffix, never a buy-in or the position in an array. The final-table name remains truthful when no numbered suffix exists.

Regression coverage includes table-number parsing, every ranked seated row, realtime moves before parent refresh, and closure during confirmation. No engine, schema, admission, payout or wallet change.
