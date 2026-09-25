-- Run only in the private Diamond fixture created by test-accounting-delivery.sh.
-- THE ARITHMETIC OF WHEEL v4 (owner rulings 2026-09-21, R2/R12/R13/R15), proved
-- against the installed functions rather than against a copy of them. Read only:
-- no money, no spin, and the whole thing rolls back anyway.
--
--  1. the model is twelve ords summing to 100000, standard and VIP, and both
--     tables are worth exactly 0.8 of EVERY entry from 25 to 2500;
--  2. a VIP table carries no throwable, time bank or rabbit hunt at all;
--  3. the follow-up matrix is symmetric, zero on its diagonal, never zero off
--     it, and every row sums to that ord's own base weight;
--  4. so the base law is stationary: every column sums to the base weight too,
--     which is why the long-run mix is exactly 50/30/20 and the payback exactly
--     0.8 even though no prize may ever repeat;
--  5. no conditional expectation, standard or VIP, reaches the entry;
--  6. the cross-tier rule moves weight only between equally valued games, so
--     neither the main wheel's payback nor the Upgrade wheel's four entries move.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $probe$
DECLARE stake integer;i integer;j integer;g text;row_weights integer[];base integer[];up integer[];
 bad text;mix_games numeric;mix_chips numeric;mix_items numeric;worst numeric:=0;cond numeric;
 v_vip boolean;total_sixths numeric;
BEGIN
 IF current_database() IS DISTINCT FROM 'diamond_games_probe'
    OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN
   RAISE EXCEPTION 'wheel v4 model probe requires the isolated fixture';
 END IF;

 -- 1. THE MODEL, both tables.
 FOREACH v_vip IN ARRAY ARRAY[false,true] LOOP
  IF (SELECT count(*) FROM public.fn_wheel_v4_model(v_vip))<>12
   OR (SELECT count(DISTINCT ord) FROM public.fn_wheel_v4_model(v_vip))<>12
   OR (SELECT sum(weight) FROM public.fn_wheel_v4_model(v_vip))<>100000
   OR EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(v_vip) m WHERE m.kind='nothing' OR m.weight<=0) THEN
   RAISE EXCEPTION 'The v4 model is not twelve weighted prizes (vip %)',v_vip; END IF;
  SELECT sum(weight*value_sixths) INTO total_sixths FROM public.fn_wheel_v4_model(v_vip);
  IF total_sixths<>480000 THEN RAISE EXCEPTION 'The v4 payback is % sixths, not 480000 (vip %)',total_sixths,v_vip; END IF;
  -- Exact, for every permitted entry including every odd unit.
  FOR stake IN 25..2500 LOOP
   IF total_sixths/600000*stake<>.8*stake THEN
    RAISE EXCEPTION 'The v4 payback is not exactly 0.8 of % (vip %)',stake,v_vip; END IF;
  END LOOP;
  -- The four games, the Diamonds card game and Upgrade keep their ords and labels.
  IF (SELECT count(*) FROM public.fn_wheel_v4_model(v_vip) m WHERE m.kind='bonus')<>4
   OR (SELECT count(DISTINCT game) FROM public.fn_wheel_v4_model(v_vip) m WHERE m.kind='bonus')<>4
   OR (SELECT count(*) FROM public.fn_wheel_v4_model(v_vip) m WHERE m.kind='diamonds')<>1
   OR (SELECT count(*) FROM public.fn_wheel_v4_model(v_vip) m WHERE m.kind='upgrade')<>1 THEN
   RAISE EXCEPTION 'The v4 model lost a game, the card game or the Upgrade (vip %)',v_vip; END IF;
 END LOOP;
 -- 2. A VIP NEVER WINS AN ITEM (R2). Ords 3, 6 and 9 are chips of equal value.
 IF EXISTS(SELECT 1 FROM public.fn_wheel_v4_model(true) m WHERE m.kind IN('throwables','time_bank','rabbit_hunt'))
  OR (SELECT count(*) FROM public.fn_wheel_v4_model(true) m WHERE m.kind='chips')<>6
  OR (SELECT count(*) FROM public.fn_wheel_v4_model(false) m WHERE m.kind IN('throwables','time_bank','rabbit_hunt'))<>3
  OR (SELECT sum(weight*multiplier) FROM public.fn_wheel_v4_model(true) m WHERE m.ord IN(3,6,9))<>5000
  OR (SELECT sum(weight*multiplier) FROM public.fn_wheel_v4_model(false) m WHERE m.ord IN(3,6,9))<>5000 THEN
  RAISE EXCEPTION 'The VIP table is not the same money without the items'; END IF;
 IF (SELECT array_agg(ord ORDER BY ord) FROM public.fn_wheel_v4_model(true) m WHERE m.ord IN(3,6,9) AND m.multiplier IN(.2,.25,.3))<>ARRAY[3,6,9]::smallint[] THEN
  RAISE EXCEPTION 'The VIP chip ladder is not 0.2x, 0.25x and 0.3x'; END IF;
 -- The item prizes now cost a quarter of an entry, not half (R13).
 IF EXISTS(SELECT 1 FROM public.fn_wheel_v4_model() m WHERE m.kind IN('throwables','time_bank','rabbit_hunt') AND m.multiplier<>.25) THEN
  RAISE EXCEPTION 'An item prize is not a quarter of the entry'; END IF;

 -- 3. THE MATRIX (R12).
 SELECT array_agg(weight ORDER BY ord) INTO base FROM public.fn_wheel_v4_model();
 IF (SELECT count(*) FROM public.fn_wheel_v4_follow_model())<>144 THEN RAISE EXCEPTION 'The follow matrix is not twelve by twelve'; END IF;
 SELECT string_agg(format('(%s,%s)',f.prev_ord,f.ord),',') INTO bad
   FROM public.fn_wheel_v4_follow_model() f JOIN public.fn_wheel_v4_follow_model() t ON t.prev_ord=f.ord AND t.ord=f.prev_ord
  WHERE f.weight<>t.weight;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'The follow matrix is not symmetric at %',bad; END IF;
 IF EXISTS(SELECT 1 FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=f.ord AND f.weight<>0) THEN
  RAISE EXCEPTION 'A prize can still follow itself'; END IF;
 IF EXISTS(SELECT 1 FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord<>f.ord AND f.weight<1) THEN
  RAISE EXCEPTION 'A prize became unreachable after some other prize'; END IF;
 FOR i IN 1..12 LOOP
  IF (SELECT sum(weight) FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=i)<>base[i] THEN
   RAISE EXCEPTION 'Row % does not sum to its own base weight',i; END IF;
  -- 4. STATIONARITY, stated as the column sum, which is what makes the
  --    unconditional law of every spin the base law again.
  IF (SELECT sum(weight) FROM public.fn_wheel_v4_follow_model() f WHERE f.ord=i)<>base[i] THEN
   RAISE EXCEPTION 'Column % does not sum to its own base weight, so the mix would drift',i; END IF;
 END LOOP;
 -- The long-run mix is the base law, exactly 50 / 30 / 20.
 SELECT sum(weight) FILTER (WHERE kind IN('bonus','upgrade','diamonds')),
        sum(weight) FILTER (WHERE kind='chips'),
        sum(weight) FILTER (WHERE kind IN('throwables','time_bank','rabbit_hunt'))
   INTO mix_games,mix_chips,mix_items FROM public.fn_wheel_v4_model();
 IF mix_games<>50000 OR mix_chips<>30000 OR mix_items<>20000 THEN
  RAISE EXCEPTION 'The long-run mix is %/%/% out of 100000, not 50/30/20',mix_games,mix_chips,mix_items; END IF;
 -- 5. NO CONDITIONAL EXPECTATION REACHES THE ENTRY, standard or VIP.
 FOREACH v_vip IN ARRAY ARRAY[false,true] LOOP
  FOR i IN 1..12 LOOP
   SELECT sum(f.weight*m.value_sixths)/base[i]/6 INTO cond
     FROM public.fn_wheel_v4_follow_model() f JOIN public.fn_wheel_v4_model(v_vip) m ON m.ord=f.ord
    WHERE f.prev_ord=i;
   IF cond>=1 THEN RAISE EXCEPTION 'After ord % the wheel expects % of the entry (vip %)',i,cond,v_vip; END IF;
   worst:=GREATEST(worst,cond);
  END LOOP;
 END LOOP;
 -- The first spin ever draws the base law; the spin after ord i draws row i.
 IF public.fn_wheel_v4_weights(NULL::smallint) IS DISTINCT FROM base THEN
  RAISE EXCEPTION 'A first spin does not draw the base law'; END IF;
 FOR i IN 1..12 LOOP
  SELECT array_agg(f.weight ORDER BY f.ord) INTO row_weights FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=i;
  IF public.fn_wheel_v4_weights(i::smallint) IS DISTINCT FROM row_weights THEN
   RAISE EXCEPTION 'The spin after ord % does not draw row %',i,i; END IF;
 END LOOP;

 -- 6. THE CROSS-TIER RULE, value neutral on both wheels.
 SELECT array_agg(f.weight ORDER BY f.ord) INTO row_weights FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=12;
 FOREACH g IN ARRAY ARRAY['plinko','crash','crossing','mines'] LOOP
  base:=public.fn_wheel_v4_weights(12::smallint,g);
  i:=(SELECT ord FROM public.fn_wheel_v4_model() m WHERE m.game=g);
  IF base[i]<>0 THEN RAISE EXCEPTION 'Ordinary % can still follow Super %',g,g; END IF;
  IF (SELECT sum(w) FROM unnest(base) w)<>(SELECT sum(w) FROM unnest(row_weights) w) THEN
   RAISE EXCEPTION 'The cross-tier row for % changed its total',g; END IF;
  IF (SELECT sum(base[m.ord]*m.value_sixths) FROM public.fn_wheel_v4_model() m)
     <>(SELECT sum(row_weights[m.ord]*m.value_sixths) FROM public.fn_wheel_v4_model() m) THEN
   RAISE EXCEPTION 'The cross-tier row for % moved the payback',g; END IF;
  up:=public.fn_wheel_v4_upgrade_weights(g);
  j:=(SELECT ord FROM public.fn_wheel_v3_upgrade_model() u WHERE u.game=g);
  IF up[j]<>0 OR (SELECT sum(w) FROM unnest(up) w)<>100000 THEN
   RAISE EXCEPTION 'The Upgrade wheel after ordinary % is wrong: %',g,up; END IF;
  IF (SELECT sum(up[u.ord]*u.multiplier*CASE WHEN u.kind='bonus' THEN .8 ELSE 1 END) FROM public.fn_wheel_v3_upgrade_model() u)<>400000 THEN
   RAISE EXCEPTION 'The Upgrade wheel after ordinary % is no longer worth four entries',g; END IF;
 END LOOP;
 IF public.fn_wheel_v4_upgrade_weights(NULL) IS DISTINCT FROM (SELECT array_agg(weight ORDER BY ord) FROM public.fn_wheel_v3_upgrade_model()) THEN
  RAISE EXCEPTION 'An unconstrained Upgrade wheel is not the published one'; END IF;
 -- A repeated Upgrade is impossible, so an Upgrade never needs its own exclusion.
 IF (SELECT weight FROM public.fn_wheel_v4_follow_model() f WHERE f.prev_ord=12 AND f.ord=12)<>0 THEN
  RAISE EXCEPTION 'Two Upgrades in a row are possible'; END IF;

 -- THE THREE CARDS (R15): six sealed orders, each worth 11/6 of the risk.
 IF (SELECT count(DISTINCT public.fn_wheel_card_values(50,100,p::smallint)) FROM generate_series(0,5) p)<>6 THEN
  RAISE EXCEPTION 'The six card orders are not distinct'; END IF;
 FOR i IN 1..3 LOOP
  IF (SELECT sum((public.fn_wheel_card_values(50,100,p::smallint))[i]) FROM generate_series(0,5) p)<>11*100 THEN
   RAISE EXCEPTION 'Card position % does not average 11/6 of the risk',i; END IF;
 END LOOP;
 IF (SELECT count(*) FROM generate_series(0,5) p WHERE (SELECT count(DISTINCT v) FROM unnest(public.fn_wheel_card_values(50,100,p::smallint)) v)<>3)<>0 THEN
  RAISE EXCEPTION 'A sealed card order repeats a prize'; END IF;

 RAISE NOTICE 'PASS Wheel v4 model and matrix: twelve ords and 0.8 exactly for every entry 25..2500 standard and VIP, a VIP table with no items and the same 5000 on ords 3/6/9, a symmetric zero-diagonal matrix whose rows and columns both sum to the base law, the mix exactly 50/30/20, every conditional expectation at most % of the entry, the cross-tier rule value neutral on both wheels and six distinct card orders each worth 11/6',round(worst,6);
END $probe$;
ROLLBACK;
