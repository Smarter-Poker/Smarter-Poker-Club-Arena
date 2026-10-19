# 2026-09-27: The owner's operational notifications reach the Production Alerts task only

## What was wrong

`20260916111614_owner_operational_notification_destination.sql` routed every
operational notification addressed to the owner account (`fn_is_owner_operational_notification`:
financial incidents and attestations, engine-break results, guarantee-bank
shortfalls, the estate digest, Push Health, Horse Fleet and engine alerts) into
`operational_notification_destinations` and `operational_alert_events`. Then
`fn_capture_owner_notification_destination` returned `NEW`, so the same row was
still written into the owner's personal inbox and hidden by masking: a
RESTRICTIVE RLS policy, the `personal_notifications` view, and the push
mirror's `WHEN` predicate.

Measured 2026-09-27T23:35Z: 899 operational rows in the owner's
`public.notifications`, all 899 captured and receipted, 5 written in the
previous 24 hours. Masking held for the readers it was written for and not for
the others: the World Hub Realtime feed painted these rows until World Hub
#1996, and `get_unified_user_profile` / `get_user_cross_product_summary`
(SECURITY DEFINER) still count them and list the newest five for the owner.
The owner's rule is that operational content is never written to his personal
inbox at all, so the fix is to stop writing it, not to mask one more reader.

## The fix (migration 20260927235053, HELD)

1. **Store-only.** `fn_capture_owner_notification_destination` captures and
   records exactly as before, then returns `NULL`: the personal row is never
   written. The destination keeps the complete original; a pending receipt
   stays on the destination row, where `fn_retry_owner_notification_destination`
   and `fn_capture_owner_notification_history` retry it when they are called
   (nothing schedules them). Ordinary notifications, other recipients, and the
   owner's ordinary notices (welcome, settings, invoices, financial digests)
   are untouched.
2. **Authority.** A BEFORE trigger that returns `NULL` ends the INSERT for that
   row, so PostgreSQL applies neither row-level security's `WITH CHECK` nor
   any NOT NULL, foreign-key or primary-key check to it. Row-level security was
   the only thing refusing the public anon key: `anon` and `authenticated` hold
   INSERT on `notifications` and no INSERT policy admits them (the only one,
   "Service role inserts", is `TO service_role`). The first revision of this
   migration therefore let anyone holding that key write chosen content into
   the Production Alerts queue, and plant destination rows the readers below
   take as proof an alert was already delivered (review blockers 1 and 2). Now
   `zz_authorize_owner_operational_original`, a SECURITY INVOKER trigger that
   runs as the writer, after `trg_notification_fill_action_url` and
   `trg_sync_notification_read_state` and before the capture, and only for an
   owner-operational row, raises row-level security's own refusal
   (`42501 new row violates row-level security policy for table "notifications"`)
   whenever row-level security applies to the writer. `anon` and
   `authenticated`, which no INSERT policy admits, get exactly the error they
   got before. `pg_write_all_data` (no members) is refused before and after,
   now by the EXECUTE check on the classifier in the trigger's `WHEN`;
   `supabase_backup_admin`, which "Service role inserts" admits through its
   `service_role` membership, is now refused (stricter, never looser).
   `service_role` and every postgres-owned SECURITY DEFINER producer bypass
   row-level security and pass, as before. No role holds EXECUTE on the
   trigger's function: PostgreSQL does not check it when it fires a trigger.
3. **Validity.** The capture routes only a row PostgreSQL would have accepted:
   id, type and title present, the recipient and the actor (when set) naming a
   profile, and no notification already holding the id. Anything else falls
   through to `RETURN NEW`, PostgreSQL refuses it with its own 23502, 23503 or
   23505, and nothing is captured (review finding 4).
4. **Readers.** Three database readers used the personal row as proof of
   delivery and now also read the routed original, each by anchored
   substitution of its own live definition (pre/post md5, owner, ACL and
   settings asserted):
   - `fn_ca_break_scorecard_push` de-duplicates a break alert by its key;
   - `fn_notify_guarantee_bank_short` treats a routed copy the task has not
     picked up (its receipt still `new`, or still pending) the way it treated
     an unread personal copy: outstanding, so the shortfall is not recorded
     again. Once the task picks the receipt up (any other status) the next
     shortfall is recorded (review finding 8: before, a shortfall re-armed
     only when every earlier receipt was closed);
   - `fn_ca_alarm_drill` arm 4 counts a routed original as the notification a
     critical raise must produce.
5. **Detection.** `zz_owner_operational_original_reached_personal_inbox`
   (AFTER INSERT, `WHEN` the classifier matches) can only fire if an
   owner-operational row reaches the inbox anyway. It records
   `OwnerOperationalOriginalReachedPersonalInbox` in `operational_alert_events`
   with `payload.target_task_id`, and never repairs. It does not swallow a
   recorder failure, so in a double fault (the capture bypassed and the
   recorder failing) the INSERT is refused rather than landing unrecorded
   (review finding 10). It watches INSERT only.
6. **The install proves itself** in rolled-back subtransactions: as the
   installer, a synthetic owner `financial_incident` writes no personal row
   and one receipted destination; as `anon` and as `authenticated` it is
   refused with row-level security's error by the new trigger.

The install refuses (and changes nothing) unless `notifications` still has
what the authority and validity clauses were written for: row-level security
enabled and not forced with "Service role inserts" as its only INSERT policy;
NOT NULL on exactly id, user_id, type and title; the primary key, the two
foreign keys to `profiles` and its four partial unique indexes (none of which
can match an owner-operational row); and no BEFORE INSERT trigger firing
between the authority check and the capture. Each guard was evaluated
read-only against production on 2026-09-28 (UTC) and passes there.

## Order

1. World Hub PR "notify() confirms a routed original by the id it chose",
   deployed and live. After this migration an INSERT ... RETURNING of a routed
   original returns no row: the old `notify()` reports that as a failed
   delivery (the capture itself stands) and the old push-health cooldown,
   which looks for the owner's personal row, would alert again on every run.
   Nothing in the database can see the gateway, so this order is the
   installer's to keep (review finding 5).
2. This migration, outside :50-:03 UTC. One transaction, one PostgREST schema
   reload (about 28 s).
3. The held cleanup `20260928000622`.

## Regression protection

`scripts/dev/probe-owner-inbox-store-only.sh` builds a throwaway PostgreSQL
cluster that is production as it stands before this migration: `postgres` is
not a superuser (it bypasses row-level security, as in production), Supabase's
default privileges, the grants, policies, constraints, partial unique indexes
and both normalizing BEFORE INSERT triggers of `notifications`, a `profiles`
key for the foreign keys, and 16 functions pinned to the md5 of
`pg_get_functiondef` that production returns. It refuses to run if any of that
drifts (exit 2). It reproduces the defect (red), shows what row-level security
and the constraints refuse today, applies the migration, and asserts the
behaviour above (green): each refusal with nothing stored; the trigger shown
necessary (disabled, anon's row is captured); service_role and a SECURITY
DEFINER producer called by anon or authenticated routed; the capture without
its validity clause shown to accept what PostgreSQL refuses; each reader's
pre-image shown to fail; every guard's refusal; a refused second run.
`.github/workflows/owner-inbox-store-only.yml` runs it on every pull request
touching the migration, the probe, its fixture or the schema-manifest fragment.

A mutation pass rebuilt the migration, fixture and probe with one new clause
removed at a time (every md5 pin recomputed, so only behaviour differed) and
ran the probe: every clause is pinned except `NEW.type IS NOT NULL`, which
cannot change behaviour while the classifier is false for a NULL type. The
table is in
`docs/production-alerts/evidence/owner-inbox-operational-rows/README.md`.

`scripts/ci/schema-manifest.d/owner-inbox-store-only-delivery.json` declares
the two trigger functions this held migration creates, so
`check-migrations-applied` reports them as PROMISED instead of failing the
pull request (review blocker 3). The nightly schema-manifest refresh goes red
if the file reaches `main` and the migration is not installed within a day,
which is the right alarm for a held migration.

## Follow-up owned elsewhere (review finding 6)

These qualifications still describe the pre-store-only capture (`RETURN NEW`)
and pass only because they install their own pinned copy of it. After this
migration is installed they must be refreshed from the installed component by
their owners:

- Club Arena
  `scripts/ci/probes/production-alert-core/inputs/owner-notification-component.sql`
  lines 141-156: the capture, with `RETURN NEW` at line 154.
- Club Arena
  `scripts/ci/probes/production-alert-core/notification/inputs/owner-notification-catalog-postimage.sql`
  line 15: the capture's body md5 `64b403e0568e933dba4918a09b9b0ace`, which
  production no longer carries.
- Club Arena
  `scripts/ci/probes/production-alert-core/inputs/owner-notification-qualification.sql`
  lines 169-170 (every case, routed ones included, is read back from
  `public.notifications` with `INTO STRICT`) and 181-182 (the personal row must
  equal its captured original).
- Club Arena `scripts/qualification/production-alert-core-connected.sql`
  lines 224-231 (two routed incident notifications must exist in
  `notifications`) and 235-242 (the owner-view check is built from those rows
  and passes vacuously without them); run by `ci.yml` through
  `scripts/ci/test-production-alert-core-postgres.py`.
- World Hub `supabase/components/owner-operational-notification-destination.sql`
  lines 141-156 (`RETURN NEW` at line 154) and its qualifier
  `scripts/qualification/owner-operational-notification-destination.sql`
  lines 169-170 and 181-182, the same assertions as the Club Arena copy.

The dated snapshots under `tests/fixtures/union-provider-preimages-20260917/`
and `tests/fixtures/tournament-fee-lifecycle/current-settlement-catalog.json`
also carry the capture's pre-image md5; they describe 2026-09-17 and are not
gates.
