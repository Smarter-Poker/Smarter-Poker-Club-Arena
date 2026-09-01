# A super agent could not manage its own sub agents

2026-09-01. Migration `20260901121428_super_agent_grants_reach_the_whole_downline`.

Dan's directive (item 2 of the Deep Stack Society six-item list, verbatim):
"SUPER AGENTS CAN PROMOTE DOWNLINES UNDER YOU, BUT ONLY AN OWNER, CO OWNER OR
ADMIN CAN PROMOTE AN AGENT TO A SUPER AGENT, AGENTS CAN PROMOTE A PLAYER IN
THERE DOWNLINE TO A SUB AGENT."

An earlier fix taught `fn_club_grantable_roles` about super_agent and agent
actors, but a super agent facing a sub agent in its own downline still got
`{}` -- it could raise a player to agent, but could neither appoint a sub
agent nor demote one. Measured live before the change: Deep Stack super agent
vs a sub agent in its own branch returned an empty array while
`fn_club_is_in_downline` was true.

The change: a super_agent actor with a target of player, agent, or sub_agent
inside its OWN downline may now grant `agent`, `sub_agent`, or `player`.
Everything else is untouched -- super_agent stays owner/co-owner/admin-only,
agent actors still grant only sub_agent/player in their downline, cross-branch
targets still return `{}`.

Verified against production inside the migration itself: four assertions on
live Deep Stack hierarchy rows (grant present, no super_agent minting,
cross-branch refusal, agent actor unchanged) -- all green on apply.
