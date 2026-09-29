# 2026-09-24 - one club membership cap: one count, one lock, one limit

## What changed

- `supabase/migrations/20260908125235_a_player_may_belong_to_ten_clubs.sql` records the
  production statement of 2026-09-08 that raised the cap from 4 to 10. The statement is
  byte for byte what was applied and is recorded only. It must never be applied again.
- `supabase/migrations/20260922153234_one_club_membership_cap_one_count_one_lock.sql`
  states the cap once (`fn_club_membership_cap()`, 10), counts one way
  (`fn_club_membership_count`: active or approved, lifecycle active), takes one player
  lock (`fn_club_membership_lock`, the key the create path already used) and moves the
  create_club rollout rule into `fn_club_creation_open`. The four enforcing functions are
  edited by exact substitution and each takes the player lock before it counts. The
  preflight `fn_get_club_creation_eligibility` is rebuilt on the same helpers and says
  why creation is refused (`creation_unavailable` or `membership_cap`).
- Client: `ClubsService.getClubCreationEligibility` and `CreateClubModal` render the
  server's cap, count and reason and keep no number of their own. VIPPage and the
  create-error copy repeat the cap the server stated.

## Why

The 4 to 10 change missed the preflight, which still said 4. A player in 4 to 9 clubs
was told their allowance was full while the server would have created the club. Only
the create path held a lock, so two joins at 9 memberships could both land (11).

## Evidence

- `scripts/ci/test-club-membership-cap.py` (new CI step): 78 cases passed on a local
  PostgreSQL 16 cluster. CI runs it on 17.
- `tests/one-club-membership-cap.law.test.ts` (with `docs/laws.d/one-club-membership-cap.md`),
  `tests/unit/ClubsService.test.ts`, `tests/club-create-phase2.test.ts`,
  `tests/the-lobby-action-bar-actually-works.test.ts`.

## Pending

- Install 20260922153234 on production. 20260908125235 is already installed; do not
  re-apply it.
- The cash qualification pin for `.github/workflows/ci.yml` is updated
  (`clubMembershipCapIntegration`).
