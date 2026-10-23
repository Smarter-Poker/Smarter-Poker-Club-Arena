# Lobby Dialog Clearance And Club Options Verification

The live Diamond Arena checks found the game-details Close button underneath the global header. The details panel was inside the isolated route stacking context, so its own modal z-index could not place it above shared chrome. Render the existing panel in the body-level modal layer, preserving its controls, artwork, focus management and scroll lock.

The Club Operations navigation check measured Poker Arena Actions while its native Club Options disclosure was closed for returning members. Open that disclosure before requiring visible controls and checking separation from the active club card; retain the ordinary card click and resulting route assertion.

The two mobile compact-row/filter checks already pass against the maintained compact-row UI. Preserve those checks. The local game-details fixture exercises the actual isolated route and header/footer stacking with ordinary Close, Escape and Back To All Games interactions, so header interception is reproduced before the repair.
