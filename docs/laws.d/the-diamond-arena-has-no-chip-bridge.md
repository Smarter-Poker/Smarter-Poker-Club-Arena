# tests/the-diamond-arena-has-no-chip-bridge.law.test.tsx

The programme's rule is that the Diamond Arena club must never acquire chip
balances: it is one open club played with Diamonds instead of chips (Dan
2026-09-11), and it has no `club_members` chip wallet to pay anything into.
Two chip club surfaces were nevertheless mounted inside the Diamond context.
The closed-arena notice in ArenaAccessBoundary carried the Diamonds To Chips
button, and the shared lobby mounted the bust prompt ("Out Of Chips? ... Chip
Prizes Paid Into Your Club Wallet"). Both lead to the host club's
diamonds-to-chips wheel, which credits that club's `club_members.chip_balance`
with chip prizes. Both were silent only because the Diamond host club has no
wheel or game configured, which is a row staff can add without touching this
repository, and on the day they did every Diamond player would have been sent
to a wheel that gives the arena the chip balance it must never hold.

The law holds it at the component and at the source. ArenaAccessBoundary no
longer imports the bridge at all, and its closed-arena notice renders for a
Diamond player without it. DiamondBustPrompt reads the boundary's server-
verified entitlement, switches its `fn_diamond_games_entry` read off inside
the arena and renders nothing there, while a felted chip club member is still
invited exactly as before. ClubHomePage mounts the prompt once, only behind
`!isAutomaticArena`, which is the server's `automaticMembership` answer and
not a route or a club id. Neither arena file names the games entry door.
