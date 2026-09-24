# Club And Union Diamond Costs: Admission Is Wired, In Shadow

Date: 2026-09-24. Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 2.3,
4.3, 6.3 and D21, D22, D28, D52, D53.

Migration: `supabase/migrations/20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql`.
Harness: `tests/sql/run-diamond-club-commerce-admission.py`.

## What was wrong

`fn_ca_commerce_admission` (installed by `20260922143541`) answered whether a
club or union may admit a new discretionary operation, but no door asked it.
It also answered any signed-in caller about any scope, so one owner could read
another club's roster count and capacity.

## What changes

1. Seven doors now consult admission on the server, after their own
   authorization and before they write anything:

   | Prospective action                              | Door                                                                            | Admission action    |
   | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------- |
   | Approve a new club member                       | `fn_review_join_request` (approve only, and only when a pending request exists) | `approve_member`    |
   | A player joins a club that admits automatically | `fn_join_club` (a new or returning member only; never the owner)                | `join_member`       |
   | An invite link admits a pending member          | `fn_redeem_club_invite_code` (pending only)                                     | `join_member`       |
   | An agent or club staff adds a player            | `fn_agent_attach_player` (a new or pending player only)                         | `approve_member`    |
   | Open a new table                                | `fn_cash_game_create`                                                           | `open_table`        |
   | Offer insurance on a new table                  | `fn_cash_game_create` when the insurance option is on                           | `club_insurance`    |
   | Create a tournament                             | `fn_create_tournament`                                                          | `create_tournament` |
   | Create a recurring schedule                     | `fn_upsert_tournament_schedule` (new schedules only)                            | `create_tournament` |

   Why four member doors and not one: on 2026-09-24, 3 of the 5 live clubs
   admit members automatically (`requires_approval` false). In those clubs a
   join makes an approved member with no review at all, and an invite link
   promotes a pending join in the others without the owner. The first cut
   wired only the owner review, so most roster growth would never have been
   decided and capacity would have meant nothing for most clubs. The only
   client call of `fn_review_join_request` is in `ClubDetailPage.tsx`, which
   nothing imports (`tests/unit/orphanModuleRatchet.test.ts`), so the review
   door answers whichever client calls it; the member doors are the ones this
   client uses (`JoinClubModal`, `InvitePage`, `PlayerInviteModal`).

   Once enforced, a refused automatic join tells the player "This Club Is Full
   And Cannot Accept New Members Right Now. Please Contact The Club." (or
   "This Club Cannot Accept New Members Right Now. Please Contact The Club."
   without operating access) and writes nothing. A refused invite still
   attaches the invite and upline and leaves the member pending, so the owner
   decides at the review door. A refused agent add answers the owner sentence.
   Every join door takes the joining player's membership lock before the
   commerce scope lock (`fn_join_club_atomic` already holds it), and no path
   holding the scope lock asks for a membership lock, so the two cannot
   deadlock; two joins racing for the last seat land exactly one.

2. Every decision is recorded in `ca_commerce_admission_decisions`: scope,
   action, door, would_allow, enforced, allowed, reason, actor id, subject id
   (the applicant, for an approval), entitlement id, policy version, time. Ids
   only. Append only, not browser-readable, no foreign key to a hot table.

3. In shadow (today: `admission_enforced_from` is NULL) the action always
   proceeds. When platform staff set `admission_enforced_from` and it passes,
   a would-deny refuses before any write, in Title Case:
   - This Club Needs Active Operating Access To Approve New Members. Current Members Are Not Affected.
   - This Club Has Reached Its Member Capacity. Upgrade Capacity To Approve New Members. Current Members Are Not Affected.
   - This Club Needs Active Operating Access To Open A New Table. Running Tables Are Not Affected.
   - This Club Needs Active Operating Access To Create A New Tournament. Scheduled And Running Tournaments Are Not Affected.
   - This Club Needs The Insurance Module To Offer Insurance On A New Table. Existing Insurance Offers Are Not Affected.

   The JSON doors answer `{success:false, error, code:'operating_access_required'}`
   (member review, where the client shows `error`), or
   `{error:'operating_access_required', message, reason}` (tournament and
   schedule). The cash door raises the sentence itself, which the create flow
   shows verbatim.

4. `fn_ca_commerce_admission` answers only the club owner, co-owner or admin,
   the union owner or admin (including for a covered club), or platform staff.
   Anyone else gets `{"error":"access_denied"}`. Service role is unrestricted.
   The decision logic moved unchanged to the internal
   `fn_ca_commerce_admission_decide`; every answer now includes `would_allow`.

5. A decision that cannot be computed or recorded never blocks the owner (D28).
   It is logged as `decision_unavailable` and the action proceeds. Two
   approvals racing for the last seat serialize on the commerce scope lock, so
   only one can pass once enforcement is on.

## Existing obligations and new admissions

Spec 1137 asks for this distinction to be published. The admission check
applies only to a new operation that an owner or staff member starts through
one of the seven doors above. The following are existing obligations and are
never checked:

- Betting, dealing, seating, buy-ins, rebuys, add-ons, cash-outs, payouts,
  settlement, withdrawals and records (spec 1143).
- A player registering for a tournament, joining a waitlist or taking a seat.
- Members who are already approved. A downgrade or lapse never removes a
  member. Re-approving an active member, joining a club you are already in,
  reinstating a suspended member (`fn_club_set_member_status`) and moving a
  member between downlines (`fn_assign_player_to_agent`) are not admissions.
  Denying a request is never checked.
- Chip movements that happen to write a membership row (`fn_credit_chips`,
  `fn_transfer_chips`, table unlocks): money paths are never consulted.
- Tables that are already open and tournaments that are already created,
  including multi-day events and their stages (D52, D53).
- Recurring schedules that already exist, and every tournament they spawn.
  Editing, pausing or re-activating an existing schedule is not checked.
- Everything the engine or system writes: auto-spawned and feeder tables,
  table balancing, must-move mains (`fn_cash_cluster_open_table`), the
  scheduled spawner, seat-first boards (`fn_create_seat_first_game_atomic`),
  horse floor seeding and horse club joins. Horses are players (CLAUDE.md
  10.5): a horse's membership counts in the roster exactly like a human's.
  A horse joining is system plumbing, not an owner action, so the join itself
  is never checked.

No trigger was added. The gate lives only in the seven doors, each a browser
door behind its own authorization. The D21 / D28 harness check (no
commerce trigger on `tables`, `table_seats`, `tournaments`,
`tournament_players` or `club_members`) stays true. The migration also asserts
that no trigger function on those tables mentions commerce.

## How the doors were amended

The migration uses the anchor-insert pattern of `20260914120854`. For each
door it:

1. Reads the live body with `pg_get_functiondef`.
2. Checks that the anchor occurs exactly once, that the door's own
   authorization comes before it, and that the gate is not already there.
3. Runs the replacement.
4. Reads the body back and checks that removing the inserted text gives the
   original exactly, and that the ACL is unchanged.

A concurrent change elsewhere in a door body is kept. A change that moved an
anchor stops the migration. The harness proves both cases. The door bodies
were captured byte for byte from production on 2026-09-24
(`tests/fixtures/diamond-club-commerce-admission/live-doors.sql`).

The migration refuses to apply in these cases:

- `admission_enforced_from` is already set.
- `fn_ca_commerce_admission` no longer matches its installed md5.

It never sets `admission_enforced_from`.

## Commerce's reference on an accepted event (Prompt 1 contract)

Prompt 1's `20260924025555` records every tournament's acceptance in
`accepted_event_operations`, and its contract
(`docs/handoffs/club-arena-product-completion/CAPABILITY-CONTRACT.md`,
section 4 rule 4) asks commerce to record its plan or trial reference there.
`fn_create_tournament` now calls the internal
`fn_ca_commerce_record_event_basis` after the event is written. It replaces
only a basis the acceptance trigger wrote, keeps that basis inside as
`accepted_basis`, and records `operator_access` (`commerce_shadow` today,
`commerce` once enforced), `would_allow`, `reason`, `entitlement_id`, `trial`
and the policy version. It never raises (D28). Spawned and system
tournaments keep the trigger's own `legacy_free` basis. Rule 1 (an accepted
event continues through its conclusion) needs nothing more from commerce:
admission never checks an existing event, only a new one.

## The shadow report

`fn_ca_commerce_admission_report(p_days)` (platform staff or the service role)
answers, over 1 to 90 days, each door's decisions, would-deny, refused and
undecided counts, and the clubs a would-deny fell on with the reasons. The
Commerce Desk's Admission tab prints it (it ships with the desk pull
request), so the switch is made on evidence.

## Turning enforcement on later

Enforcement is a separate, recorded staff event:
`fn_ca_commerce_settings_set(NULL, NULL, <from>, false)`. Before switching it
on, read the Admission tab, or the shadow record directly:

```sql
SELECT action, reason, count(*) FILTER (WHERE would_allow IS FALSE) AS would_deny, count(*)
  FROM public.ca_commerce_admission_decisions
 WHERE decided_at > now() - interval '7 days'
 GROUP BY 1, 2 ORDER BY 1, 2;
```

## Open items (not closed by this migration)

- **Union back office tools (`union_tools`) have no door.** Every
  union RPC that a browser can call is one of these:
  - settlement or invoicing, which the spec says is never gated;
  - fund movement;
  - integrity or reconciliation, which are financial-integrity controls that
    must be preserved;
  - a read.

  Clubs are added to a union through service-role paths. A union back office
  admission point has to be defined with the union product before it can be
  wired.

- **Direct table writes bypass the doors.** Status changes are closed:
  production's `trg_club_members_status_guard` (20260924045900, another
  workstream) refuses any browser change of `club_members.status` outside
  `fn_club_set_member_status`. Two browser inserts remain before enforcement:
  `Users can join clubs` lets a player insert their own membership row
  directly (active in a club that admits automatically, without
  `fn_join_club`), and `tables_insert_owner_or_admin` lets a creator insert a
  `tables` row without `fn_cash_game_create`. Both browser privileges need to
  move behind the doors first. A trigger is not the answer (D21, D28).
- **Games in a union's house club are checked against that club.** The club's
  own trial or capacity applies, not the union's. Shadow data will show
  whether a union mapping is needed before enforcement.
- **Client copy.** The tournament, schedule and cash surfaces read
  `operating_access_required` and show the server's sentence
  (`TOURNAMENT_CREATE_ERRORS`, the schedule map, `cashGameCreateRefusalText`;
  `LIVE_REFUSALS` pins the cash sentence). The join modal and invite page
  already print a thrown join message, and the agent add already prints
  `error`. The test that pins every sentence on every surface,
  `tests/unit/commerceDeskAdmissionCopy.test.ts`, ships with the Commerce Desk
  pull request because it also covers the desk.

## Proof

`PG_BIN=/usr/lib/postgresql/16/bin python3 tests/sql/run-diamond-club-commerce-admission.py`

The harness checks:

- The fixture is byte-identical to production: all seven doors and the
  membership helpers they call (md5 of `pg_get_functiondef`). The two
  tournament doors were re-captured at 13:10 UTC after production's
  `20260924033701` and `20260924045822` amended them; both anchors held.
- Prompt 1's real `20260924025555` is installed first, as in production.
- Each of the eleven scenarios fails on a copy without the migration and
  passes with it, including the member doors in shadow and enforced, two
  joins racing for the last seat, the event basis and the staff report.
- The migration's safety cases hold: a double apply, enforcement already on,
  a moved anchor, a concurrent change, and doors that only gain lines.
- The original commerce harness (159 scenarios) still passes with the
  migration on top.

30 checks pass.

The scope lock was proved separately: without it, two concurrent approvals
for the last seat both landed (61 of 60).
