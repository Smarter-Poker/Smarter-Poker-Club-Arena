# Tournament standings keep their place while entrants bust

The shared standings reader used offset pages over an active-player filter. When an earlier entrant busted between requests, later rows shifted left and the next offset skipped a still-active player. The HUD could omit that player from rank, remaining count and average-stack calculations.

The reader now continues after the last stable player-row id and reads until a short page. HUD and info-panel projections now include that id; the two other consumers already did. Unreadable pages and invalid/nonadvancing cursors return failure instead of partial standings. The first page's exact field count is retained: a cursor-filtered suffix count is not a whole-field count. No visual artwork, event subscriptions, or game authority changes.

A request-level regression failed before the change when row1 left a1,001-player active field between pages. The corrected reader retains the still-active last entrant. Boundaries0/1,000/1,501/9,001, later-page failure, and missing-cursor refusal are covered. The connected tests render the real HUD and info panel; their query fixture was updated for keyset builder methods without removing behavior assertions. Pages still use separate database snapshots, so this does not claim an atomic field snapshot during concurrent play.

This is a client data-read change using the existing database API. No new engine behavior is required. Real-time law: triggered by existing standings_changed and tournament lifecycle events, no snapshot diff. Required hosted checks, static publication, both build identities and affected runtime proof remain pending until verified.
