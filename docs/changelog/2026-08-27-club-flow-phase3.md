# 2026-08-27 — club flow phase 3: the approval gate is real now

Session: Cowork (Claude), third pass of the create/join club audit.
Shipped as **PR #1414** (main `b863619544`). Production `/api/health` served
WH `871a2721` (contains sync `5e8e9c36` of exactly `b863619544`) at
2026-08-27T06:20Z. The migration was live the moment it applied, ahead of
the frontend.

## The finding that mattered

`clubs.requires_approval` was enforced in exactly one place: inside
`fn_join_club`. The `club_members` RLS policies never mention `status`, and
the column default is `'active'`. Two doors, both open to any authenticated
PostgREST caller:

1. `INSERT club_members {club_id, user_id: self}` — self-join policy admits
   it, default lands `active`, straight into an approval-required club.
   Every live club requires approval.
2. A pending requester PATCHes their own row to `status='active'`.

## The fix

Migration `20260827_approval_gate_cannot_be_self_served` (applied):
BEFORE INSERT / BEFORE UPDATE OF status triggers.

- **NOT SECURITY DEFINER, gated on `current_user`** — this is the load-
  bearing design decision. DML inside definer functions (`fn_join_club`,
  and critically `fn_redeem_club_invite_code`, which admits invited players
  by flipping their own pending row to active) runs the trigger as the
  function owner and passes. A raw PostgREST call runs it as
  `authenticated` and is gated. The `role` GUC cannot make that distinction
  (it stays `authenticated` through a definer call) and would have broken
  invite redemption for every invited player.
- Rogue INSERT → downgraded to `pending` (what fn_join_club would write).
  Self-approval UPDATE → refused loudly (23514). Staff approving someone
  else passes.
- Probed on production with simulated `authenticated` sessions
  (SET LOCAL ROLE + jwt claims), all rolled back: insert landed pending,
  self-approval refused, fn_join_club still pending/active as designed.

## Also shipped

- A failed create no longer strands the uploaded logo in `club-assets`
  (both failure paths: insert retries exhausted, owner-join cleanup).
- CreateClubModal's duplicate `CLUB_JOINED` emit removed — every subscriber
  refetched twice per created club.
- Advisors sweep: nothing club-flow actionable beyond the above; the three
  platform ERRORs (trivia view, spin view, PostGIS `spatial_ref_sys`) are
  outside this flow and left for their owners. `clubs` SELECT being
  `USING (true)` for everyone (treasury/rake figures included) is a real
  finding but a cross-app contract — flagged here, not changed unilaterally.

## For the next agent

- club*members now carries FOUR guard triggers that interact:
  `trg_approval_gate*_`(fires first alphabetically, may downgrade INSERT
status to pending) then`trg*four_club_limit*_` (skips pending rows,
  gates the approval transition). The interplay is intentional: a request
  does not count toward the limit until admitted.
- If you apply a migration via MCP, regenerate BOTH ci manifests in the
  same PR (`node scripts/ci/gen-schema-manifest.mjs`).
