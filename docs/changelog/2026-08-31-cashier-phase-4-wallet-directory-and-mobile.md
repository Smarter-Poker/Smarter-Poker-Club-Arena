# Cashier Phase 4 — Wallet Directory, Route Safety, And Mobile Access

The Club Arena Cashier tile now exposes its complete wallet directory through
desktop right-click, mobile long-press, and keyboard commands. Every eligible
club membership remains available regardless of the user's cashier hierarchy
role, while union treasury destinations remain owner-only. The directory also
shows per-club balances, distinguishes an unavailable balance read from a real
zero, and provides an inline retry without blocking wallet navigation.

Cashier intent now preloads the Trade cashier chunk that the tile actually
opens instead of warming the legacy cashier. Club and union wallet selections
continue to deep-link to their specific workspaces, and every contextual
cashier opens on its first Trade tab before role resolution applies any player
restriction.

Union dashboard loads now use a route-scoped request version, so a slower
response from a previous union cannot overwrite the current union or its
loading and error state. A final queued jackpot event from an old realtime
channel is also rejected after navigation.

Cashier action sheets now respect mobile safe areas and dynamic viewport
height. Their actions remain sticky and reachable above phone browser chrome,
while the wallet directory preserves managed focus, roving keyboard focus,
announced loading/error states, and standards-compliant menu structure.
