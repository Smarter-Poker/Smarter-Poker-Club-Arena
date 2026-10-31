# Row observer waits for the real View entry contract

The deployed row-owner case stopped five seconds after View Game while the
actual lobby still awaited table preparation. It never reached the two-owner
row assertions. This does not establish that the historical entry eventually
succeeded.

Only the first View navigation assertion now uses the real bounded entry
contract: a token read up to 15 seconds, then the mux initial-state gate up to
15 seconds. The roster read starts concurrently and has its own five-second
bound; the warm-slot TTL may reject earlier. This is a condition wait, without
another click, reload or retry. All two-owner joins, natural row deliveries,
unmount survival, participation and stable client assertions remain intact.

The existing mounted ClubHome fixture invokes its real View handler with a
deferred preparation boundary: it remains in the lobby after six seconds and
navigates only after preparation resolves. A rejected preparation reports the
existing warning and never navigates. These isolated cases qualify the caller
contract, not historical production success. No product behavior changes.

Verification: two focused mounted caller cases passed; final TypeScript,
ordinary hooks, protected checks and affected live proof follow separately.
