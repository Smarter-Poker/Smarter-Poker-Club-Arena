# Game Lobby Footer

The fourth Club Arena footer control now opens the current club's canonical running-games lobby instead of the Marketplace. The selected option 3 open club doors and Game Lobby label replace the shopping cart in the operator desktop, operator phone and member masters. Existing artwork URLs remain intact for cached clients; the new lossless masters preserve the frame and neighboring controls.

Club context follows the existing explicit override, route path, query parameter and account-scoped cache resolution. With no known club, the control opens the club chooser. Club root and lobby routes mark Game Lobby current; Marketplace no longer marks a footer control current. The separate Marketplace routes and other entry points remain available.

Validation covers both club URL forms, stale cache precedence, account switching, role-specific doors, intrinsic artwork dimensions, phone touch geometry and query-scoped browser navigation. This is a client-only change using existing routes, without an engine or database contract change.
