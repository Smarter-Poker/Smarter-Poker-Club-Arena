# The Player Record Shows Every Upline Agent

Dan, 2026-10-21: "WHEN YOU CLICK ON ANY PLAYER INSIDE MY CLUB, I SHOULD BE ABLE
TO SEE WHO IS UPLINE AGENT(S) ARE. I CURRENTLY CAN'T SEE THIS."

## Cause

The Player Record printed only the direct agent, as one line ("Upline Agent")
near the bottom of the Membership Record card. A player under an agent under a
super agent showed one name, and nothing showed the rest of the chain.

## Fix

- `ca_club_member_upline_chain(club, user)` (migration `20261022044452`, applied
  to production and read back) walks `club_members.agent_id` upward inside the
  club from the player's direct agent to the top of the chain. Each level
  returns depth, Arena name, player number and club role. Cycle safe, capped at
  20 levels, deleted profiles skipped. Same access gate as the record's
  financial view (staff, downline, service); anyone else gets NULL. Measured
  1.2 ms on production.
- `MemberUplineCard` is the first card under the credential on the Player
  Record: "Direct Upline (Super Agent) TomTomTamale (ID: 925976)", then
  "Upline Level 2 (Owner) KingFish (ID: 1)", closest agent first.
- `ca_club_member_detail` is untouched.

Pinned by `tests/components/PlayerUplineAgents.test.tsx`.
