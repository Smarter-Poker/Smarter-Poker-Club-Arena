# Run choice status clears before the cards

Owner correction October 28: after players choose one, two or three runs, remove the felt strip immediately. The unresolved offer belongs below the pot and above the board and must not hide any cards. This supersedes the October 27 request for a 1500ms outcome confirmation; the additional winning-card read remains unchanged.

The old client displayed accepted/mandatory outcomes for 1500ms and single-run outcomes for5500ms, at58% of the table across exposed player cards. Settled events now close the panel, cancel any queued panel opening, clear the deadline and remove the waiting strip without replacing it. The pending strip is inside the community area, eight pixels above its top edge. Its complete short label fits the available pot-to-board gap. Engine run-count decisions, board reveal, payout and winning-card timing are unchanged.

Regression: execute the actual client event handlers for two/three-run consent and mandatory decisions and single-run choice/decline/timeout, including replay. They fail on the prior outcome banners and pass after immediate removal. The maintained natural multi-run witness now rejects any settled-choice strip and measures the waiting strip against actual pot, board and player-card rectangles; all existing runout, recipient, payout and winning-card assertions remain.

Client-only delivery through protected merge and publish-club-arena.yml; no engine replacement or maintenance prerequisite. Local actual CommunityCards/PotDisplay renders with production CSS/fonts at320,375,393,430,768px verify pot clearance and an8px board gap. Production identity and natural behavior proof remain separate delivery requirements.
