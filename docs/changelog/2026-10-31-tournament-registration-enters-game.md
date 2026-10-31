# Tournament registration enters the assigned game

A fresh tournament seat now opens the game and selects its tab, rather than leaving the entrant in the lobby with a background action tab. Confirmed registration already navigates to its assigned table; the route handler now also consumes same-URL arrivals when an embedded lobby borrows that table URL.

Server seating and registration transactions remain authoritative. Existing duplicate-seat suppression, stale/cash/terminal filtering and table-cap warnings are retained. No engine or database change. Regression coverage exercises fresh arrival, repeated arrival, unrelated seats and the rendered multi-table same-URL flow.

The direct registration and delayed seat-arrival paths share the initial-entry receipt, so observing an already-entered seat cannot pull the player back a second time. Later rebalances and multi-day resumes preserve their existing background/opt-in behavior.
