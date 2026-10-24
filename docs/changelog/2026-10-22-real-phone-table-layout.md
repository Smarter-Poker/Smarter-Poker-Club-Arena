# Real Phone Table Layout

Dan, October 22, 2026, with five screenshots from a real phone and one from desktop:

1. "For 9 max games the avatars and frames are too large, they are still overlapping each other, and there needs to be some space between them to allow for action bar and bounty amount above their heads."
2. "If you lower and center the fold call raise buttons we can use that extra padding at the bottom to pull the table and everything else down some, to give more space for the top seats. Also the stop watch icon should be centered to its frame and any totals or remaining uses should be overlapped like a notification number."
3. "For 6 max games same issue with the fold call raise. Also the 1 on top of the chat box should just be removed."
4. "The raise, fold and other actions should be slightly higher, above the avatar, not overlapping the top of them. And if a player is all in and the action is not completed there should be an ALL IN button (like the dealer button) anytime a player is all in."
5. "For desktop the only thing I'm seeing is that bottom user display gets cut off by the action bar at the bottom."

## Why The Phone Looked Different From Desktop Mobile View

Desktop mobile view has no safe areas. A standalone iPhone has 47 to 62px at the top and 34px of home-indicator strip at the bottom, so the real felt is about 80px shorter, and every 9-max side column was squeezed into that.

## What Changed

- **Seat sizes (7 to 9 max, phones):** villain avatars are now sized from the felt, between 34 and 52px (`clamp(34px, min(14% of width, 8.5% of height), 52px)`), with a slimmer name plate. The layout geometry (`seatPodPx`) knows that size, so seats are placed for the pod that is actually drawn. Below 620px of height the compact sizes step down again.
- **The lane above the head (phones):** the action tag now stands on the top of the player's ART. Bust art is scaled up from its feet, so each seat measures how far its crown rises above the box (`--sp-art-rise`, set in `SeatSlot.tsx`) and the tag sits 3px above that. The bounty pill sits on the crown, or directly above the tag when there is one. Top-rail players keep both beside or below the plate, because the jackpot banner is above their heads. Desktop keeps its corner pill and its tag, which already fit.
- **Action bar lowered (phones):** the FOLD, CALL and RAISE row now sits 18px into the empty top of the home-indicator strip (`--sp-bar-inset`), and everything stacked on the bar (pre-actions, tournament dock, HUD, chat, Lightning) follows it. The space this frees (`--sp-bar-drop`) moves the whole table down, giving the top seats room.
- **Time bank:** a recentred stopwatch raster (black and blue, `timebank-centered-*-v1.webp`), and its remaining count is a red notification badge on the corner, on the table and on the control strip.
- **Chat:** the unread number on the chat button is gone. Messages still appear on the table and in the chat history.
- **ALL IN puck:** shown for every game type whenever a player is all in and the hand is still running, the size of the dealer button, in front of the player beside the chips. The tag above the head reads ALL IN for the same period.
- **Desktop hero:** the strip under the felt was a flat 60px, which only covered the smallest felt. The hero plate hangs a tenth of the felt's width plus 27px below it, so the strip is now solved from the page height (with 60px as the floor) and the hero's plate always clears the action bar by at least 6px. Portrait tablets take the smaller of the width and height terms.

## Size Change Shipped (Geometry Baseline)

Making room for the desktop hero costs the felt 1 to 4 percent on desktops and tablets. Felt widths: laptop 323.9 to 320.8px, desktop 1440x900 381.3 to 374.9px, 1920x1080 490.0 to 477.5px, iPad portrait 559.9 to 555.0px, iPad Pro 12.9 portrait 669.9 to 647.1px. Cards, avatars and seats scale with it. Phones do not change. `tests/e2e/support/geometry-baseline.json` is regenerated in this commit.

## Verification

Real components rendered headless with real safe areas (375x812, 390x844, 393x852, 402x874 and 430x932 with notch and home-indicator insets, plus 375x667), 9-max and 6-max, cash and tournament, including the worst case where every seat has a bounty, an action tag and three players are all in: zero overlaps between any two seats' avatar, plate, tag, bounty, position chip or wager. Desktop (503x1231 to 2560x1440): the hero plate now clears the action bar at every size, and cross-seat overlaps are the same as before or fewer. At 320x568 (first-generation iPhone SE) the side columns still touch in the all-bounties worst case. Local: `table-proportions` occupied-ring guard and `top-rail-seat` pass. Pins updated in this commit: the hero strip derivation (`all-in-cannot-leave-and-the-hud-slot`), the bar inset (`actionBarSliderAndFooter`, `the-tournament-box-is-under-the-action-bar`) and the bounty lane (`tourneyUxSweep20260825`).

## Follow Up: Bets And The Button Belong To Their Player

Dan, the same day, with three more phone screenshots: "That 50 cents to my left is actually my bet, it's sitting in front of the other player", "I'm actually one behind the button and the button is right in front of me", and "lower the hero avatar down so it's not messing with the table layout for buttons, chips etc."

- **Root cause, bets:** the phone wager placer took the nearest clear felt spot to each player. When the space in front of a player was crowded (the hero's own bust filled the bottom of the felt), the nearest clear spot was in front of the next player, so the bet read as theirs.
- **Root cause, button:** the dealer button's rest point is worked out from the seat ring. On a phone, that geometry does not know where the tags, bounties and plates were actually drawn, so its keep-outs pushed the button across the felt until it stood nearer the neighbouring player.
- **Fix:** `useProtectedCardLayout` now places both on the painted layout. A wager or the button may only stand where its own player is the nearest player, measured from the avatar centres. The wagers are placed first, then the button takes a spot beside its own player that they left clear (`placeDealerButton`). The ring geometry and its law tests are unchanged.
- **The hero is lower:** on phones the hero block drops up to 22px. It only moves into the empty space below a width-bound felt (the felt's allowed height minus its painted height), so the reserved strip above the action bar still holds the plate and the hand read. The hero's crown no longer fills the bottom of the felt, which leaves room for the hero's own bet and the button.
- **Guarded:** the `table-proportions` occupied-ring beat now fails if any bet or the dealer button reads as another player's at 375px and wider. Run against the previous placer, it fails on five players' bets.

Verified headless at 375x667, 375x812, 390x844, 393x852 and 430x932 with real insets, six and nine handed, with the button on every seat: every bet and the button are nearer their own player, with no overlaps. The one exception is the synthetic worst case (three all-ins with bounties on one side of a nine-handed table), where one bet still lands nearer the folded player below it, because the only free felt in front of its owner is the printed table name, which bets may not cover. At 320x568 (first-generation SE) the felt is too small to promise ownership, but no two bets share a spot.

## Follow Up: Shown Hands Are Clearly Displayed

Dan, the same day: "Make sure that when a player is all in and or the cards are shown down, that they are clearly displayed. A player said they could not see the players cards they lost to in PLO6." His standing rule: villain cards shown at showdown are the same size as the board cards, overlapped but never covered, so every card is readable.

- **Root cause:** on a phone, a villain's tabled row was sized to fit every card side by side inside the width of that player's name plate. A PLO6 hand came out as six cards about 12px wide, and even a two-card hand was 14 to 20px wide.
- **Size (`SeatSlot.css`, phones):** every tabled card is now the board's painted card width. `useProtectedCardLayout` measures the board card and publishes `--sp-board-card-w`; before a board is out, a share of the table width is used instead. A hand of four or more cards overlaps half a card apart. Each card is stacked over the one to its left, so every rank and suit corner stays in view. On the 320px first-generation SE, tabled cards are 8 percent of the table width.
- **Placement (`useProtectedCardLayout`, phones):** tabled hands are placed before the wagers and the dealer button, which are then placed around them. A hand may cover its own player's art, tag and chips, but never their plate or the jackpot banners. It must stand nearer its own player than any other. If it cannot, it closes up from half a card to a little over a quarter. Only if no spacing works does it drop to 85 percent of the board size (seen only on a short phone's top chair).
- **Guarded:** the occupied-ring beat now runs a PLO6 showdown on six- and nine-handed tables at 375px and up. It fails if any tabled card is under 22px wide, any card's corner is hidden, two tabled hands overlap, or a hand stands nearer another player. The same ownership checks apply to the two-card showdown at every phone size from 375px.
