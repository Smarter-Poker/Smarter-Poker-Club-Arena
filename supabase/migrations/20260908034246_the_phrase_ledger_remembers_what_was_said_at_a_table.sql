-- 20260908034246_the_phrase_ledger_remembers_what_was_said_at_a_table
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-08 UTC.
--
-- ═══════════════════════════════════════════════════════════════════════════════
--  THE PHRASE LEDGER REMEMBERS WHAT WAS SAID AT A TABLE
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Measured 2026-09-08: `table_chat` held 6 messages in its entire history, all
-- from one human. Across 1,000 horses and 1,271 occupied seats, a horse had
-- NEVER sent one. Silence is a feature every human seat has and no horse seat
-- had, which is the exclusion Dan ruled on for the rebuy pause: "IF YOU DIDN'T
-- GIVE THEM THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"
--
-- `server/src/engine/HorseTableTalk.ts` gives a horse the same door a person
-- uses - an INSERT into `table_chat` with `message_type = 'player'`, refused by
-- the same `fn_table_chat_is_silenced` a human is refused by. It must not
-- repeat itself, and `horse_phrase_ledger` already solves exactly that for the
-- social feed (6,121 rows, `phrase_norm` + `horse_id` + `used_at`, indexed both
-- ways). Reusing it means one anti-repetition memory rather than two that can
-- disagree.
--
-- The ledger's `post_id` is the social half and is already nullable. This adds
-- the table half: a NULLABLE `table_id`, so a row says where it was said
-- without changing anything about the rows that already exist. No backfill, no
-- default, no constraint that an existing row could violate.
--
-- AND IT TAKES A GRANT AWAY. `horse_phrase_ledger` carried SELECT for `anon`
-- and `authenticated`. That grant is INERT today - RLS is on and there is no
-- SELECT policy, so a player's query returns zero rows whatever the grant says
-- - but a table whose rows are (phrase, horse_id) is one policy away from
-- being a roster, and the way this estate has repeatedly leaked is a later
-- pass adding a read policy to a table that "already had the grant". Nothing
-- reads it but the engine, which holds the service role. Revoked.
--
-- The phrase POOL itself is not a table at all for the same reason: it lives
-- in the engine source and ships only to the server, so there is no object for
-- a future grant to reach.
--
-- PROBED (rolled back): insert with table_id ok, rows=1; total=6122.
--
-- One ALTER, one transaction, one PostgREST reload (~28s).

BEGIN;

ALTER TABLE public.horse_phrase_ledger
  ADD COLUMN IF NOT EXISTS table_id uuid;

REVOKE ALL ON TABLE public.horse_phrase_ledger FROM anon, authenticated;

COMMENT ON COLUMN public.horse_phrase_ledger.table_id IS
  'The table a phrase was said at, when it was said at a table rather than on a post. Nullable: the social rows that predate table talk have neither. Engine-written, service-role only. 2026-09-08.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'horse_phrase_ledger'
       AND column_name = 'table_id'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_phrase_ledger.table_id did not land';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'horse_phrase_ledger'
       AND column_name = 'table_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: table_id must stay nullable - the 6,121 social rows have none';
  END IF;
  /* The ledger names horses. Two independent reasons a player cannot read it,
     asserted separately so losing either one is loud: no grant, and - the one
     that was already true and doing the actual work - RLS on with no SELECT
     policy. */
  IF has_table_privilege('anon', 'public.horse_phrase_ledger', 'SELECT')
     OR has_table_privilege('authenticated', 'public.horse_phrase_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'POST-FLIGHT: horse_phrase_ledger still grants SELECT to a player role';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.horse_phrase_ledger'::regclass) THEN
    RAISE EXCEPTION 'POST-FLIGHT: RLS is off on horse_phrase_ledger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'horse_phrase_ledger'
       AND cmd IN ('SELECT', 'ALL') AND roles::text ~ '(public|anon|authenticated)'
  ) THEN
    RAISE EXCEPTION 'POST-FLIGHT: a read policy on horse_phrase_ledger would expose horse ids';
  END IF;
END $$;

COMMIT;
