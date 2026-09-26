# 2026-09-24 - a member's club status is changed only by the server

## What changed

- `supabase/migrations/20260924045900_member_status_is_changed_only_by_the_server.sql`
  adds `fn_club_set_member_status(club, user, status, reason)` (SECURITY DEFINER,
  EXECUTE for authenticated only) and `trg_club_members_status_guard`, which refuses
  any browser write of `club_members.status` that did not come through that function.
  The trigger is declared in `ca_declared_money_triggers` in the same migration,
  because `club_members` is a watched money table.
- `MembershipService.updateStatus` calls the RPC instead of updating the row. It keeps
  every guarantee #5171 added: it throws unless the server reports success and names
  exactly the status that was asked for, the refusal text is the server's own (Title
  Case), and `CLUB_UPDATED` is announced only after a confirmed change (not for a
  confirmed no-op). #5171's other changes in that file (such as removing `addMember`)
  are kept.
- `ClubMemberManagement` Ban and Unban call
  `MembershipService.updateStatus(clubId, memberId, currentlyBanned ? 'active' : 'banned')`
  and show the server's refusal. Before this, they wrote the status column directly,
  and the new guard would have refused every Ban and Unban.
- ClubDetailPage's Suspend shows the server's reason when a suspension is refused.

## Why

RLS let a member update their own `club_members` row, and `authenticated` holds column
UPDATE on `status`. In any club that does not require approval, a suspended or banned
member could set themselves back to `active` with one PATCH, and nothing recorded who
suspended them or why.

## Evidence

- `scripts/ci/test-member-status-server-owned.py` (new CI step): 43 cases passed
  on a local PostgreSQL 16 cluster. CI runs it on 17. The cases cover reproducing
  the defect, installing, refusing a re-apply, the trigger declaration, the refusals
  and the admissions.
- `tests/unit/memberStatusIsServerOwned.test.ts`,
  `tests/unit/memberStatusChangeNeedsAChangedRow.test.ts` (#5171's pins moved onto the
  RPC answer), `tests/components/clubMemberBanGoesThroughTheServer.test.tsx` (fails on
  the direct-write panel, passes now), and
  `tests/unit/theDashboardCountsWhatIsThere.test.ts` (the Ban pin now requires the
  service call).

## Behaviour to note

An `approved` member asked to be `active` is answered `approved` by the server with
nothing changed. The client treats that as not confirmed and throws, because it is not
exactly the status asked for. No current screen sends that request.

## Pending

- Install the migration on production (it refuses to install if any listed server
  writer of `club_members.status` is not SECURITY DEFINER owned by postgres).
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`memberStatusServerOwnedIntegration`).
