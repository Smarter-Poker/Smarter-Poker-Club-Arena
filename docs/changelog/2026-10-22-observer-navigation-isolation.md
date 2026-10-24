# Observer navigation stays in its browser tab

MasterBus broadcast local lobby, Hub, table-observe and must-move navigation commands to every open tab. A spectator could switch its internal table while its route still named the original table.

Keep these four commands local on outbound and inbound BroadcastChannel boundaries. The inbound guard also rejects commands from older open bundles. Same-tab navigation and cross-tab player data updates retain their existing behavior. Regression tests exercise the real bus with an injected channel, including legacy incoming commands and subsequent local delivery.

No engine, socket limit, session, seat or financial behavior changes.
