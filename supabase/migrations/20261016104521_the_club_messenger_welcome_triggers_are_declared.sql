-- 20261016104521_the_club_messenger_welcome_triggers_are_declared
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16 10:45:21 UTC.
--
-- THE CLUB MESSENGER WELCOME TRIGGERS ARE DECLARED (2026-10-16)
--
-- What fired. UndeclaredTriggerOnAMoneyTable (critical, pages by SMS) started
-- at 04:06:41 UTC and was still firing at 08:11: "2 undeclared trigger(s) on a
-- money or seat table". fn_undeclared_money_triggers() names them:
--
--   club_members.capture_club_messenger_admission
--     AFTER INSERT OR UPDATE OF status, is_active, membership_lifecycle_status,
--     agent_id, FOR EACH ROW, fn_capture_club_messenger_admission()
--   club_members.deliver_club_messenger_welcome
--     CONSTRAINT TRIGGER, same events, DEFERRABLE INITIALLY DEFERRED,
--     fn_deliver_club_messenger_welcome()
--
-- Who created them. Migration 20261016033645
-- club_messenger_welcome_and_verified_relationships, recorded in
-- supabase_migrations.schema_migrations with created_by
-- 'antigravity_sql_push:v4' about 04:05 UTC on 2026-10-16. It is an r5-date
-- install, it is not in this repository, and it did not declare its triggers,
-- so scripts/ci/check-money-trigger-declared.mjs (which refuses exactly this
-- in a repository migration) never saw it.
--
-- What they do, read from their live text (pg_get_functiondef md5
-- a2cdfdb7... and 31defca7...). Neither reads or writes a balance, a stack, a
-- ledger or any money table. The capture trigger keeps one
-- club_messenger_admissions row per membership (active or not, with the
-- admitting transaction id). The deferred trigger, at commit, sends the
-- admitting agent's (or the owner's) enabled welcome template to the new
-- member as one ordinary Messenger message, once per admission generation,
-- honouring personal blocks and the sender's social restriction, and records
-- it in club_messenger_welcome_deliveries. They are legitimate; what was
-- missing is the declaration the register exists to hold.
--
-- The money is right: nothing to settle. Fix forward: declare both, after
-- proving each name is bound to the function reviewed above.
--
-- Regression: scripts/ci/test-the-club-messenger-welcome-triggers-are-declared.py
-- (native PostgreSQL), run by
-- .github/workflows/the-club-messenger-welcome-triggers-are-declared.yml.
--
-- @live-proof: (SELECT count(*) = 2 FROM public.ca_declared_money_triggers WHERE table_name = 'club_members' AND trigger_name IN ('capture_club_messenger_admission', 'deliver_club_messenger_welcome'))

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $bound$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.club_members'::regclass
                    AND t.tgname = 'capture_club_messenger_admission'
                    AND p.proname = 'fn_capture_club_messenger_admission') THEN
    RAISE EXCEPTION 'capture_club_messenger_admission is not the reviewed trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                  WHERE t.tgrelid = 'public.club_members'::regclass
                    AND t.tgname = 'deliver_club_messenger_welcome'
                    AND t.tgdeferrable AND t.tginitdeferred
                    AND p.proname = 'fn_deliver_club_messenger_welcome') THEN
    RAISE EXCEPTION 'deliver_club_messenger_welcome is not the reviewed trigger';
  END IF;
END $bound$;

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES
  ('club_members', 'capture_club_messenger_admission',
   'Club Messenger welcome (20261016033645, declared by 20261016104521): records one club_messenger_admissions row per membership when it becomes active, changes agent or ends; reads no money column and writes no money table'),
  ('club_members', 'deliver_club_messenger_welcome',
   'Club Messenger welcome (20261016033645, declared by 20261016104521): deferred to commit, sends the admitting agent''s or owner''s enabled welcome template to the new member once per admission as an ordinary Messenger message, honouring blocks; reads no money column and writes no money table')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

DO $declared$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers() u
              WHERE u.trigger_name IN ('capture_club_messenger_admission', 'deliver_club_messenger_welcome')) THEN
    RAISE EXCEPTION 'the club messenger welcome triggers are still undeclared';
  END IF;
END $declared$;

COMMIT;
