# Find Your Game Heading Follows The Production Cascade

The mobile premium stylesheet still spaced the former title and game total to
opposite sides. It loaded after the family-button stylesheet, so its equally
specific rule kept the new single Find Your Game heading on the left in the
published lobby. The local browser fixture loaded the button stylesheet last
and masked that production override.

The command composition now owns heading centering and spacing, and the mobile
premium rule centers the single title. The family-button stylesheet owns only
its controls. The browser regression loads those stylesheets in the same order
as ClubHomePage's component and stylesheet imports. Before the fix, the corrected
fixture fails heading centering at 375px and 393px; after it, phone and desktop
cases retain the two button interactions while requiring the centered title.

Client CSS and its existing browser regression only. No engine, database,
financial, admission or game-list behavior changes.
