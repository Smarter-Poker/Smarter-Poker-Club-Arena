-- ============================================================================
-- THE CHIP MONEY TABLES REFUSE A DIAMOND ROW
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, line "Remove every inherited
-- union/agent distribution and chip treasury dependency", step 0 of
-- docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 4, second half (the
-- first is 20260929160000_the_chip_legs_refuse_a_diamond_row). Dan's ruling 16:
-- "No unions, agents, commissions, chip wallets, chip ledgers or chip
-- conversion" in the Diamond Arena.
--
-- The chip money tables refuse a Diamond Arena row by name, the way
-- poker_arena_no_hierarchy (fn_poker_reject_diamond_hierarchy, 20260908153052)
-- refuses an agent row: rake_records, rake_attributions, club_wallets,
-- bbj_pools, bbj_contributions, chip_ledger, tournament_guarantee_overlays,
-- tournament_tickets, and the two tables behind the view
-- accounting_payable_earning_sources (accounting_cash_rake_sources and
-- accounting_tournament_fee_sources: a view takes no row of its own, so its
-- sources are fenced). A row names the arena by its club, by the table it was
-- played at, or by the event it was paid into (for a ticket, the event or
-- satellite that sourced it). tournament_rake_settlements is left out: the
-- Diamond fee path writes it today (destination diamond_house) until step 3
-- moves that path off the chip settler.
--
-- Proved read-only before this was written, and proved again below by index:
-- no such row exists. A fence is not put over a leak.
--
-- A migration of its own: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each of
-- these tables, which stops every writer to them until the transaction ends.
-- The triggers are therefore created last, after every slow proof, and the
-- rehearsal around them is a fraction of a second.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. NOTHING IS OPEN AND NO CHIP MONEY TABLE HOLDS A DIAMOND ARENA ROW
-- ---------------------------------------------------------------------------
-- A fence is not put over a row that is already there: if one exists it is
-- a leak to report, not to hide. Every check here rides an index; the
-- unindexed columns (rake_attributions.table_id, bbj_contributions.club_id,
-- chip_ledger.table_id) were proved empty by a full read before this was
-- written.
DO $m$
DECLARE
  v_clubs uuid[]; v_tables uuid[]; v_events uuid[]; v_found text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is already on somewhere; this migration expects both closed';
  END IF;
  v_clubs := ARRAY(SELECT c.id FROM public.clubs c WHERE c.asset = 'diamonds');
  v_tables := ARRAY(SELECT t.id FROM public.tables t WHERE t.club_id = ANY (v_clubs));
  v_events := ARRAY(SELECT e.id FROM public.tournaments e WHERE e.club_id = ANY (v_clubs));
  SELECT string_agg(x.name, ', ') INTO v_found FROM (
    SELECT 'rake_records' AS name
     WHERE EXISTS (SELECT 1 FROM public.rake_records r WHERE r.club_id = ANY (v_clubs))
        OR EXISTS (SELECT 1 FROM public.rake_records r WHERE r.table_id = ANY (v_tables))
        OR EXISTS (SELECT 1 FROM public.rake_records r WHERE r.tournament_id = ANY (v_events))
    UNION ALL SELECT 'rake_attributions'
     WHERE EXISTS (SELECT 1 FROM public.rake_attributions r WHERE r.club_id = ANY (v_clubs))
    UNION ALL SELECT 'club_wallets'
     WHERE EXISTS (SELECT 1 FROM public.club_wallets w WHERE w.club_id = ANY (v_clubs))
    UNION ALL SELECT 'bbj_pools'
     WHERE EXISTS (SELECT 1 FROM public.bbj_pools p WHERE p.club_id = ANY (v_clubs))
    UNION ALL SELECT 'bbj_contributions'
     WHERE EXISTS (SELECT 1 FROM public.bbj_contributions b WHERE b.table_id = ANY (v_tables))
        OR EXISTS (SELECT 1 FROM public.bbj_contributions b
                    WHERE b.pool_id IN (SELECT p.id FROM public.bbj_pools p WHERE p.club_id = ANY (v_clubs)))
    UNION ALL SELECT 'chip_ledger'
     WHERE EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.club_id = ANY (v_clubs))
        OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id = ANY (v_events))
    UNION ALL SELECT 'tournament_guarantee_overlays'
     WHERE EXISTS (SELECT 1 FROM public.tournament_guarantee_overlays o
                    WHERE o.club_id = ANY (v_clubs) OR o.tournament_id = ANY (v_events))
    UNION ALL SELECT 'tournament_tickets'
     WHERE EXISTS (SELECT 1 FROM public.tournament_tickets k
                    WHERE k.club_id = ANY (v_clubs) OR k.source_tournament_id = ANY (v_events)
                       OR k.source_satellite_id = ANY (v_events))
    UNION ALL SELECT 'accounting_cash_rake_sources'
     WHERE EXISTS (SELECT 1 FROM public.accounting_cash_rake_sources s WHERE s.club_id = ANY (v_clubs))
    UNION ALL SELECT 'accounting_tournament_fee_sources'
     WHERE EXISTS (SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.club_id = ANY (v_clubs))
        OR EXISTS (SELECT 1 FROM public.accounting_tournament_fee_sources s WHERE s.tournament_id = ANY (v_events))
  ) x;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'a chip money table already holds a Diamond Arena row (%); report it, do not fence over it', v_found;
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE FENCE
-- ---------------------------------------------------------------------------
-- The poker_arena_no_hierarchy pattern (fn_poker_reject_diamond_hierarchy),
-- widened to the ways a money row names the arena: its club, the table it
-- was played at, or the event it was paid into. SECURITY DEFINER so that no
-- caller's row-level view of clubs, tables or tournaments can hide the arena
-- from it; it moves nothing.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_poker_reject_diamond_chip_money', 'system',
  'Moves no money. Trigger that refuses a Diamond Arena row (by club, table or event) on the chip money tables, by name: Diamond Arena Has No Chip Money. Ruling 16.');

CREATE FUNCTION public.fn_poker_reject_diamond_chip_money()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb := to_jsonb(NEW);
BEGIN
  /* DIAMOND PHASE 9, STEP 0 (2026-09-29). Ruling 16: no unions, agents,
     commissions, chip wallets or chip ledgers in the Diamond Arena. A row of
     a chip money table that belongs to the arena - by its club, by the table
     it was played at, or by the event it was paid into - is refused by name,
     as poker_arena_no_hierarchy refuses an agent row. */
  IF EXISTS (SELECT 1 FROM public.clubs c
              WHERE c.id = (v_row->>'club_id')::uuid AND c.asset = 'diamonds')
     OR EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
                 WHERE t.id = (v_row->>'table_id')::uuid AND c.asset = 'diamonds')
     OR EXISTS (SELECT 1 FROM public.tournaments e JOIN public.clubs c ON c.id = e.club_id
                 WHERE e.id IN ((v_row->>'tournament_id')::uuid,
                                (v_row->>'source_tournament_id')::uuid,
                                (v_row->>'source_satellite_id')::uuid)
                   AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'Diamond Arena Has No Chip Money' USING ERRCODE = '23514',
      DETAIL = format('public.%I refuses a row that belongs to the Diamond Arena.', TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.fn_poker_reject_diamond_chip_money() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_poker_reject_diamond_chip_money() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
-- Every slow proof runs here, before section 4 locks the hot tables. Nothing
-- after this block moves a Diamond or redefines a function.
DO $m$
DECLARE v_bad text; v_oid oid;
BEGIN
  v_oid := to_regprocedure('public.fn_poker_reject_diamond_chip_money()');
  IF v_oid IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR position('Diamond Arena Has No Chip Money' IN pg_get_functiondef(v_oid)) = 0 THEN
    RAISE EXCEPTION 'the fence does not refuse by name as this migration states';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_poker_reject_diamond_chip_money is reachable from a browser';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. THE CHIP MONEY TABLES REFUSE A DIAMOND ARENA ROW
-- ---------------------------------------------------------------------------
-- Named aa_ so it fires before every other BEFORE trigger on these tables:
-- the refusal a Diamond row meets is this one, whatever else would object.
-- An UPDATE can make a row the arena's only by changing a column that names
-- it, so only those columns wake the fence on UPDATE; a balance or a stamp
-- written to a chip row pays nothing for it.
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, table_id, tournament_id ON public.chip_ledger
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, table_id, tournament_id ON public.rake_records
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, table_id ON public.rake_attributions
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, table_id ON public.bbj_contributions
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id ON public.accounting_cash_rake_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, source_tournament_id, source_satellite_id ON public.tournament_tickets
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, tournament_id ON public.tournament_guarantee_overlays
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();
CREATE TRIGGER aa_poker_arena_no_chip_money BEFORE INSERT OR UPDATE OF club_id, tournament_id ON public.accounting_tournament_fee_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_poker_reject_diamond_chip_money();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT x.t, 'aa_poker_arena_no_chip_money',
       'Diamond Phase 9 step 0 (the_chip_money_tables_refuse_a_diamond_row): refuses a Diamond Arena row (by club, table or event) by name - Diamond Arena Has No Chip Money. Reads clubs/tables/tournaments by primary key and raises; writes nothing.'
  FROM unnest(ARRAY['chip_ledger','rake_records','rake_attributions','bbj_contributions','accounting_cash_rake_sources',
                    'club_wallets','bbj_pools','tournament_tickets','tournament_guarantee_overlays',
                    'accounting_tournament_fee_sources']) AS x(t)
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

-- ---------------------------------------------------------------------------
-- 5. THE FENCES ARE UP
-- ---------------------------------------------------------------------------
DO $m$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.t, ', ') INTO v_missing
    FROM unnest(ARRAY['chip_ledger','rake_records','rake_attributions','bbj_contributions','accounting_cash_rake_sources',
                      'club_wallets','bbj_pools','tournament_tickets','tournament_guarantee_overlays',
                      'accounting_tournament_fee_sources']) AS x(t)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g
      WHERE g.tgrelid = ('public.' || x.t)::regclass
        AND g.tgname = 'aa_poker_arena_no_chip_money'
        AND g.tgfoid = 'public.fn_poker_reject_diamond_chip_money()'::regprocedure
        AND g.tgenabled = 'O'
        AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2 AND (g.tgtype & 4) = 4 AND (g.tgtype & 16) = 16)
      OR NOT EXISTS (
     SELECT 1 FROM public.ca_declared_money_triggers d
      WHERE d.table_name = x.t AND d.trigger_name = 'aa_poker_arena_no_chip_money');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the chip money fence is not up and declared on: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the tournament door';
  END IF;
  RAISE NOTICE 'the chip money tables refuse a Diamond row: ten tables, by club, table or event, on insert and on the update that could name the arena';
END $m$;

COMMIT;
