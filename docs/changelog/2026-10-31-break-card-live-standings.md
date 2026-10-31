# Tournament break standings stay current

The break card previously read the field once when the overlay opened. A player eliminated in the last hand could remain counted throughout the break while the tournament dock already displayed the committed elimination. The card also truncated fields at 500 players.

The card now uses the dock's complete standings reader and shared tournament event subscription. Settled hands, registration/rebuy events, reconnect and visibility recovery refresh the remaining field, average, hero rank and chip leaders. Starting the countdown rereads the completed last hand. One read runs at a time with one trailing read when events arrive in flight; superseded and previous tournament/account responses cannot paint. A failed refresh displays unavailable instead of retaining apparently current standings. Competition ranks use the shared rank helper.

Regression coverage reproduces the 73-to-72 transition, complete 1,201-player fields, in-flight invalidation, last-hand transition, owner changes, unsubscribe, failed refresh and recovery. The five new regression cases fail against the previous component. Existing card artwork, share controls and countdown behavior are preserved. This is client-only and requires no engine activation or database changes.

The total field also comes from the complete entry rows. Production readback confirmed `current_players` is a draining survivors counter, so it cannot supply the “Of” denominator.
