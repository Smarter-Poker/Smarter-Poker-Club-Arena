# Game Lobby Details Stay In The Table Tab

The selected tournament card used React Router directly for Details and Return To Tournament, bypassing the embedded lobby navigation context. Those button clicks have no anchor for the parent click-capture to intercept, so they left the table route and depended on the route recovery backstop to restore the action bar.

GameLobbyPanel now uses the existing useAppNavigate hook. Inside the table lobby the same tournament id and club query go directly to its in-tab renderer. Standalone navigation and the container-declines fallback remain ordinary routes. Game selection, entry authorization, registration, spending and artwork are unchanged.

Six mounted tests exercise the real panel and card buttons through the portal: both tournament actions inside and outside the context, the declined-target fallback, and ordinary cash-table navigation. The three context expectations fail before the repair and all six pass afterward. The existing action-bar law now includes the selected-game panel in its surface inventory.

The existing production mobile lobby suite also carries a read-only spectator journey through View Table, the + picker, Browse Full Lobby and the tournament card's Details button. It requires the reserved certificate account, refuses participation requests, retains every main-frame navigation during Details and checks that the in-tab details and action bar stay on the original table URL. A route that leaves and is later restored cannot pass. This case keeps the existing 120-second group budget; actual execution and cleanup on the published release remain required production evidence.
