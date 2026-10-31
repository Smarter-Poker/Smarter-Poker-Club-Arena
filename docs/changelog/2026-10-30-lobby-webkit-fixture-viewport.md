# Match the lobby fixture to the production mobile viewport

The existing iPhone WebKit lobby cases at 375px and 393px rendered a 980px layout because the isolated HTML fixture omitted the production viewport meta tag. That disabled the mobile media query and put the tournament label into the wrong, narrower desktop layout.

Add the real viewport declaration and require the measured layout width to equal the requested width. Wait for the real controls to mount before awaiting their fonts. Retain the strict label scroll-width, frame size, centered heading, independent cash/tournament controls and satellite filter assertions. No product artwork, fonts, layout, financial behavior or game state changes.

Focused iPhone WebKit reproduction and the same cases after correction supply the before/after evidence. Production certification remains required through the existing publisher.
