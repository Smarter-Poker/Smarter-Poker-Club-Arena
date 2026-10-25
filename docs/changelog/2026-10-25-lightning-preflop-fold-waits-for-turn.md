# Lightning preflop Fold waits for the player's turn

The off-turn preflop Fold button and keyboard shortcut now arm the existing hand-bound server pre-action instead of releasing the player early. A priced fold executes when the turn reaches the player, then the normal Lightning fold releases the slot for the next hand. A free Check/Fold still checks when free and folds if raised. On-turn Fold, postflop Lightning Fold, explicit Fold & Watch, ordinary cash and tournaments retain their existing paths.

The client records this mode with the exact hand at the gesture, independently of the real price and can-check flag. An effect or retry cannot move that queued fold into a later hand; engine echoes and restored choices do not resend it. The existing engine already supports this queued contract, so no engine or database change is required.

Required accounting qualification exposed a captured random numeric club-ID collision in the isolated admission fixture. Its synthetic club helper now allocates an unused code in the same locked transaction, matching the base fixture. A forced occupied-default regression proves the previous helper fails and the corrected fixture passes; production schema and admission behavior are unchanged.
