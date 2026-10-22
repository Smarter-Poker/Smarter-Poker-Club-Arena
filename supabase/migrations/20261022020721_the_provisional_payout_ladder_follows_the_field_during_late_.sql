-- 20261022020721_the_provisional_payout_ladder_follows_the_field_during_late_.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-21, with a screenshot of the live 2K GTD Midweek Bounty
-- (98f66ce1) during late registration showing 16 paid places and "8.7% Of The
-- Field Paid": "ADJUST THIS LIVE TOURNAMENT TO PAY OUT 12.5% OF THE FIELD. FIX
-- THIS AND ADJUST THE PAYOUTS IN THIS LIVE TOURNAMENT NOW PLEASE."
--
-- Read from production: the event's paid depth was already 12.5%
-- (payout_depth_percent), and the entry-close finalization
-- (fn_finalize_tournament_entry_pool_locked) rebuilds the ladder from the
-- final field at that depth. What was wrong is what every surface showed in
-- the meantime: payout_structure was written once, at launch, for the field
-- that existed then (about 128 entries, so 16 places), and never followed the
-- field while late registration added 70 more. Six live events were showing a
-- launch-time ladder of 8 to 9.4% of their field.
--
-- The fix keeps the stored provisional ladder equal to the paid depth of the
-- CURRENT field, written in the same transaction as every entry or removal,
-- until the pool is finalized:
--
--   * fn_ca_refresh_provisional_payout_structure(id) writes
--     fn_ca_payout_structure(field, effective depth) for a non-finalized,
--     non-Spin, non-satellite MTT, only when it differs;
--   * statement triggers on tournament_players (insert and delete) call it
--     for every tournament the statement touched;
--   * fn_guard_managed_game_lifecycle, which refuses any change to a
--     registered event's payout_structure from outside the engine, admits
--     exactly one value: that derived ladder, for an unfinalized pool. No
--     other structure can be written through the exemption.
--
-- The finalized ladder and every paid place are untouched: a finalized pool
-- is refused by the refresher and by trg_freeze_finalized_tournament_prize_pool.

BEGIN;

SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_ca_refresh_provisional_payout_structure','system','Writes only tournaments.payout_structure for an unfinalized MTT: the derived ladder of the current field at its paid depth. Moves no money.'),
 ('trg_ca_refresh_provisional_payout_structure','system','Statement trigger wrapper: refreshes the provisional ladder of every tournament an entry insert or delete touched. Moves no money.')
ON CONFLICT (proname) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_provisional_payout_structure(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_ca_payout_structure(
           (SELECT count(*)::integer FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id),
           public.fn_ca_effective_payout_depth(t.payout_depth_percent, t.payout_percent))
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
     AND NOT COALESCE(t.prize_pool_finalized, false)
     AND upper(COALESCE(t.tournament_type, '')) = 'MTT'
     AND lower(COALESCE(t.variant, '')) NOT IN ('spin', 'sng', 'satellite')
     AND t.satellite_target_id IS NULL
     AND t.satellite_target IS NULL
     AND NOT COALESCE(t.is_premium_spin, false)
     AND upper(COALESCE(t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED')
     AND public.fn_ca_effective_payout_depth(t.payout_depth_percent, t.payout_percent) IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_provisional_payout_structure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_provisional_payout_structure(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_refresh_provisional_payout_structure(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ladder jsonb;
  v_rows integer;
BEGIN
  v_ladder := public.fn_ca_provisional_payout_structure(p_tournament_id);
  IF v_ladder IS NULL OR jsonb_typeof(v_ladder) <> 'array' OR jsonb_array_length(v_ladder) = 0 THEN
    RETURN false;
  END IF;
  UPDATE public.tournaments t
     SET payout_structure = v_ladder::text
   WHERE t.id = p_tournament_id
     AND NOT COALESCE(t.prize_pool_finalized, false)
     AND public.fn_safe_jsonb_array(t.payout_structure::text) IS DISTINCT FROM v_ladder;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_refresh_provisional_payout_structure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_refresh_provisional_payout_structure(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_ca_refresh_provisional_payout_structure()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR v_id IN SELECT DISTINCT n.tournament_id FROM new_rows n WHERE n.tournament_id IS NOT NULL LOOP
      -- A display refresh can never cost a player their entry.
      BEGIN
        PERFORM public.fn_ca_refresh_provisional_payout_structure(v_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'provisional payout ladder refresh for % failed: %', v_id, SQLERRM;
      END;
    END LOOP;
  ELSE
    FOR v_id IN SELECT DISTINCT o.tournament_id FROM old_rows o WHERE o.tournament_id IS NOT NULL LOOP
      -- A display refresh can never cost a player their entry.
      BEGIN
        PERFORM public.fn_ca_refresh_provisional_payout_structure(v_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'provisional payout ladder refresh for % failed: %', v_id, SQLERRM;
      END;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_ca_refresh_provisional_payout_structure() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER zzz_provisional_ladder_follows_entries
  AFTER INSERT ON public.tournament_players
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_ca_refresh_provisional_payout_structure();

CREATE TRIGGER zzz_provisional_ladder_follows_removals
  AFTER DELETE ON public.tournament_players
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_ca_refresh_provisional_payout_structure();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
 ('tournament_players','zzz_provisional_ladder_follows_entries','Dan 2026-10-21: the provisional payout ladder follows the field. AFTER INSERT statement trigger: for each tournament the statement touched, writes tournaments.payout_structure = fn_ca_payout_structure(current field, paid depth) while the pool is unfinalized. Moves no money, writes no balance.'),
 ('tournament_players','zzz_provisional_ladder_follows_removals','Dan 2026-10-21: the provisional payout ladder follows the field. AFTER DELETE statement trigger: same refresh after a pre-start removal. Moves no money, writes no balance.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

-- The 12.5% depth guard another change installed without a declaration was
-- paging UndeclaredTriggerOnAMoneyTable; reviewed and declared here (also
-- written live at 02:08 UTC).
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note) VALUES
 ('tournaments','ca_mtt_payout_depth_guard','Reviewed 2026-10-22: BEFORE INSERT OR UPDATE OF payout_depth_percent, payout_percent. Sets payout_depth_percent (12.5 for union, platform, Diamond and cross-club MTTs; the chosen supported depth otherwise) and freezes it once the pool is finalized. Writes no balance and no other row.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = EXCLUDED.note;

/* The lifecycle guard admits exactly the derived provisional ladder for an
   unfinalized pool. Edited by substitution against the catalogue, asserted to
   apply once, so every other protected field keeps its refusal unchanged. */
DO $edit$
DECLARE
  v_def text := pg_get_functiondef('public.fn_guard_managed_game_lifecycle()'::regprocedure);
  v_anchor text := E'        IF (v_new_document -> v_key) IS DISTINCT FROM (v_old_document -> v_key) THEN\n          RAISE EXCEPTION ''This tournament cannot be modified after a player has registered''';
  v_insert text := E'        -- THE PROVISIONAL LADDER FOLLOWS THE FIELD (Dan 2026-10-21): until the\n        -- pool is finalized, payout_structure may take exactly one value, the\n        -- paid depth of the current field. Nothing else passes here.\n        CONTINUE WHEN v_key = ''payout_structure''\n          AND NOT COALESCE(OLD.prize_pool_finalized, false)\n          AND NOT COALESCE(NEW.prize_pool_finalized, false)\n          AND public.fn_safe_jsonb_array(NEW.payout_structure::text)\n              IS NOT DISTINCT FROM public.fn_ca_provisional_payout_structure(NEW.id);\n';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'lifecycle guard anchor not found exactly once';
  END IF;
  IF position('THE PROVISIONAL LADDER FOLLOWS THE FIELD' in v_def) > 0 THEN
    RETURN;
  END IF;
  EXECUTE replace(v_def, v_anchor, v_insert || v_anchor);
END
$edit$;

COMMIT;
