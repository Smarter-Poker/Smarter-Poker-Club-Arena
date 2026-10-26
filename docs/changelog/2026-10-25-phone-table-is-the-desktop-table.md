# The Phone Table Is The Desktop Table

Dan, October 25, 2026, with two phone screenshots of a nine-handed tournament and a 603px-wide desktop window beside them:

1. "FOR MOBILE, CHIPS ARE STILL DISPLAYING IN THE WRONG LOCATIONS INSTEAD OF ALWAYS 100% OF THE TIME BEING IN FRONT OF THE USER WHO BET THE CHIPS. IT WORKS PERFECT ON DESK TOP AND ON IPAD, BUT FOR MOBILE PHONES ITS WRONG ... MAKE THE MOBILE LAYOUT AND CHIP POSITIONS THE SAME AS DESKTOP AND IPAD."
2. "SEATING LOCATIONS NEED TO BE THE SAME AS WELL. AND NOTICE ON DESKTOP THE SIZE OF THE AVATARS, AND HOW THEY REACH THE TOP OF THE PAGE AND 'CUT OFF' THATS PERFECT, MAXIMIZE ALL THE SPACE WITHOUT 'CROWDING THE SCREEN'." and "THIS IS HOW IT SHOULD LOOK ON MOBILE..."

## What Was Wrong

- Below 481px the table had a layout of its own: a narrower felt, compact player pods, seats pulled into outer lanes, a perspective taper and bets resting on the rail. Over months it had drifted from the desktop and iPad layout in every one of those, which is why the seats, avatar sizes and chips all looked different.
- On every portrait screen up to 768px the wager placement pass moved each bet to the best clear spot it could find. It centred that search on the player's avatar rather than on the spot in front of them, it treated an empty chair as nobody, and its last fallback tiers dropped the rule that a bet must be nearer its own player than anyone else. In Dan's screenshots a top player's raise ended up on the far rail beside an empty chair, and a raise and a big blind printed in front of each other's players.
- The top players' bets were held back at the rail while their pods dropped below the jackpot plate, so the plate and its action tag printed over the bet.

## What Changed

- `useTableEnvironment.ts`: while a table is the tab in front on a portrait phone (480px or narrower), the page lays the table out at 600px, the same layout as Dan's desktop window, and the browser scales it to the phone's width. Seat positions, avatar sizes, the top-edge crop, the felt and the bets are the desktop's own. Pinch-zoom stays locked at that scale. A "+" tab showing a World Hub page, the lobby and landscape keep the phone's own width.
- `useProtectedCardLayout.ts`: the wager search starts from the bet's own rest point in front of its player and moves it only as far as it must; empty chairs count as somebody's lane; every tier keeps the ownership rule; a bet with no clear spot of its own stays at its rest point in front of its player.
- `tableGeometry.ts`: a portrait bet's walk toward the middle of the felt also clears its own player's action tag (above a side player's head, below a top player's plate). On the fallback phone layout a bet now takes the desktop's walk from its player toward the middle, instead of the nearest rail or a sideways walk along the top cap, nudged off the board and pot toward its own player when needed.
- `SeatSlot.css`: a top pod that drops below the jackpot plate takes its bet with it.
- `DealerButton.tsx` reasons about the bets where they actually rest.

## Verification

Real table components rendered headless (the `portraitRailScene` fixture) at 320, 375, 393, 430, 600 and 820px, six and nine handed, hero and spectator, with and without shown hands, before and after; the live production table was also previewed in the built-in browser at 393x852 with the 600px layout applied. New laws: `tests/a-bet-sits-in-front-of-its-own-player.law.test.ts` and `tests/a-phone-lays-the-table-out-like-desktop.law.test.ts`. The two `chipRail` tests that pinned rail bets were replaced in this commit by tests that pin the in-front placement.

Client presentation only: no engine change, database migration or money path.
