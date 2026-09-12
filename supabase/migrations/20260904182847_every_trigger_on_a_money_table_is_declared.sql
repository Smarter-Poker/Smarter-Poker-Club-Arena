-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904182847; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904182847   (the stamp IS the apply time, UTC: 2026-09-04 18:28:47)
--   name        every_trigger_on_a_money_table_is_declared
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 4190 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904182847 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_undeclared_money_triggers
--     TABLE          public.ca_declared_money_triggers
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.ca_declared_money_triggers (
  table_name   text        NOT NULL,
  trigger_name text        NOT NULL,
  declared_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  PRIMARY KEY (table_name, trigger_name)
);

COMMENT ON TABLE public.ca_declared_money_triggers IS
  'Every trigger allowed on a money or seat table. Seeded 2026-09-04 from live AFTER aaa_skip_noop_update was removed, so the baseline is the reviewed state rather than the broken one. Declare a new trigger in the same migration that creates it; fn_undeclared_money_triggers() reports anything live and undeclared, and the engine puts that count on a gauge.';

ALTER TABLE public.ca_declared_money_triggers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM anon;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_declared_money_triggers TO service_role;

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT c.relname::text, t.tgname::text,
       'seeded 2026-09-04 from live, post-incident baseline'
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('table_seats','club_members','club_wallets','union_wallets',
                    'wallets','chip_ledger','tournaments','tournament_players',
                    'ca_settlements')
ON CONFLICT (table_name, trigger_name) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_undeclared_money_triggers()
RETURNS TABLE (
  table_name    text,
  trigger_name  text,
  function_name text,
  trigger_def   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT c.relname::text,
         t.tgname::text,
         p.proname::text,
         pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_proc  p ON p.oid = t.tgfoid
  WHERE NOT t.tgisinternal
    AND c.relnamespace = 'public'::regnamespace
    AND c.relname IN ('table_seats','club_members','club_wallets','union_wallets',
                      'wallets','chip_ledger','tournaments','tournament_players',
                      'ca_settlements')
    AND NOT EXISTS (
      SELECT 1 FROM public.ca_declared_money_triggers d
      WHERE d.table_name = c.relname::text
        AND d.trigger_name = t.tgname::text
    )
  ORDER BY 1, 2
$$;

COMMENT ON FUNCTION public.fn_undeclared_money_triggers() IS
  'Triggers live on a money or seat table with no row in ca_declared_money_triggers. Any result is an unreviewed schema change on a path that moves chips - which is how aaa_skip_noop_update broke 139,153 hand settlements on 2026-09-03 without anybody being told. Reports; never blocks.';

REVOKE ALL ON FUNCTION public.fn_undeclared_money_triggers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_undeclared_money_triggers() FROM anon;
REVOKE ALL ON FUNCTION public.fn_undeclared_money_triggers() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_undeclared_money_triggers() TO service_role;

DO $$
DECLARE
  v_declared int;
  v_undecl   int;
  v_rogue    int;
BEGIN
  SELECT count(*) INTO v_declared FROM public.ca_declared_money_triggers;
  SELECT count(*) INTO v_undecl   FROM public.fn_undeclared_money_triggers();

  IF v_declared < 50 THEN
    RAISE EXCEPTION
      'post-condition failed: only % triggers declared. The nine money tables carried 106 when this was written.', v_declared;
  END IF;

  IF v_undecl <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: % triggers undeclared immediately after seeding from live.', v_undecl;
  END IF;

  SELECT count(*) INTO v_rogue
  FROM public.ca_declared_money_triggers
  WHERE trigger_name = 'aaa_skip_noop_update';

  IF v_rogue <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: aaa_skip_noop_update is in the declared baseline. It broke a third of all hand settlements and must never be blessed by this table.';
  END IF;

  RAISE NOTICE 'declared % money-table triggers; % undeclared.', v_declared, v_undecl;
END $$;
