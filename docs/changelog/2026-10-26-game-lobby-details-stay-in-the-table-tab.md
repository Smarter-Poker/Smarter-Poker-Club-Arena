# Game Lobby Details Stay In The Table Tab

The selected tournament card used React Router directly for Details and Return To Tournament, bypassing the embedded lobby navigation context. Those button clicks have no anchor for the parent click-capture to intercept, so they left the table route and depended on the route recovery backstop to restore the action bar.

GameLobbyPanel now uses the existing useAppNavigate hook. Inside the table lobby the same tournament id and club query go directly to its in-tab renderer. Standalone navigation and the container-declines fallback remain ordinary routes. Game selection, entry authorization, registration, spending and artwork are unchanged.

Six mounted tests exercise the real panel and card buttons through the portal: both tournament actions inside and outside the context, the declined-target fallback, and ordinary cash-table navigation. The three context expectations fail before the repair and all six pass afterward. The existing action-bar law now includes the selected-game panel in its surface inventory.
