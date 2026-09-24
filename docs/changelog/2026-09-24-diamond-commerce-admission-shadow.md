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

1. Four owner doors now consult admission on the server, after their own
   authorization and before they write anything:

   | Prospective owner action       | Door                                                                            | Admission action    |
   | ------------------------------ | ------------------------------------------------------------------------------- | ------------------- |
   | Approve a new club member      | `fn_review_join_request` (approve only, and only when a pending request exists) | `approve_member`    |
   | Open a new table               | `fn_cash_game_create`                                                           | `open_table`        |
   | Offer insurance on a new table | `fn_cash_game_create` when the insurance option is on                           | `club_insurance`    |
   | Create a tournament            | `fn_create_tournament`                                                          | `create_tournament` |
   | Create a recurring schedule    | `fn_upsert_tournament_schedule` (new schedules only)                            | `create_tournament` |

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
one of the four doors above. The following are existing obligations and are
never checked:

- Betting, dealing, seating, buy-ins, rebuys, add-ons, cash-outs, payouts,
  settlement, withdrawals and records (spec 1143).
- A player registering for a tournament, joining a waitlist or taking a seat.
- Members who are already approved. A downgrade or lapse never removes a
  member. Re-approving an active member is not an admission. Denying a
  request is never checked.
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

No trigger was added. The gate lives only in the four doors, and each door
refuses a caller who is not signed in. The D21 / D28 harness check (no
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

## Turning enforcement on later

Enforcement is a separate, recorded staff event:
`fn_ca_commerce_settings_set(NULL, NULL, <from>, false)`. Before switching it
on, read the shadow record:

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

- **Direct table writes bypass the doors.** The RLS policies
  `club_members_update` and `tables_insert_owner_or_admin` let a club admin
  write a member's status or insert a table through PostgREST without calling
  any door. Before enforcement, those browser privileges need to move behind
  the doors. A trigger is not the answer (D21, D28).
- **Joins without owner approval are not admissions.** A player joining an
  open club (`requires_approval = false`), or redeeming an invite, joins
  without an owner approval. Those joins are player actions and are not
  checked. They do count in the roster, so the next owner approval sees them.
- **Games in a union's house club are checked against that club.** The club's
  own trial or capacity applies, not the union's. Shadow data will show
  whether a union mapping is needed before enforcement.
- **Client copy.**
  - `TOURNAMENT_CREATE_ERRORS` and the schedule error map need an
    `operating_access_required` entry, which should use the `message` field.
  - `tests/unit/cashGamesVocabulary.test.ts` (`LIVE_REFUSALS`) needs a row
    for the new cash sentence.

  Until then, the tournament and schedule surfaces show their generic
  fallback. That can only happen after enforcement is switched on.

## Proof

`PG_BIN=/usr/lib/postgresql/16/bin python3 tests/sql/run-diamond-club-commerce-admission.py`

The harness checks:

- The fixture is byte-identical to production.
- Each of the eight scenarios fails on a copy without the migration and
  passes with it.
- The migration's safety cases hold: a double apply, enforcement already on,
  a moved anchor, a concurrent change, and doors that only gain lines.
- The original 155-scenario commerce harness still passes with the migration
  on top.

The scope lock was proved separately: without it, two concurrent approvals
for the last seat both landed (61 of 60).
