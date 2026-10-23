# The game lobby drawer escapes the page stack

The production Diamond Arena sweep could focus Close Game Lobby but could not
click it: the global header's Messages control intercepted the pointer in both
phone orientations. The fixed drawer was trapped inside its page's stacking
context below the global header.

GameLobbyPanel now portals its unchanged drawer to the document body. It uses
the existing full-screen tournament lobby layer (2100), above the persistent
felt (1100), table menu (2000) and global header (390). The painted artwork,
entry actions, React navigation context, focus trap, Escape/backdrop handlers
and body scroll-lock lifecycle are preserved. A non-DOM render returns null.

The existing required mobile lobby browser suite renders the real component
behind the same header/ancestor stack. Its pointer reachability assertion fails
before the fix and passes afterward. Cash, MTT, Spin and Sit & Go drawers close
with ordinary clicks at 393x852 and 852x393; focus returns, scrolling restores,
Escape closes, and the visible landscape backdrop closes. The unit regression
also verifies portal ownership and removal/scroll restoration on unmount.
