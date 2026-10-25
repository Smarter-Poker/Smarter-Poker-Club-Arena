# Game Lobby Closes Above The Announcement Rail

The selected game dialog used a body portal at layer 2100 while the app-root tournament announcement rail used layer 9400. The rail could cover the cash lobby's close button on a phone and intercept its tap. The dialog backdrop now uses the existing 9600 modal layer, preserving its artwork, focus handling, Escape/backdrop dismissal, and the announcement's animation and interactions.

The existing mobile lobby browser fixture now renders the actual announcement rail outside the isolated page stage, positioned below the fixture header as in the application. The real close interaction fails before the layer repair in Chromium and mobile WebKit at 375px. The same maintained cases verify the modal closes, the rail still opens its announcement afterward, and the existing keyboard, focus and return paths continue to work across the cash and tournament variants.
