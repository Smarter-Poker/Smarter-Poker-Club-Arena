# Join Lightning From The Lobby Is Checked Live

Dan: "JOIN LIGHTNING GAMES STILL SILENTLY FAILS FROM THE GAME LOBBY". #7879 fixed the cause (a lobby query-string effect overwrote the Lightning route a tap had just opened) and proved it with a mounted unit test on synthetic reads. Nothing proved it on the deployed site.

`tests/e2e/production-lightning-lobby-join.spec.ts` now runs in post-deploy Client browser verification, in the same authenticated step and release bracket as the Lightning operator certificate. At 393px and 1440px it opens the member club's real lobby, taps a real Join Lightning, requires the Lightning route to hold for three seconds, and requires the approved cash-game card (#7890) with table-style stakes and no waiting-list or retired copy. It never presses the card's Join and fails if any admission or buy-in RPC is sent.
