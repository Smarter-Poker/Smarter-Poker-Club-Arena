-- Wheel admission reserves 20x of the largest optional Double Down stake.
-- cap_cents on an award is denominated in BASE stake; game config ceilings
-- are denominated in FINAL stake. Crash 25x can cover the 40x / 30x base
-- reservation without paying above 25x. Keep existing larger reservations.
-- No game ceiling, probability, wallet, award or settled round is rewritten.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $repair$
DECLARE sig text; expected text; source text; replacement text;
BEGIN
 FOR sig,expected IN SELECT * FROM (VALUES
  ('public.fn_wheel_state_v2(uuid,integer)','096a242c64fb2bba31802c05d6a92f4e'),
  ('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)','dc91233ef36350558c5be31dc27317ab')
 ) p(signature,definition_md5) LOOP
  source:=pg_get_functiondef(sig::regprocedure);
  IF md5(source)<>expected THEN RAISE EXCEPTION 'Wheel reservation preimage changed: %',sig; END IF;
  replacement:=source;
  IF sig LIKE '%state_v2%' THEN
   replacement:=replace(replacement,',gcfg.max_multiplier_cents)',',GREATEST(gcfg.max_multiplier_cents,minimum_cap))');
   replacement:=replace(replacement,'IF gcfg.max_multiplier_cents<minimum_cap THEN','IF gcfg.max_multiplier_cents<2000 THEN');
   replacement:=replace(replacement,'IF welcome_cap<minimum_cap THEN','IF welcome_cap<minimum_cap OR gcfg.max_multiplier_cents<2000 THEN');
   replacement:=replace(replacement,'IF cap<2000*(boost+1)/boost THEN','IF cap<2000*(boost+1)/boost OR gcfg.max_multiplier_cents<2000 THEN');
  ELSE
   replacement:=replace(replacement,',v_gcfg.max_multiplier_cents)',',GREATEST(v_gcfg.max_multiplier_cents,2000*(v_boost+1)/v_boost))');
   replacement:=replace(replacement,'IF v_cap<2000*(v_boost+1)/v_boost THEN','IF v_cap<2000*(v_boost+1)/v_boost OR v_gcfg.max_multiplier_cents<2000 THEN');
  END IF;
  IF replacement=source THEN RAISE EXCEPTION 'Wheel reservation repair matched nothing: %',sig; END IF;
  EXECUTE replacement;
 END LOOP;
END $repair$;
COMMIT;
