# Members with no agent sit under the club owner

Dan, 2026-10-25: "ANY 'ORPHANED' PLAYERS, OR PLAYERS WITH NO AGENTS, GET
ASSIGNED TO THE CLUB OWNER. 'KINGFISH' FOR KINGS CLUB PLAYERS." Then:
"ASSIGN ALL ORPHANED PLAYERS TO THEIR CLUB OWNER AND FIX THE JOIN PATH".

## Cause

`fn_join_club_membership_impl`, the only door that creates a membership,
inserted every new member with `agent_id` NULL. An agent's invite code then
placed the player under that agent, but anyone who joined with no code, or
whose inviter had left, stayed with no agent. `fn_ca_deleted_account_leaves_every_club`
did the same to a deleted agent's downline when nobody live sat above it.

Read 2026-10-26: 170 live chip-club members had no agent (KINGS CLUB 16,
Midway Union 6, Deep Stack Society 1, The Felt Society 1, Club Savage 1,
Lightning Internal Pilot 145, nearly all horses there), and new ones were
still arriving.

## Fix (migration 20261026031314)

1. The join door inserts a non-owner member under the club owner.
2. The invite redemption treats that unchosen owner placement as "no upline":
   the first invite still places the member under the inviting agent. A
   placement an invite made is never moved, as before.
3. An agent can still add a member whose only upline is that unchosen owner
   placement.
4. A deleted agent's downline with no live upline goes to the club owner.
5. The 170 members were moved under their club owner in the same transaction.
   Staff (co-owners, admins), the owner, the Diamond Arena and departed history
   rows were left alone. The welcome text was not re-sent to the moved members.

Accounting already treats the owner as a direct upline: an owner with agent
terms (KingFish in KINGS CLUB, 30%) earns as their agent from now on, as he
already does for the 552 members under him; an owner with none earns no agent
commission. Nothing settled earlier changes.

Pinned by `tests/a-member-with-no-agent-sits-under-the-club-owner.law.test.ts`.
