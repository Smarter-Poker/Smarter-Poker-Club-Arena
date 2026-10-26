# The Players List Fits A Phone

Dan, October 25, 2026, with a phone screenshot of Player Management: "PLAYER MANAGEMENT ON MOBILE NEEDS TO BE OPTIMIZED FOR MOBILE. DATA IS CUT OFF, FONTS ARE TOO LARGE ITS A MESS."

## What Was Wrong

On a phone (the screenshot matches an iPhone with Display Zoom, which reports a 320px screen) every player row used desktop-sized type (16px name, 16px details) and gave the fees and win/loss figures a wide column. That left the name, upline, PlayerID and last-seen about 90px between them, so each was cut off mid-word ("PostDe...", "Upline: Tru...", "PlayerID: " with no number) and the last line fell out of the bottom of the fixed-height row.

## What Changed

`src/pages/ClubMembersPage.css`, phone widths only (480px and under, with a second step at 360px and under). Tablet and desktop rows are unchanged, and the row keeps its fixed height for the virtual list.

- A smaller avatar and chevron, and phone-sized type: name 15px (14px on the narrowest phones), upline 12px, details 13px (12px), figures 14px.
- Four short lines per player: the name, the upline under it (Dan's October 25 ruling), the PlayerID on its own line, then the role and the online or last-seen status.
- The name stays on one line; only an unusually long name ends in an ellipsis, and nothing is broken mid-word. On the narrowest phones "Upline:" and the agent's name may take a line each.
- The figures column takes only the width its numbers need; on the narrowest phones "Fees Generated" may wrap onto two short lines so the name keeps its width.
- The search box and the two pickers keep 16px type so iPhone does not zoom when they are tapped.

No data, query, sort, filter or refresh behaviour changed.

## Verification

The real stylesheet rendered headless at 320, 360, 375, 393, 430, 768 and 1440px with realistic rows (long names, uplines, 7-10 digit PlayerIDs, Online, At Table, Seen Today, positive and negative win/loss, downline fees): no page scrolls sideways, every ordinary name, upline, PlayerID, role and status prints in full and inside its row, and 768/1440px are unchanged. A new case in `tests/e2e/css/club-members-containment.spec.ts` (part of the required CSS Beat suite) pins that at 320-430px. The 22 unit test files covering the page pass.
