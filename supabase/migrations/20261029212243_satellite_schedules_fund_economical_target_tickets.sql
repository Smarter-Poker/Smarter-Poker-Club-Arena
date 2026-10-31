-- Owner 2026-10-29: satellite entries fund target tickets, normally one per
-- five to ten entries. Correct the maintained schedule and unpurchased copies.
-- Registered/running events and frozen economic/settlement receipts are preserved.
-- @live-proof: EXISTS (SELECT 1 FROM public.tournament_schedules s JOIN public.tournament_schedules target ON target.active AND target.club_id=s.club_id AND target.union_id IS NOT DISTINCT FROM s.union_id AND lower(target.config->>'type')<>'satellite' AND (target.name=s.config->>'satelliteTargetName' OR target.config->>'name'=s.config->>'satelliteTargetName') WHERE s.active AND lower(s.config->>'type')='satellite' AND s.config->>'shortDescription'='Win Target Tournament Tickets. Entry Value Funds Approximately One Ticket Per Five To Ten Entries.' AND NULLIF(target.config->>'buyIn','')::numeric / NULLIF(round(NULLIF(s.config->>'buyIn','')::numeric*.9,2),0) BETWEEN 5 AND 10)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
CREATE FUNCTION pg_temp.satellite_entry_value(ticket numeric, configured numeric)
RETURNS numeric LANGUAGE plpgsql AS $value$
DECLARE candidate numeric; best numeric; gap numeric; best_gap numeric;
BEGIN
 IF ticket IS NULL OR ticket<=0 THEN RETURN NULL; END IF;
 IF configured>0 AND configured=trunc(configured)
    AND ticket/round(configured*.9,2) BETWEEN 5 AND 10 THEN RETURN configured; END IF;
 FOREACH candidate IN ARRAY ARRAY[1,2,3,5,10,15,20,25,30,35,50,75,100,150,200,250,300,500,750,1000,1500,2000,5000]::numeric[] LOOP
  IF ticket/round(candidate*.9,2) BETWEEN 5 AND 10 THEN
   gap:=abs(ticket/round(candidate*.9,2)-8);
   IF best IS NULL OR gap<best_gap THEN best:=candidate;best_gap:=gap;END IF;
  END IF;
 END LOOP;
 RETURN best;
END $value$;
DO $prices$
DECLARE s record; t record; target_value numeric; old_value numeric; new_value numeric; patch jsonb; new_name text; scale numeric;
BEGIN
 -- Schedules store nominal chip values. The Diamond creator applies its own
 -- existing ten-Diamonds-per-chip scale; never scale these config values twice.
 FOR s IN SELECT * FROM public.tournament_schedules
   WHERE active AND lower(config->>'type')='satellite' FOR UPDATE LOOP
  SELECT NULLIF(target.config->>'buyIn','')::numeric
    INTO target_value FROM public.tournament_schedules target
   WHERE target.active AND target.club_id=s.club_id
     AND target.union_id IS NOT DISTINCT FROM s.union_id
     AND lower(target.config->>'type')<>'satellite'
     AND (target.name=s.config->>'satelliteTargetName' OR target.config->>'name'=s.config->>'satelliteTargetName')
   ORDER BY target.id LIMIT 1;
  IF target_value IS NULL THEN
   SELECT (target.buy_in_amount+target.buy_in_fee)/CASE WHEN c.asset='diamonds' AND c.is_platform THEN 10 ELSE 1 END
    INTO target_value FROM public.tournaments source
    JOIN public.tournaments target ON target.id=COALESCE(source.satellite_target_id,source.satellite_target)
    JOIN public.clubs c ON c.id=source.club_id
    WHERE source.schedule_id=s.id ORDER BY source.start_time DESC LIMIT 1;
  END IF;
  old_value:=NULLIF(s.config->>'buyIn','')::numeric;
  IF old_value IS NULL OR old_value<=0 THEN CONTINUE; END IF;
  new_value:=pg_temp.satellite_entry_value(target_value,old_value);
  IF new_value IS NULL OR new_value IS NOT DISTINCT FROM old_value THEN CONTINUE; END IF;
  new_name:=regexp_replace(s.name,'(Satellite) [0-9]+([.][0-9]+)?$','\1 '||new_value::text,'i');
  patch:=jsonb_build_object('buyIn',new_value,'name',new_name,
    'minPlayers',GREATEST(COALESCE((s.config->>'minPlayers')::integer,3),ceil(target_value/round(new_value*.9,2))::integer),
    'shortDescription','Win Target Tournament Tickets. Entry Value Funds Approximately One Ticket Per Five To Ten Entries.');
  IF COALESCE((s.config->>'isRebuy')::boolean,false) OR COALESCE((s.config->>'isReentry')::boolean,false) THEN patch:=patch||jsonb_build_object('rebuyCost',new_value);END IF;
  IF COALESCE((s.config->>'addOnAvailable')::boolean,false) THEN patch:=patch||jsonb_build_object('addonCost',new_value,'addOnCost',new_value);END IF;
  UPDATE public.tournament_schedules SET config=config||patch,name=new_name WHERE id=s.id AND config=s.config;
 END LOOP;
 -- Lock each exact source and recheck absence of purchased registrations under
 -- its row lock. Normal admission locks the same tournament row.
 FOR t IN SELECT source.* FROM public.tournaments source
   WHERE source.status IN ('ANNOUNCED','REGISTERING') AND source.format_contract='mtt-v2'
     AND COALESCE(source.satellite_target_id,source.satellite_target) IS NOT NULL
     AND source.started_at IS NULL AND NOT COALESCE(source.entry_contract_locked,false)
   ORDER BY source.id FOR UPDATE LOOP
  IF COALESCE(t.entry_contract_locked,false)
     OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=t.id AND l.from_type='player_wallet' AND l.to_type='prize_liability' AND l.to_entity_id=t.id AND lower(l.category) IN ('tournament_buyin','rebuy','addon'))
     OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t.id)
     OR EXISTS(SELECT 1 FROM public.tournament_satellite_economic_snapshots e WHERE e.tournament_id=t.id) THEN CONTINUE; END IF;
  SELECT target.buy_in_amount+target.buy_in_fee INTO target_value FROM public.tournaments target
   WHERE target.id=COALESCE(t.satellite_target_id,t.satellite_target);
  old_value:=t.buy_in_amount+t.buy_in_fee;
  new_value:=pg_temp.satellite_entry_value(target_value,old_value);
  IF new_value IS NULL OR old_value<=0 OR new_value IS NOT DISTINCT FROM old_value THEN CONTINUE;END IF;
  SELECT CASE WHEN c.asset='diamonds' AND c.is_platform THEN 10 ELSE 1 END INTO scale FROM public.clubs c WHERE c.id=t.club_id;
  new_name:=regexp_replace(t.name,'(Satellite) [0-9]+([.][0-9]+)?$','\1 '||trim_scale(new_value/COALESCE(scale,1))::text,'i');
  UPDATE public.tournaments SET buy_in_amount=round(new_value*.9,2),buy_in_fee=round(new_value*.1,2),
    name=new_name,min_players=GREATEST(COALESCE(t.min_players,3),ceil(target_value/round(new_value*.9,2))::integer),
    rebuy_cost=CASE WHEN t.is_rebuy OR t.is_reentry THEN new_value ELSE t.rebuy_cost END,
    addon_cost=CASE WHEN t.add_on_available THEN new_value ELSE t.addon_cost END,
    short_description='Win Target Tournament Tickets. Entry Value Funds Approximately One Ticket Per Five To Ten Entries.'
   WHERE id=t.id AND status IN ('ANNOUNCED','REGISTERING') AND started_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t.id);
 END LOOP;
END $prices$;
COMMIT;
