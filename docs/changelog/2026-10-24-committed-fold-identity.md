# Player Identity After A Confirmed Fold

Dan 2026-10-24: "PLAYERS AND AVATARS MUST DISAPPEAR WHEN THEY FOLD", and "IF THEY HIT THE FOLD BUTTON, DON'T REMOVE THEM UNTIL ITS THERE TURN TO FOLD".

Folded players kept their avatar and name plate on the felt. The seat now hides that identity after the engine confirms the fold in the current hand and the existing fold motion finishes. A selected pre-action, an optimistic request, a rejected action, or a snapshot from another hand or table cannot hide the player.

Since #7896 a Lightning fold is committed in the hand the moment it is pressed, even while another seat owes the decision, and the shared snapshot marks the seat folded at once. The table therefore remembers who was acting when each fold appeared (`nextFoldReveal`): a fold on the player's own turn shows at once; one made out of turn stays visible until the turn moves past that seat, the street changes or the hand ends. A viewer arriving mid-hand shows folds already made.

A player who leaves mid-hand is folded by the engine, so the same rule clears their identity; the seat itself is vacated by the engine's state broadcast when the hand ends.

Presentation only. The occupied seat, private muck view, committed wagers, chip collection and settlement retain their existing owners. The next hand restores the identity. The same seat renderer covers players and spectators across table formats. Carried from the closed #7887 onto current main without its superseded entry-page work.
