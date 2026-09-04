-- ═══════════════════════════════════════════════════════════════════════════
--  EVERY TRIGGER ON A MONEY TABLE IS DECLARED, OR IT IS AN INCIDENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (2026-09-04)
--
-- `aaa_skip_noop_update` was attached to `table_seats` at 21:30:32 on
-- 2026-09-03 with no migration, no pull request, no test and no review. The
-- first hand-settlement failure followed 0.65 seconds later. 139,153 hands -
-- between a quarter and nearly half of every hand dealt - failed to settle
-- over the next thirteen hours.
--
-- RULE 2 already forbids exactly that: schema changes go through migrations,
-- never raw execute_sql. Nothing enforced it, and the existing guard could not
-- have: `check-applied-migrations-are-recorded.mjs` compares
-- supabase_migrations.schema_migrations against the files in this repo, and an
-- object created by raw SQL never writes a row there at all. It is invisible
-- to the one check designed to catch unrecorded schema changes - the check
-- asks "does every applied migration have a file", and the answer for an
-- object that was never a migration is vacuously yes.
--
-- So the hole is not "somebody broke the rule". The hole is that breaking the
-- rule leaves no trace anywhere anything looks.
--
-- WHAT THIS IS
--
-- A declared inventory of every trigger on the nine tables that move money or
-- seats, and a function that reports anything live which is not in it. A rogue
-- trigger then shows up on a Prometheus gauge within a minute instead of being
-- found thirteen hours later by someone sizing a table for an unrelated
-- reason.
--
-- It is deliberately an INVENTORY, not a block. A BEFORE trigger that can
-- refuse a schema change is a much worse failure mode than the one it
-- prevents, and section 11.5's precedent is explicit that a guard which can
-- refuse a seat operation can strand a player mid-hand. This makes the change
-- LOUD, not impossible - the same choice `ca_seat_stack_exits` made.
--
-- THE NINE TABLES: table_seats, club_members, club_wallets, union_wallets,
-- wallets, chip_ledger, tournaments, tournament_players, ca_settlements.
-- These are the seven the freeze guard already treats as money-or-seat tables,
-- plus chip_ledger (the append-only record itself) and ca_settlements (the
-- per-hand settlement state machine the rogue trigger actually broke).
--
-- ADDING A TRIGGER LEGITIMATELY. Insert its row here in the SAME migration
-- that creates it. That is the whole point: the declaration is the review
-- trail, and a migration that creates a trigger without declaring it will set
-- the gauge alight within a minute of being applied.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_undeclared_money_triggers();
--   DROP TABLE IF EXISTS public.ca_declared_money_triggers;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_declared_money_triggers (
  table_name   text        NOT NULL,
  trigger_name text        NOT NULL,
  declared_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  PRIMARY KEY (table_name, trigger_name)
);

COMMENT ON TABLE public.ca_declared_money_triggers IS
  'Every trigger allowed on a money or seat table. Seeded 2026-09-04 from the live database AFTER aaa_skip_noop_update was removed, so the baseline is the reviewed state rather than the broken one. Declare a new trigger in the same migration that creates it; fn_undeclared_money_triggers() reports anything live and undeclared, and the engine puts that count on a gauge.';

ALTER TABLE public.ca_declared_money_triggers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM PUBLIC;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM anon;
REVOKE ALL ON TABLE public.ca_declared_money_triggers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_declared_money_triggers TO service_role;

-- Seed from live. This snapshot is taken AFTER the rogue trigger was detached,
-- so the baseline records the state a human would have approved.
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
  table_name   text,
  trigger_name text,
  function_name text,
  trigger_def  text
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
  'Triggers live on a money or seat table with no row in ca_declared_money_triggers. Any result is an unreviewed schema change on a path that moves chips - which is how aaa_skip_noop_update broke 139,153 hand settlements on 2026-09-03 without anybody being told. Reports; never blocks. A guard that can refuse a schema change on these tables is a worse failure than the one it prevents.';

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
      'post-condition failed: only % triggers were declared. The nine money tables carried 106 when this was written - a short seed would leave real triggers looking rogue and make the gauge useless.',
      v_declared;
  END IF;

  IF v_undecl <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: % triggers are undeclared immediately after seeding from live. The seed and the check disagree, which means one of them has the wrong table list.',
      v_undecl;
  END IF;

  -- The baseline must NOT contain the trigger that caused the incident.
  SELECT count(*) INTO v_rogue
  FROM public.ca_declared_money_triggers
  WHERE trigger_name = 'aaa_skip_noop_update';

  IF v_rogue <> 0 THEN
    RAISE EXCEPTION
      'post-condition failed: aaa_skip_noop_update is in the declared baseline. It broke a third of all hand settlements on 2026-09-03 and must never be blessed by this table.';
  END IF;

  RAISE NOTICE 'declared % money-table triggers; % undeclared.', v_declared, v_undecl;
END $$;
