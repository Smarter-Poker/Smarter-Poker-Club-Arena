# owner-inbox-operational-rows: store-only delivery (evidence)

Incident key `owner-inbox-operational-rows`, Production Alerts board #5070, lane PRIMARY-CHAT.
Public repository: counts, table names, role names and function names only.

## Measured on production (read-only), 2026-09-27

| Measurement                                                                      | Value                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Operational rows (classifier) in the owner account's `public.notifications`      | 899                                                                             |
| Rows of the handoff's operational type list (includes 5 ordinary system notices) | 904                                                                             |
| Operational rows written in the previous 24 h (newest 15:40Z)                    | 5                                                                               |
| Captured in `operational_notification_destinations` / with a matching receipt    | 899 / 899                                                                       |
| Captured originals whose only difference from the personal row is read state     | 17                                                                              |
| `ca_incident_recipients` active                                                  | 1 (the owner account)                                                           |
| Live readers that bypass RLS and read the owner's rows                           | `get_unified_user_profile`, `get_user_cross_product_summary` (SECURITY DEFINER) |

## What production's authority looks like (read-only, 2026-09-28 UTC)

| Fact                                                      | Value                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Server                                                    | PostgreSQL 17.6                                                                                                                   |
| `notifications` row-level security                        | enabled, not forced; owner `postgres`                                                                                             |
| `notifications` grants                                    | `anon` and `authenticated` arwdxtm, `service_role` arwdDxtm (Supabase default privileges)                                         |
| INSERT (or ALL) policies on `notifications`               | one: "Service role inserts", permissive, `TO service_role WITH CHECK (true)`                                                      |
| Roles holding INSERT on `notifications`                   | `anon`, `authenticated`, `pg_write_all_data` (no members), `postgres`, `service_role`, `supabase_admin`, `supabase_backup_admin`  |
| Of those, bypassing row-level security                    | `postgres`, `service_role`, `supabase_admin` (superuser)                                                                          |
| Subject to row-level security but admitted by a policy    | `supabase_backup_admin` (member of `service_role`)                                                                                |
| BEFORE INSERT row triggers, in firing order               | `trg_notification_fill_action_url`, `trg_sync_notification_read_state`, `zz_capture_owner_notification_destination`               |
| NOT NULL columns / constraints                            | id, title, type, user_id / primary key (id); user_id to `profiles(id)` ON DELETE CASCADE; actor_id to `profiles(id)`              |
| Other unique indexes                                      | 4, all partial, on the types `friend_request`, `home_group_friend_joined`, `daily_challenge`, `personal_assistant_audit_complete` |
| Every install guard of the migration, evaluated read-only | passes (capture trigger, capture last, authority policy set, trigger order, constraint set)                                       |

## md5 of `pg_get_functiondef` / `pg_get_triggerdef`

| Object                                                               | Production pre-image             | After the migration              |
| -------------------------------------------------------------------- | -------------------------------- | -------------------------------- |
| `fn_capture_owner_notification_destination()`                        | 765a320465a49f71c26c4b747d61f1fd | 32a9105ef11b28dceac0fce11d71148f |
| `fn_ca_break_scorecard_push(ca_break_scorecards)`                    | 0de54de4eee0f2cfee9a5fd9e1e368ff | 1c240cddb84994e906a4eb09d7ca3323 |
| `fn_notify_guarantee_bank_short(uuid)`                               | 0882ecfbd9a19479f7d6666daab3ea6b | 71d3444dfb4ed7906cfefe5267de5b81 |
| `fn_ca_alarm_drill()`                                                | 8b413171b63deabceaf13d15a2ff6ebf | 8bd6f37a4038209adaec7e2bbbdfd5e9 |
| `fn_authorize_owner_operational_original()` (new)                    | -                                | 7777ab6e22847595881843ebfacdcaad |
| trigger `zz_authorize_owner_operational_original` (new)              | -                                | 7f4ecd63db81d72271f9e25c09a8e69d |
| `fn_owner_operational_original_reached_personal_inbox()` (new)       | -                                | d648da8eb87a98e8074e91c8aca7c660 |
| trigger `zz_owner_operational_original_reached_personal_inbox` (new) | -                                | 2d1ee8300c484364c83db0496360b897 |
| capture without the validity clause (previous revision, probe-only)  | -                                | f35b8c2677dd42f5f8567406912a0497 |

The fixture's other twelve functions are pinned to production too (`auth.uid()`,
`fn_notification_action_url`, `fn_notification_fill_action_url`,
`sync_notification_read_state`, `fn_raise_notification`, the recorder pair and the
five other component functions); the probe refuses to run if any differs. PostgreSQL
16 prints each of them, and a `WHEN` trigger of the same shape as the new ones,
byte-identically to production's PostgreSQL 17.

## Hardening

1. Root cause: the capture returns `NULL`, so the personal row is never written; the
   authority and validity clauses keep refusing everything row-level security and
   the constraints refused before.
2. Regression test: `scripts/dev/probe-owner-inbox-store-only.sh` (output below),
   red before and green after on production's roles, privileges, policies and
   constraints.
3. Invariant in the owning layer: `zz_authorize_owner_operational_original` and the
   capture, both on `public.notifications`, plus install guards that refuse a
   database the clauses were not written for.
4. Detection: `zz_owner_operational_original_reached_personal_inbox` records
   `OwnerOperationalOriginalReachedPersonalInbox` (source `owner-inbox-routing-guard`,
   `payload.target_task_id` = fleet task) if a row ever reaches the inbox anyway.
5. CI gate: `.github/workflows/owner-inbox-store-only.yml` runs the probe on every
   pull request touching the migration, the probe, its fixture or the
   schema-manifest fragment.

## Mutation pass

Each row rebuilds the migration, fixture and probe with one new clause removed (every
md5 pin recomputed from the mutated text, so only behaviour differs) and runs the
probe. The generator and driver are scratch tools kept outside the repository.

| Clause removed                                         | Probe | Caught by                                                                             |
| ------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------- |
| none (baseline)                                        | 0     | -                                                                                     |
| authority `RAISE` (replaced by `NULL`)                 | 1     | the migration's own install check: "anon was not refused"                             |
| authority `RAISE` and the install check                | 1     | anon, authenticated and the non-bypassing `service_role` member are no longer refused |
| validity `NEW.id IS NOT NULL`                          | 1     | a NULL id is refused by the destination insert, not with `notifications`' own error   |
| validity `NEW.type IS NOT NULL`                        | 0     | not pinnable: the classifier is already false for a NULL type (equivalent mutant)     |
| validity `NEW.title IS NOT NULL`                       | 1     | a NULL title is accepted                                                              |
| validity recipient has a profile                       | 1     | a recipient with no profile is accepted                                               |
| validity actor has a profile                           | 1     | an unknown actor is accepted                                                          |
| validity no notification holds the id                  | 1     | an id already in `notifications` is accepted                                          |
| bank `coalesce(e.investigation_status, 'new') = 'new'` | 1     | `investigating` and `verified_fixed` no longer let the next shortfall be recorded     |

## Probe output (local PostgreSQL 16.13, 2026-09-27)

```
fixture: all four pre-images and 12 other functions equal production
fixture: roles, default privileges, grants, policies, constraints and BEFORE INSERT triggers equal production
PASS  the schema-manifest fragment promises exactly the functions this migration creates (fn_authorize_owner_operational_original fn_owner_operational_original_reached_personal_inbox)
RED   before the migration an operational notification wrote the owner's personal row (1 row): the defect reproduces
PASS  before: anon writing an owner-operational row is refused by row-level security (42501, nothing stored)
PASS  before: authenticated (as the owner) writing one is refused by row-level security (42501, nothing stored)
PASS  before: a member of pg_write_all_data is refused by row-level security (42501, nothing stored)
PASS  before: a service_role member that does not bypass row-level security is admitted by "Service role inserts" (ok)
PASS  before: a NULL title is refused (NOT NULL) (23502, nothing stored)
PASS  before: an unknown actor is refused (foreign key) (23503, nothing stored)
PASS  before: an id already in notifications is refused (primary key) (23505, nothing stored)
PASS  before: a recipient with no profile is refused (foreign key) (23503, nothing stored)
PASS  before: a NULL type is refused (NOT NULL) (23502, nothing stored)
PASS  before: a NULL id is refused, by the capture's own destination insert (23502, nothing stored)
PASS  install refused: notifications gains a CHECK the validity clause does not know (refused: NOTIFICATIONS_CONSTRAINTS_CHANGED; nothing changed)
PASS  install refused: an INSERT policy admits authenticated (refused: NOTIFICATIONS_INSERT_AUTHORITY_CHANGED; nothing changed)
PASS  install refused: a BEFORE INSERT trigger would fire between the authority check and the capture (refused: OWNER_AUTHORITY_NOT_NEXT_TO_CAPTURE; nothing changed)
PASS  migration applied to the production pre-images, its install checks included
PASS  capture post-image md5 (32a9105ef11b28dceac0fce11d71148f)
PASS  scorecard post-image md5 (1c240cddb84994e906a4eb09d7ca3323)
PASS  bank post-image md5 (71d3444dfb4ed7906cfefe5267de5b81)
PASS  drill post-image md5 (8bd6f37a4038209adaec7e2bbbdfd5e9)
PASS  authority function md5 (7777ab6e22847595881843ebfacdcaad)
PASS  authority trigger md5 (7f4ecd63db81d72271f9e25c09a8e69d)
PASS  detector function md5 (d648da8eb87a98e8074e91c8aca7c660)
PASS  detector trigger md5 (2d1ee8300c484364c83db0496360b897)
PASS  BEFORE INSERT order: normalize, normalize, authority, capture (trg_notification_fill_action_url,trg_sync_notification_read_state,zz_authorize_owner_operational_original,zz_capture_owner_notification_destination)
PASS  the authority function is SECURITY INVOKER and nobody but its owner may EXECUTE it (false {postgres=X/postgres} false false false)
PASS  @live-proof 1 (true)
PASS  @live-proof 2 (true)
PASS  @live-proof 3 (true)
PASS  @live-proof 4 (true)
PASS  @live-proof 5 (true)
PASS  @live-proof 6 (true)
PASS  @live-proof 7 (true)
PASS  owner operational notification writes no personal row (0)
PASS  its original is captured once (1)
PASS  its receipt is recorded, addressed to the fleet task (1)
PASS  a redirected INSERT ... RETURNING returns no row (0)
PASS  owner Push Health Alert is routed (0)
PASS  owner ordinary system notice stays in the inbox (1)
PASS  owner invoice stays in the inbox (1)
PASS  another recipient keeps its operational notification (1)
PASS  anon writing an owner-operational row is refused with row-level security's error, by the new trigger (42501, nothing stored)
PASS  authenticated (as the owner) writing one is refused the same way (42501, nothing stored)
PASS  a member of pg_write_all_data is still refused, now by the EXECUTE check on the trigger's WHEN (42501, nothing stored)
PASS  a service_role member that does not bypass row-level security is now refused (stricter, never looser) (42501, nothing stored)
PASS  service_role writing one is routed (no personal row, one receipted destination) (ok|0|1)
PASS  a postgres-owned SECURITY DEFINER producer called by anon is routed (ok|0|1)
PASS  a postgres-owned SECURITY DEFINER producer called by authenticated is routed (ok|0|1)
PASS  necessity: with zz_authorize_owner_operational_original disabled, anon's row IS stored and receipted for the task (ok|1)
PASS  with the trigger enabled again anon is refused again (42501, nothing stored)
PASS  a NULL title is refused with PostgreSQL's own NOT NULL error (23502, nothing stored)
PASS  an unknown actor is refused with PostgreSQL's own foreign-key error (23503, nothing stored)
PASS  an id already in notifications is refused with PostgreSQL's own primary-key error (23505, nothing stored)
PASS  a recipient with no profile is refused with PostgreSQL's own foreign-key error (23503, nothing stored)
PASS  a NULL type is refused with PostgreSQL's own NOT NULL error (the classifier already excludes it) (23502, nothing stored)
PASS  a NULL id is refused with PostgreSQL's own NOT NULL error on notifications (23502, nothing stored)
PASS  an actor that exists is routed (ok|0|1)
PASS  the capture without its validity clause is the previous revision's post-image (f35b8c2677dd42f5f8567406912a0497)
PASS  necessity: without it a NULL title is accepted and captured (ok)
PASS  necessity: without it an unknown actor is accepted and captured (ok)
PASS  necessity: without it an id already in notifications is accepted and captured (ok)
PASS  necessity: without it a recipient with no profile is accepted and captured (ok)
PASS  necessity: without it a NULL id is refused by the destination insert, not with notifications' own error (23502|null value in column "notification_id" of relation "operational_notification_destinations" violates not-null constraint|fn_capture_owner_notification_destination)
PASS  restored post-image capture (32a9105ef11b28dceac0fce11d71148f)
PASS  break alert is routed once across two rescorings (1)
PASS  break alert writes no personal row (0)
PASS  necessity: the pre-image scorecard repeats a routed break alert (2)
PASS  restored post-image scorecard routes it once again (1)
PASS  owner shortfall is routed once while its receipt is 'new' (1)
PASS  the club owner keeps one personal shortfall notice (1)
PASS  once the task picks the receipt up ('investigating') the next shortfall is recorded (2)
PASS  the newer receipt, still 'new', holds it outstanding again (2)
PASS  a receipt the task closed ('verified_fixed') lets the next shortfall be recorded (3)
PASS  a pending receipt (none recorded yet) holds it outstanding too (3)
PASS  shortfalls write no owner personal row (0)
PASS  necessity: the pre-image bank reader repeats a routed shortfall (2)
PASS  restored post-image bank reader routes it once again (1)
PASS  alarm drill arm 4 passes on a routed original (true|)
PASS  necessity: the pre-image drill reports the routed raise as silent (false|raise did not notify)
PASS  restored post-image drill passes arm 4 again (true|)
PASS  with the capture disabled the row reaches the inbox (1)
PASS  the detector records it for the fleet task (1)
PASS  the detector does not fire for ordinary rows (1)
PASS  a second run is refused by its pre-image guard
RESULT: red before, green after - all assertions passed
exit 0
```
