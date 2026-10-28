-- Owner October28: exact daily6PM series has one rebuy, no add-on,25/50 opening.
-- @live-proof: (position('a70c1028-1800-2500-9000-000000000001' in pg_get_functiondef('public.fn_ca_bounty_mtt_rebuys_until_registration_closes()'::regprocedure)) > 0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE definition text; needle text := '  IF NOT (COALESCE(NEW.is_bounty, false)';
addition text := $addition$
  -- Exact owner-authored daily6PM contract, before the first entry can be sold.
  IF TG_OP = 'INSERT'
     AND NEW.schedule_id = 'a70c1028-1800-2500-9000-000000000001'::uuid
     AND NEW.club_id = 'fade0000-0000-0000-0000-000000000001'::uuid
     AND NEW.union_id = NEW.club_id
     AND upper(COALESCE(NEW.status,'')) = 'REGISTERING'
     AND upper(COALESCE(NEW.tournament_type,'')) = 'MTT'
     AND NEW.satellite_target_id IS NULL
     AND NEW.buy_in_amount + NEW.buy_in_fee = 25
     AND NEW.is_bounty IS NOT TRUE AND NEW.is_pko IS NOT TRUE
     AND NEW.is_mystery_bounty IS NOT TRUE THEN
    NEW.starting_chips := 15000;
    NEW.is_rebuy := true;
    NEW.rebuy_cost := 25;
    NEW.rebuy_chips := 15000;
    NEW.rebuy_levels := 6;
    NEW.max_rebuys := 1;
    NEW.is_reentry := false;
    NEW.max_reentries := 0;
    NEW.add_on_available := false;
    NEW.addon_cost := 0;
    NEW.addon_chips := 0;
    NEW.addon_levels := 0;
    NEW.addon_from_start := false;
    NEW.addon_break_minutes := 0;
    SELECT (config->'blindStructure')::text INTO STRICT NEW.blind_structure
      FROM public.tournament_schedules WHERE id=NEW.schedule_id;
    PERFORM public.fn_ca_mtt_blind_contract(NEW.blind_structure,NEW.starting_chips);
    IF (NEW.blind_structure::jsonb->0->>'smallBlind')::numeric <> 25
       OR (NEW.blind_structure::jsonb->0->>'bigBlind')::numeric <> 50
       OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.blind_structure::jsonb) b
          WHERE (b->>'durationMinutes')::numeric IS DISTINCT FROM 8::numeric) THEN
      RAISE EXCEPTION 'DAILY_6PM_AUTHORED_STRUCTURE_DRIFT';
    END IF;
  END IF;
$addition$;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_ca_bounty_mtt_rebuys_until_registration_closes()'::regprocedure)
     IS DISTINCT FROM '5f504f528de6de4612945392c79b616d' THEN
    RAISE EXCEPTION 'DAILY_6PM_TRIGGER_PREIMAGE_DRIFT';
  END IF;
  definition:=pg_get_functiondef('public.fn_ca_bounty_mtt_rebuys_until_registration_closes()'::regprocedure);
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle) <> 1 THEN
    RAISE EXCEPTION 'DAILY_6PM_TRIGGER_ANCHOR_DRIFT';
  END IF;
  EXECUTE replace(definition,needle,addition||needle);
END $patch$;
COMMIT;
