-- 20260920173943_anon_cannot_read_read_receipts_club_arena_messages_or_page_n.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ===========================================================================
-- THREE TABLES THE PUBLISHABLE KEY COULD STILL READ
--
-- .agent/audits/2026-08-26-anon-readable-tables.md found ~180 public tables
-- whose only SELECT policy is PERMISSIVE, granted to `public`, with
-- `qual = true`, next to an `anon` SELECT grant - so RLS gates nothing. It
-- deliberately shipped a triage list rather than a migration, because most of
-- those tables are a public poker-information site and revoking broadly would
-- break the product. Its item 2 named `social_message_reads` and its item 4
-- named `club_arena_messages`. This migration closes those two and
-- `page_notifications`, which has the same shape. Nothing else is touched.
--
-- READ FROM THE PRODUCTION CATALOGUE, 2026-09-20 (project kuklfnapbkmacvwxktbh,
-- inside BEGIN READ ONLY):
--
--   pg_policies
--     social_message_reads  "Users can view all read receipts"
--         PERMISSIVE {public} SELECT  qual = true
--     club_arena_messages   allow_read_messages
--         PERMISSIVE {public} SELECT  qual = true
--     page_notifications    page_notifications_select
--         PERMISSIVE {public} SELECT  qual = true
--   No RESTRICTIVE policy on any of the three.
--
--   pg_class.relacl, identical on all three:
--     {postgres=arwdDxtm/postgres, anon=rxt/postgres,
--      authenticated=rxt/postgres, service_role=arwdDxtm/postgres}
--   `r` is SELECT. There is no PUBLIC entry, so the grant that matters is
--   anon's own - the opposite of the function case in
--   20260919071318_anon_grant_from_public_is_the_one_that_mattered.sql. Both
--   grantees are named below anyway, because naming PUBLIC where there is no
--   PUBLIC grant is a no-op and naming it where there is one is the whole fix.
--
-- WHAT LEAKS TODAY. `social_message_reads` held 97 rows at the time of
-- reading, and every one of them was readable by an unauthenticated caller
-- holding only the publishable key that ships in the browser bundle: which
-- `user_id` read which `message_id`, and at what time. That is Messenger
-- read-receipt metadata - who is talking to whom, and when they looked - and
-- it sits directly beside the conversation content that
-- 20260914163500_messenger_readers_preserve_private_invoices_and_weekly_summaries
-- already closed on `social_messages`, `notifications` and
-- `accounting_invoice_deliveries`. The receipts were left behind.
-- `club_arena_messages` and `page_notifications` held 0 rows, so nothing
-- leaks from them today and every row leaks the moment they fill.
--
-- THE SHAPE OF THE FIX is the one the messenger migration established and is
-- not invented here: a narrow PERMISSIVE policy for `authenticated` that says
-- who may see the row, a RESTRICTIVE policy for `anon` that says `false`
-- whatever else permits, and no `anon` grant underneath either of them. Belt
-- and braces is deliberate: the neighbouring `accounting_invoice_deliveries`
-- carries the restrictive deny AND holds no anon privilege at all, and a
-- future permissive policy written by somebody else cannot re-open a table
-- whose RESTRICTIVE deny is still standing.
--
-- THE PREDICATES, each mirroring what the owning surface already uses:
--
--   social_message_reads - a receipt is yours, or it belongs to a message in a
--     conversation you are a participant of. The second half is character for
--     character the test `social_messages`' own "Users can view conversation
--     messages" policy applies (EXISTS over social_conversation_participants),
--     reached through the message the receipt points at. The subquery is
--     evaluated as the querying role, so `social_messages`' own RESTRICTIVE
--     stack applies inside it too: you see receipts for messages you can
--     actually read, which is tighter than the participant test alone and is
--     the correct answer. `user_id = auth.uid()` is first and unconditional,
--     so your own receipts never depend on it.
--
--   club_arena_messages - your own message, or a message in a club you are a
--     member of (club_members' "Members can read own club memberships" policy
--     makes that EXISTS satisfiable for an ordinary member), or you are an
--     admin. `public.is_admin()` is SECURITY DEFINER STABLE with
--     search_path=public and tests auth.uid() against profiles.role, it is
--     named by three policies already, and 20260919071318 revoked its EXECUTE
--     from PUBLIC and anon while keeping authenticated - so the disjunct
--     cannot reach an anonymous caller. It is here because
--     src/components/admin/ArenaLedger.tsx documents this table as an admin
--     audit feed; no file in src/ or pages/ issues a query against any of the
--     three tables today, which is why nothing in the client changes.
--
--   page_notifications - the table has no owner column at all; page_type is
--     one of venue/tour/series and page_id is text. public.page_claims carries
--     exactly that pair plus user_id and a status checked against
--     pending/approved/rejected, so an approved claimant of the page is the
--     only defensible reader. Nothing else on this database links the two.
--
-- WHAT IS NOT CHANGED. No write path: none of the three has an INSERT, UPDATE
-- or DELETE policy, and neither anon nor authenticated holds an INSERT grant,
-- so these rows are written by service_role and stay that way. No other
-- table's ACL or RLS. None of the three is a member of the supabase_realtime
-- publication (checked; only `notifications` of the neighbouring set is), so
-- no subscriber goes silent the way notifications did on 2026-09-08 -
-- tests/a-published-table-is-a-measured-decision.law.test.ts.
--
-- IDEMPOTENT-SAFE. Every policy is dropped IF EXISTS before it is created and
-- every REVOKE is a no-op once it has run, so a second application changes
-- nothing. The guard asserts the shape it depends on rather than assuming it,
-- and the proof block at the end asserts the outcome before COMMIT.
--
-- HOW TO TELL IT IS LIVE. This migration creates no catalogue object that
-- scripts/ci/check-migrations-are-live.mjs can look up by name, so it states
-- its own claims, run read-only against production every hour. See
-- tests/a-merged-migration-must-be-live.law.test.ts.
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('social_message_reads','club_arena_messages','page_notifications') AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND qual = 'true')
-- @live-proof: (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('social_message_reads','club_arena_messages','page_notifications') AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE' AND roles = '{anon}'::name[] AND qual = 'false') = 3
-- @live-proof: NOT has_table_privilege('anon', 'public.social_message_reads', 'SELECT') AND NOT has_table_privilege('anon', 'public.club_arena_messages', 'SELECT') AND NOT has_table_privilege('anon', 'public.page_notifications', 'SELECT')
-- @live-proof: has_table_privilege('authenticated', 'public.social_message_reads', 'SELECT') AND has_table_privilege('authenticated', 'public.club_arena_messages', 'SELECT') AND has_table_privilege('authenticated', 'public.page_notifications', 'SELECT')
-- ===========================================================================

-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL
-- policy). GRANT/REVOKE do not reload, but they belong to the same change and
-- must not land without the policies.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ── guard: refuse rather than guess ────────────────────────────────────────
-- Every assumption the predicates below rest on, asserted against the live
-- catalogue. A schema that has moved on underneath this file aborts the whole
-- transaction, so nothing reloads and no history row is written.
DO $guard$
DECLARE
  r record;
  v_missing text;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['social_message_reads','club_arena_messages','page_notifications']) AS name
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = r.name
         AND c.relkind = 'r' AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'anon_read_fix_table_authority_changed: % is not an RLS-enabled table in public', r.name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = r.name AND cmd <> 'SELECT'
    ) THEN
      RAISE EXCEPTION 'anon_read_fix_write_policy_appeared: % now carries a non-SELECT policy this migration did not measure', r.name;
    END IF;
  END LOOP;

  -- The columns each predicate reads, including the ones on the tables it
  -- joins. A renamed column would otherwise surface as a policy that silently
  -- matches nothing.
  SELECT string_agg(want.rel || '.' || want.col, ', ') INTO v_missing
    FROM (VALUES
      ('social_message_reads','user_id'), ('social_message_reads','message_id'),
      ('social_messages','id'), ('social_messages','conversation_id'),
      ('social_conversation_participants','conversation_id'), ('social_conversation_participants','user_id'),
      ('club_arena_messages','user_id'), ('club_arena_messages','club_id'),
      ('club_members','club_id'), ('club_members','user_id'),
      ('page_notifications','page_type'), ('page_notifications','page_id'),
      ('page_claims','page_type'), ('page_claims','page_id'),
      ('page_claims','user_id'), ('page_claims','status')
    ) AS want(rel, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = want.rel AND a.attname = want.col
        AND a.attnum > 0 AND NOT a.attisdropped
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'anon_read_fix_column_authority_changed: %', v_missing;
  END IF;

  -- is_admin() must still be the definer that asks who is calling, and must
  -- still be closed to anon, or the club disjunct below is not safe to write.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
       AND p.prosecdef AND p.provolatile = 's'
       AND p.proconfig = ARRAY['search_path=public']
       AND p.prosrc LIKE '%auth.uid()%'
  ) OR has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon_read_fix_is_admin_authority_changed';
  END IF;

  -- Neither browser role may be a back door into service_role or BYPASSRLS,
  -- or none of this is standing on anything.
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN ('anon','authenticated')
       AND (rolsuper OR rolbypassrls OR pg_has_role(rolname, 'service_role', 'USAGE'))
  ) THEN
    RAISE EXCEPTION 'anon_read_fix_client_role_bypasses_rls';
  END IF;
END
$guard$;

-- ── social_message_reads ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view all read receipts" ON public.social_message_reads;
DROP POLICY IF EXISTS social_message_reads_visible_to_conversation ON public.social_message_reads;
CREATE POLICY social_message_reads_visible_to_conversation
  ON public.social_message_reads AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1
        FROM public.social_messages m
        JOIN public.social_conversation_participants p
          ON p.conversation_id = m.conversation_id
       WHERE m.id = social_message_reads.message_id
         AND p.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS messenger_no_anonymous_read_receipts ON public.social_message_reads;
CREATE POLICY messenger_no_anonymous_read_receipts
  ON public.social_message_reads AS RESTRICTIVE FOR SELECT TO anon USING (false);

-- ── club_arena_messages ────────────────────────────────────────────────────
DROP POLICY IF EXISTS allow_read_messages ON public.club_arena_messages;
DROP POLICY IF EXISTS club_arena_messages_visible_to_club ON public.club_arena_messages;
CREATE POLICY club_arena_messages_visible_to_club
  ON public.club_arena_messages AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.club_id = club_arena_messages.club_id
         AND cm.user_id = (SELECT auth.uid())
    )
    OR public.is_admin()
  );

DROP POLICY IF EXISTS club_arena_messages_no_anonymous_read ON public.club_arena_messages;
CREATE POLICY club_arena_messages_no_anonymous_read
  ON public.club_arena_messages AS RESTRICTIVE FOR SELECT TO anon USING (false);

-- ── page_notifications ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS page_notifications_select ON public.page_notifications;
DROP POLICY IF EXISTS page_notifications_visible_to_page_claimant ON public.page_notifications;
CREATE POLICY page_notifications_visible_to_page_claimant
  ON public.page_notifications AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.page_claims pc
       WHERE pc.page_type = page_notifications.page_type
         AND pc.page_id = page_notifications.page_id
         AND pc.user_id = (SELECT auth.uid())
         AND pc.status = 'approved'
    )
  );

DROP POLICY IF EXISTS page_notifications_no_anonymous_read ON public.page_notifications;
CREATE POLICY page_notifications_no_anonymous_read
  ON public.page_notifications AS RESTRICTIVE FOR SELECT TO anon USING (false);

-- ── the grant underneath ───────────────────────────────────────────────────
-- The restrictive policies above already deny anon. Removing the privilege as
-- well is what `accounting_invoice_deliveries` looks like after the messenger
-- migration, and it means a permissive policy somebody adds later cannot
-- reach anon through `TO public`. SELECT is the one that leaked; REFERENCES
-- and TRIGGER are the rest of anon's `rxt` and are inert for a role that can
-- neither create in the schema nor own the table. PUBLIC is named alongside
-- anon in every statement (tests/a-revoke-from-anon-must-name-public.law.test.ts:
-- there is no PUBLIC entry in relacl here, so it is a no-op, and a no-op is
-- cheaper than the day it is not).
REVOKE SELECT, REFERENCES, TRIGGER ON TABLE public.social_message_reads FROM PUBLIC, anon;
REVOKE SELECT, REFERENCES, TRIGGER ON TABLE public.club_arena_messages  FROM PUBLIC, anon;
REVOKE SELECT, REFERENCES, TRIGGER ON TABLE public.page_notifications   FROM PUBLIC, anon;

-- ── prove it before committing ─────────────────────────────────────────────
DO $prove_it$
DECLARE
  three constant text[] := ARRAY['social_message_reads','club_arena_messages','page_notifications'];
  v_open int;
  v_denied int;
  v_anon int;
  v_auth int;
  v_service int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = ANY(three)
     AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND qual = 'true';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'still % permissive SELECT policy(ies) with qual = true on the three', v_open;
  END IF;

  SELECT count(*) INTO v_denied
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = ANY(three)
     AND cmd = 'SELECT' AND permissive = 'RESTRICTIVE'
     AND roles = '{anon}'::name[] AND qual = 'false';
  IF v_denied <> 3 THEN
    RAISE EXCEPTION 'expected a restrictive anon deny on each of the three, found %', v_denied;
  END IF;

  SELECT count(*) INTO v_anon
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY(three)
     AND has_table_privilege('anon', c.oid, 'SELECT');
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'anon still selects % of the three - look for another route than anon or PUBLIC', v_anon;
  END IF;

  -- The wider revoke must not have reached the roles the product runs as.
  SELECT count(*) INTO v_auth
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY(three)
     AND NOT has_table_privilege('authenticated', c.oid, 'SELECT');
  IF v_auth <> 0 THEN
    RAISE EXCEPTION 'authenticated lost SELECT on % of the three; revoking PUBLIC must not reach it', v_auth;
  END IF;

  SELECT count(*) INTO v_service
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY(three)
     AND NOT (has_table_privilege('service_role', c.oid, 'SELECT')
          AND has_table_privilege('service_role', c.oid, 'INSERT')
          AND has_table_privilege('service_role', c.oid, 'UPDATE')
          AND has_table_privilege('service_role', c.oid, 'DELETE'));
  IF v_service <> 0 THEN
    RAISE EXCEPTION 'service_role lost a privilege on % of the three; it writes every one of these rows', v_service;
  END IF;

  RAISE NOTICE 'three tables closed to anon: read receipts, club arena messages, page notifications';
END
$prove_it$;

COMMIT;
