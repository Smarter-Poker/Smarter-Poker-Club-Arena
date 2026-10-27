# Phase 8 league forecasts the ante it will actually deal

At level 0 the tournament league advertised a next-level ante of 2 chips even though level 1 deals no ante. Its context and M-state inputs independently used the same incorrect forecast expression.

The league now derives its current and next blinds and ante from one level schedule. The next-level forecast equals the actual next level at the no-ante boundary and at subsequent ante levels. The existing global hand clock, seeds, table sizes, decision policy and qualification gates remain unchanged. The original source-9e qualification artifacts retain their original identity; this correction requires its own future source-bound evidence and does not establish that Phase 8 qualifies or explain all zero-coverage results.

The same producer also declared `anteType: none` at level 1 despite a per-player ante of 4 at level 2. It now follows the canonical producer in `server/src/services/TournamentBrainContext.ts`: per-player when either the current or next ante is positive. Current level-1 orbit cost remains 30; its projected six-player orbit correctly becomes 84 (20 + 40 + 6 × 4), rather than 60. No M-state calculation or schema was changed.

A focused regression fails on the old level-0 forecast (2 versus 0) and passes after the repair, with level 1 and level 2 boundaries retained. No strength trial was run.
