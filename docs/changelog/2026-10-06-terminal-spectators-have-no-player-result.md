# Terminal spectators have no player result

A signed-in spectator at a completed tournament legitimately has no tournament_players row. The completion backstop treated that successful absent read as an error, retried three times and kept polling every 30 seconds.

Completion now stops quietly only after a successful absent result and a complete, readable historical-seat lookup for the viewer proving no seats in this tournament. Previously witnessed entrants, historical seats, query errors, RLS-hidden table relationships, truncated history and unknown counts retain result recovery. Spectators receive no invented placement, result card or automatic navigation. Player and satellite qualifier exits remain unchanged.

Validation executes the actual maintained completion caller for spectator absence, known participants, departed seats, unreadable queries and missing counts, alongside the existing winner and qualifier cases. This is a client correction and does not change the engine or certification thresholds.
