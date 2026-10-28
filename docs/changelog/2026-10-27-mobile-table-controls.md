# Mobile Table Controls And Player Clearance

Phone gameplay tools use a 48px painted target instead of 34px. Decision buttons use 52px and clear the home indicator, with a 12px lower allowance where the browser reports no inset. The shared static reserve keeps preselection and decisions from moving the felt. Raise sizing, adjustment and confirmation targets grow with them.

The portrait table starts lower, leaving space for full-size top artwork. Dense rings use the same avatar/plate sizing at every villain position, rather than a special 36px top pod. The smallest 320px phone uses equal compact artwork at all villain seats and 48px decisions while retaining its scarce playing height. The existing 52px Lobby button remains aligned below the action-strip top inset.

Occupied-ring and real action-component browser coverage checks visible tool size, equal villain size, home-indicator clearance, hero/board/card/wager separation and static felt geometry. Client-only change; no new engine API, database migration or financial behavior.

A crowded shown-hand lane now tries zero extra padding at its owner before the existing distant fallback; protected rectangles still cannot overlap. This keeps tabled PLO6 cards with their own player after equalizing top artwork. Geometry baselines record the intended 44px-to-52px action increase and 30–42px reduction in available phone felt height (42px on the short SE), with unchanged felt width and card sizes.
