# Promotion system audit — the rate is chosen, staff earn none, co_owner counts

2026-08-31. Dan asked for a deep dive on promoting a player to co owner, admin,
super agent, agent or sub agent: what access each role is granted, whether the
rakeback percentage is assigned when the role is created, and everything else
that is broken along the way.

Nine defects, all live in production this morning. Ordered by what they cost.

## 1. co_owner was a role that unlocked nothing

`co_owner` had been added to `club_members.role`, to the CHECK constraint, to
`fn_club_grantable_roles`, to `clubRoles.ts` and to the promote screen. It was
never added to anything that ASKS whether you are staff. An owner could appoint
one, and the appointment bought them less than a plain player had:

| Asked                                                        | Answer for a co-owner     |
| ------------------------------------------------------------ | ------------------------- |
| `fn_role_rank('co_owner')`                                   | **0** — a player scores 1 |
| `is_club_admin`, `fn_is_club_admin_uid`                      | false                     |
| `ca_can_view_club_finances`                                  | false                     |
| `fn_actor_can_manage_club_treasury`                          | false                     |
| `fn_can_create_games`                                        | false                     |
| `fn_can_message_in_club`                                     | treated as a plain player |
| 18 club-scoped RLS policies                                  | denied                    |
| `server/src/handlers/admin.ts` — the engine's only role gate | 403                       |

`src/types/clubRoles.ts` opens by naming this exact failure — "how co_owner
would have arrived as a role that unlocked nothing" — and it arrived anyway,
because the seven-role vocabulary was only ever taught to the write path.

Fixed in `20260831235996_co_owner_counts_as_club_staff.sql`: 24 functions and
18 policies rewritten by regular expression rather than retyped, so each body is
byte-identical apart from the added role, with the outcome asserted inside the
migration. `fn_club_is_staff(club, user)` is added as the canonical question so
the next role is one edit rather than twenty-four.

## 2. The rakeback rate was invented by the server, not chosen by a human

Dan: "MAKE SURE THAT RAKE BACK PERCENTAGES ARE ASSIGNED WHEN CREATING THEM."

Three server paths each invented a different pair, and none of them asked:

| Path                      | Commission                    | Player rakeback             |
| ------------------------- | ----------------------------- | --------------------------- |
| `fn_club_set_member_role` | 0.50 super agent, else 0.30   | 0.30 super agent, else 0.20 |
| `fn_ensure_agent_row`     | union minimum, or 0           | **0**                       |
| `fn_create_agent`         | asked — the only one that did | asked                       |

Worse, `fn_club_set_member_role` applied its pair **only on INSERT**. Re-promote
a demoted agent and the row already existed, so the role changed and the rate
did not: a sub agent could carry the super agent commission they used to have.

Now: the promote screen collects a commission and a player rakeback percentage
whenever the target role is an agent tier, neither field pre-filled, and
`fn_club_set_member_role` **refuses** an agent promotion that arrives without a
rate (`needs_rates: true`) unless there is an existing row to inherit from. The
rate is applied on both branches, validated against the column bounds
(0–0.70 and 0–0.50), refused if the rakeback exceeds the commission it is paid
out of, and refused if either exceeds the upline they report to.

## 3. Co-owners and admins earned rakeback

Nothing said they should not. `club_members.player_rakeback_pct` is the first
branch of `fn_player_rakeback_rate`, so a player carrying a personal deal kept
that deal when promoted to admin.

Two triggers now make the rule true by construction rather than by care, one on
`club_members` and one on `agents`, so it holds whatever writes them —
confirmed by probe: a direct write of 0.40 onto an admin lands as 0.0000.

The **rate** is zeroed, never the `agents` row: that row doubles as the agent
wallet (`fn_ensure_agent_row` is how a club-bank send mints one), and suspending
or deleting it to make a point would strand chips.

Measured before writing: 0 co-owners and 0 admins exist today, so the backfill
corrected nothing. It is there so the first one created lands in a world where
the rule is already true.

**Left for Dan.** One live **owner** holds an active agents row at 0.30/0.20.
Dan named co-owners and admins; whether an owner may also carry players is his
call, so nothing was changed and nothing was assumed.

## 4. Two RPCs wrote roles behind the grant matrix's back

`fn_create_agent` and `fn_admin_update_agent` both ended with a bare
`UPDATE club_members SET role = p_role`. Being SECURITY DEFINER owned by
postgres they are exempt from `trg_club_members_role_guard` by design, so the
downline guard never ran and no `audit_trail` row was written. Both now route
the role change through `fn_club_set_member_role`.

`fn_admin_update_agent` also validated rates against 0..100 while the table
CHECK allows 0..0.70 and 0..0.50, so a caller sending `25` for "25%" passed
validation and then hit a raw 23514.

## 5. Two role editors had been failing silently for nine days

`MembershipService.updateRole` wrote `club_members.role` directly, typed against
the `MemberRole` union at the top of that file — `club_owner`, `club_admin`,
`member`, `guest` — none of which `club_members_role_check` has ever accepted.
`trg_club_members_role_guard` refuses the three that overlap. So ClubDetailPage's
Promote and Demote buttons and ClubMemberManagement's role select had been
throwing into a catch and toasting "Failed to..." for every click. Demote sent
`'member'`, which is not a role at all.

All three now go through the RPC, and the server's own reason is shown instead
of a generic failure.

## 6–9. The smaller ones, each a real denial

- `MembershipService.getEligibleForPromotion` filtered on `role IN ('member','guest')`,
  so the agent promotion picker was **always empty**. Now `'player'`.
- `ChipTransferModal` routed on `senderRole === 'owner'`, so a co-owner's club
  allocation went down the agent-to-player path — out of the wrong account.
  Now `isClubStaff`.
- `ClubMessagingPermissions` mapped three of seven roles; co_owner, super_agent
  and sub_agent all fell through `default` to `player`, so a co-owner could not
  message their own club and a sub agent could not message their own players.
- `useClubMembership` compared against `club_owner` / `club_admin` /
  `platform_admin`; all three booleans were permanently false.
- Display: `ClubsPage`, `ClubDetailPage`'s local badge and `ClubMemberManagement`
  knew four role names between them, so a co-owner, super agent, agent and sub
  agent all rendered as "Player" or "MEMBER".
- `fn_audit_actor_role` wrote `'co_owner'` into `audit_trail` whenever the actor
  was an **admin** — a stand-in from before co_owner existed, naming the wrong
  person in the one record kept to say who acted.
- `fn_union_law_extra_breaches` flagged any role outside a six-name list as a
  law breach, so every co-owner was a standing false positive.

## A correction I nearly shipped

The first draft of `20260831235997` opened with "the guard was never armed" and
claimed any club admin could write `role='owner'` straight through PostgREST.
That was wrong. `trg_club_members_role_guard` exists and works; a truncated
`string_agg` in my own inspection query had hidden it from a trigger listing.
The migration header now records both the claim and the correction, because the
next person to read that policy will have the same thought I did.

## Verification

- `npx tsc --noEmit` clean, client and server.
- `tests/promotion-assigns-the-rate.law.test.ts` — 27 pins, all green.
- Both migrations applied to production and asserted inside themselves
  (24 functions, 18 policies, both triggers, the six-argument RPC).
- Behaviour probed against production **inside a transaction that was rolled
  back**, per section 11.5: no-rates refused, staff-with-a-rate refused,
  rakeback-above-commission refused, a properly specified promotion storing
  exactly 0.4200 / 0.1100, and a promoted admin's 0.2500 personal deal landing
  at 0.0000.
