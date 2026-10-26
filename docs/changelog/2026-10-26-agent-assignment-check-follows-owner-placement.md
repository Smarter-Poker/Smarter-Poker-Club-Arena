# Agent assignment check follows owner placement (2026-10-26)

Since `20261026031314_members_with_no_agent_sit_under_the_club_owner`, a member
who joins without an agent is placed under the club owner. The post-deploy
agent-assignment qualification still required every fresh player to start with
no agent at all, so it failed on its first membership read
(`qualify-agent-assignment.mjs`: expected null, got the club owner) and every
browser check after it was refused for lack of the template staff fixture.

The check now reads the club owner and accepts either the owner placement or no
upline (a club whose join door predates the rule). The first record save must
name the upline it actually read: the player record passes the owner as the
expected current agent, because `ca_club_member_upline_chain` now reports the
owner link as a real assignment. `fn_preview_club_assignment` compares that
value with `club_members.agent_id`, so a stale read is still refused.

The fixture test models owner placement and fails on the previous script with
the same mismatch production reported.
