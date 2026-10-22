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
