# Table Header Size And Placement

The action header and Lobby control share a 52px control height on standard phone and wider table views. The previous phone-only correction stopped at 480px and removed vertical padding, leaving the reported wider table view with 36px tabs and a 40px Lobby control. Shared source dimensions place standard controls 16px below the already-owned safe area/ticker/header boundary, with 8px below. The felt reserve derives from the same dimensions, including the appropriate separator borders. Lobby and session tracker follow the same alignment.

Occupied-table qualification sets two responsive limits: phones at most 375px wide and 700px tall retain 52px controls with an 8px top inset and no bottom padding; the smallest short phone (at most 340x650) retains its existing accessible 44px band. Enlarging that last band even four pixels obscured the six-seat dealer/board lane. Poker geometry and gameplay controls are unchanged.

Existing artwork, navigation handlers, card previews, tab scrolling and safe-area ownership remain intact. Game/stakes text is larger. Label tabs share available width down to their 44px touch floor so native WebKit font metrics cannot strand the fourth tab; card previews retain their non-shrinking width.

The existing required CSS Beat cases now cover browser/installed layouts at 320, 375, 393, 430, 480, 481, 606, 768 and 1280px, short/tall phones, 0/24/59px insets, control clicks, pinned alignment, four tabs plus tracker, larger-font boundaries and exact rendered/static reserve agreement. Existing occupied-table assertions pin the new Lobby sizes and preserve board/card/marker clearance. The screenshot-width size/placement assertion and the larger-font reachability assertion both fail against their respective prior source.

Local checks, exact-head protected checks, publisher and live proof are recorded in CHECKPOINT-table-header-size.md.
