# Completed Seat Moves Survive Account Hydration

A retained `seat_moved` event could reach TablePage while its account was still `guest`. The page discarded the handoff and did not revisit it when the account loaded. The page now retains completed moves by recipient until identity resolves, discards them when table scope changes, and follows only the matching player. Pending proposals and unrelated table events cannot navigate.

The table route boundary also passed every validated route ID as `embeddedTableId`, so standalone pages attempted a container callback that did not exist. Validation now preserves the caller's embedding mode and keys the live page to its validated table identity, retiring the previous table's local state and effects on a move.

The connected PostgreSQL/engine/WebSocket/browser probe reproduced the old-source route failure. The maintained client tests exercise delayed identity, intervening events, both swap identities, stale table scope, spectator events, and repeated effects. The existing table-container wiring assertions still enforce in-place embedded navigation. No transfer transaction, chip write, or account authorization is delegated to the browser.
