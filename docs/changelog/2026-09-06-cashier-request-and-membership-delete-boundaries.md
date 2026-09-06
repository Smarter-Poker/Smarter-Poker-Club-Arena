# Cashier request, membership-departure, and club-retirement boundaries (2026-09-06)

## The audit findings

A read-only production impersonation proved that `chip_requests` had two
permissive SELECT policies. The newer `cashier_chip_requests_read` policy was
correct, but the older `chip_requests_read` policy was still present and
PostgreSQL ORed the two. One request was consequently readable by 46 unrelated
agents, 18 unrelated sub-agents, and 3 unrelated super-agents.

The same audit found authenticated DELETE access on `club_members`. A direct
row deletion bypasses the conserved leave RPC and reaches the deleted-row
journal, which records the remaining wallet as a burn. At audit time, 1,915 of
1,924 active or approved production memberships had non-zero chip balances, so
this was a live financial-integrity boundary rather than a theoretical policy
shape concern.

## Changed

`supabase/migrations/20260906091646_cashier_requests_and_membership_deletes_are_server_owned.sql`
is an additive, lock-bounded, single-transaction repair.

The migration pre-acquires the club, membership, and request tables in canonical
writer order. This prevents live cashier traffic from forming a lock cycle while
the atomic schema repair is waiting to begin; the five-second acquisition budget
still rolls the whole attempt back under sustained load.

- It drops both chip-request policy names and creates exactly one authenticated
  SELECT policy. A row is visible only to its requester, its named approver, or
  a caller for whom `fn_club_cashier_scope` returns `all` (owner, co-owner, or
  admin).
- It removes every direct browser grant on `chip_requests`, then grants
  authenticated SELECT only. Server-owned service access is stated explicitly.
- It drops `club_members_delete` and revokes DELETE from PUBLIC, anon, and
  authenticated while preserving service-role deletion.
- It adds `fn_remove_settled_club_member`, which locks caller authorization and
  the member wallet, refuses departure while any chip, diamond, credit,
  agent-wallet, downline, live-seat, tournament, cashout, escrow, ticket, or
  chip-request dependency remains, then marks the retained row departed and
  inactive. It does not delete the membership or its role history.
- It closes direct browser deletion of `clubs` as well. The owner-facing
  `fn_retire_settled_club` verifies the caller and human-typed club name, checks
  all canonical union representations, locks every mutable account, and changes
  a settled standalone club to retained/read-only lifecycle state.
- `fn_club_retirement_impact` counts canonical chip/tournament/leaderboard
  liabilities, club/member diamonds, Promo Vault inventory, active games,
  credit invoices, and settlement obligations. The old deletion-impact name is
  a read-only compatibility alias; the obsolete hard-delete RPC is dropped.
- Lifecycle triggers prevent a stale gameplay, cashier, join, or direct-update
  path from reactivating a retired club or departed membership. Rejoining uses
  the same retained membership row through the canonical Join Club workflow.
- Physical club deletion is refused even to elevated callers unless the row is
  a reserved Crest certification fixture and both existing cleanup guards are
  active, or an explicit retirement-maintenance transaction is in progress.
- Union identity is resolved from the club pointer, the `union_clubs` junction,
  the `unions` identity row, and the replay-safe `is_union` field when present.
- Its post-apply block aborts the transaction if RLS is disabled, another
  browser-applicable policy survives, a browser write/delete grant remains, the
  canonical policy loses an authorization arm, required service access is
  lost, a lifecycle function loses its fixed execution boundary, or any table
  loses its retired-club write-freeze trigger.

Before: an unrelated agent-tier member could read another branch's chip
request, and a browser session could directly delete a membership row.

After: request visibility is requester/approver/full-scope only; real member and
club history is retained; and departure/retirement is a settled, server-owned
operation at both the RLS-policy and table-grant layers.

## Executable coverage

`tests/cashier-data-boundaries.test.ts` pins the transaction boundary, both
legacy-policy drops, the exact three read arms, browser read/write grants,
membership/club delete privilege closure, every server-side settlement guard,
typed confirmation forwarding, canonical value/union checks, lifecycle write
guards, record retention, service-role preservation, and fail-closed asserts.

Focused result at the time of this entry:

```text
npx vitest run tests/cashier-data-boundaries.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)
```

## Client wiring

The three unsafe direct-DML callers now use the server boundary:

- `ClubMemberManagement` describes the operation as marking a membership
  departed and explicitly says its membership/role history remains retained.
- `MembershipService.removeMember` calls `fn_remove_settled_club_member` and
  surfaces the server's exact refusal reason.
- `ClubsService.retireClub` forwards the name the human actually typed to
  `fn_retire_settled_club`; it never refetches the saved name as a confirmation
  bypass and never deletes the parent table.
- Club Settings uses retirement language, explains retained/read-only records,
  and keeps the dialog open with the server refusal visible after a failed try.

The existing self-leave path remains on `fn_member_leave_to_treasury`; this
change does not mislabel that narrower flow as the administrative-removal
contract.

## Deliberately not changed

- No production DDL was run and no live money mutation was executed.
- The separate trade-ledger policy/UI work was left to its independently
  reserved migration.
- No partial conservation or automatic write-off was introduced: an unsettled
  dependency is a refusal with a specific remediation message.
