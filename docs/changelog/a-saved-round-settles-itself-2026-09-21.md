# A saved round settles itself, and a won game starts itself

Owner ruling, 2026-09-21: "No games should ever require a user to check anything,
they must always auto start and play."

Donkey Cross in Shark Club sat on "Check Your Saved Round Before Starting Another"
with every exit held. The server had deleted the sealed ticket the page was holding
the moment a second ticket was requested, the start function hit that as a
foreign-key exception (HTTP 409) instead of a refusal, and the page saved the wager
and asked the player to press Check Round, which replayed the same dead ticket
forever.

Server (migration 20260921185541): dealing a ticket sweeps only the player's
expired tickets, and both start functions refuse a dead ticket cleanly
(`ticket: 'gone'`) before the entry insert whose foreign key raised.

Client, first change: every Diamond Spins page replays a saved wager on its own
schedule (`useAutoSettle`), re-deals a refused ticket and sends the same wager
again, and the wheel recovers an unconfirmed spin itself. No Check Round, Check
Bonus or Recover Spin control remains.

Client, second change: a won game starts itself. After the Double Down offer is
answered (it spends the player's own diamonds, so nothing starts over it), a
five-second visible countdown presses Start; changing the answer starts the window
again; a refused automatic start is shown, not retried on a timer. The bonus guard
holds a page for money in flight, and for a won game only while that game can
start, so a daily limit, a pause or a closed game never traps the player. A failed
load, entry quote, ticket deal, next-spin preparation or bonus-spin read is tried
again by the page (1s, 2s, 4s, then every 8s) with neutral copy; games paused for
the maintenance break come back by themselves. A refused start re-reads the entry
quote, which previously left Start held on "Checking Your Entry" until a refresh.

No payout, price, odds, limit or visual element changes. Labels only.
