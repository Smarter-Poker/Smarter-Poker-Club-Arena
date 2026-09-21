-- Run only in the private Diamond fixture created by test-accounting-delivery.sh
-- (owner ruling 2026-09-21 R16 audit). One paid spin per prize KIND the live
-- model can produce, on a standalone club and on a union host, each forced by
-- seed search over whatever fn_wheel_v3_model() returns today. For every spin:
-- the player wallet moves by exactly the entry (plus a diamond prize), and one
-- diamond_transactions row records it; a chip prize leaves the host PROMO
-- wallet first and the bank second, lands on the player exactly, and is
-- journaled in chip_ledger, chip_transactions and (union) union_wallet_
-- transactions summing to the prize; an item prize is a feature_purchases row
-- per grant; a bonus is an award row and nothing else; and the owner's custody
-- day equals the sum of its movements. Everything rolled back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL "request.jwt.claims"='{"role":"authenticated"}';
DO $$ BEGIN
  IF current_database() IS DISTINCT FROM 'diamond_games_probe'
     OR NOT EXISTS (SELECT 1 FROM public.ca_financial_epochs WHERE name='Isolated Diamond financial probe' AND is_current) THEN
    RAISE EXCEPTION 'ledger audit probe requires the isolated fixture';
  END IF;
END $$;
CREATE FUNCTION pg_temp.diamond_identity() RETURNS numeric LANGUAGE sql AS $$
 SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles)+public.fn_ca_arena_diamonds()
  +COALESCE((SELECT balance FROM public.ca_diamond_house WHERE id=1),0)-public.fn_ca_mint_supply('diamonds');
$$;
-- Force a primary outcome (and optionally a secondary kind) by searching seeds
-- against the live model, exactly as the spin draws: HMAC over 2^48.
CREATE FUNCTION pg_temp.force_spin(p_player uuid,p_club uuid,p_ord integer,p_entry integer,p_secondary_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE seed text;i integer;nonce bigint;point numeric;point2 numeric;commit uuid;outcome jsonb;total numeric;low numeric;high numeric;
 total2 numeric;secondary_low numeric;secondary_high numeric;found boolean:=false;
BEGIN
 SELECT sum(weight) INTO total FROM public.fn_wheel_v3_model();
 SELECT COALESCE(sum(weight) FILTER (WHERE ord<p_ord),0),sum(weight) FILTER (WHERE ord<=p_ord) INTO low,high FROM public.fn_wheel_v3_model();
 IF p_secondary_kind IS NOT NULL THEN
  SELECT sum(weight) INTO total2 FROM public.fn_wheel_v3_upgrade_model();
  SELECT COALESCE(sum(m2.weight) FILTER (WHERE m2.ord<m.ord),0),sum(m2.weight) FILTER (WHERE m2.ord<=m.ord) INTO secondary_low,secondary_high
   FROM (SELECT ord FROM public.fn_wheel_v3_upgrade_model() WHERE kind=p_secondary_kind ORDER BY weight DESC,ord LIMIT 1) m,public.fn_wheel_v3_upgrade_model() m2;
 END IF;
 SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=p_player;
 FOR i IN 1..200000 LOOP
  seed:=encode(extensions.digest('ledger-audit-'||p_club||'-'||p_ord||'-'||COALESCE(p_secondary_kind,'')||'-'||i,'sha256'),'hex');
  point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:audit:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*total/281474976710656);
  IF point>=low AND point<high THEN
   IF p_secondary_kind IS NULL THEN found:=true; EXIT; END IF;
   point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:audit:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*total2/281474976710656);
   IF point2>=secondary_low AND point2<secondary_high THEN found:=true; EXIT; END IF;
  END IF;
 END LOOP;
 IF NOT found THEN RAISE EXCEPTION 'No seed reaches ord % (%)',p_ord,p_secondary_kind; END IF;
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,p_player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 outcome:=public.fn_wheel_spin_v2(p_club,commit,'audit',p_entry,'paid',NULL);
 RESET ROLE;
 IF outcome->>'ok' IS DISTINCT FROM 'true' OR (outcome#>>'{outcome,ord}')::integer IS DISTINCT FROM p_ord THEN
  RAISE EXCEPTION 'Audit spin failed for ord %: %',p_ord,outcome; END IF;
 RETURN outcome;
END $$;
DO $probe$
DECLARE player uuid:='d1000000-0000-4000-8000-000000000005';owner uuid:='d1000000-0000-4000-8000-000000000002';
 club uuid:='d1000000-0000-4000-8000-000000000003';union_club uuid:='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';union_id uuid:='d1000000-0000-4000-8000-000000000004';
 d date:=(clock_timestamp() AT TIME ZONE 'America/Chicago')::date;
 h record;m record;result jsonb;spin uuid;prize jsonb;v_kind text;entry integer:=100;
 initial_identity numeric;player_before numeric;owner_before numeric;member_before numeric;cover_before record;cover_after record;
 pending_before numeric;rows_before bigint;journal_before bigint;chip_rows bigint;chip_total numeric;prize_chips numeric;from_promo numeric;from_bank numeric;
 grant_rows bigint;grant_uses numeric;grant_cost numeric;item_cost numeric;burn_rows bigint;dia_prize integer;spins integer:=0;kinds text[]:='{}';
 day_row public.diamond_spin_days;movement_sum record;secondary_kind text;grants_before uuid[];uw_before numeric;
BEGIN
 initial_identity:=pg_temp.diamond_identity();
 UPDATE public.diamond_wheel_release SET enabled=true;
 -- Both hosts funded and open. The union host is configured here only; the
 -- owner accepts its agreement through the real RPC.
 INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES(union_club,player,'player','active',0) ON CONFLICT DO NOTHING;
 INSERT INTO public.wheel_configs(host_id,host_kind,enabled,segment_version,purchased_only,welcome_spin_enabled,welcome_budget_chips,min_seconds_between_spins,exposure_allowance_chips)
  VALUES(union_id,'union',true,1,false,false,0,0,100000) ON CONFLICT (host_id) DO UPDATE SET enabled=true,purchased_only=false,min_seconds_between_spins=0,exposure_allowance_chips=100000;
 INSERT INTO public.wheel_pools(host_id,diamond_float,diamond_seed) VALUES(union_id,2500,2500) ON CONFLICT DO NOTHING;
 UPDATE public.wheel_configs SET exposure_allowance_chips=100000,min_seconds_between_spins=0,purchased_only=false WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
  SELECT x.host,x.kind,g,true,0,100000 FROM (VALUES(club,'club'),(union_id,'union')) x(host,kind),unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT x.host,g FROM (VALUES(club),(union_id)) x(host),unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET exposure_allowance_chips=100000,min_seconds_between_rounds=0,enabled=true WHERE host_id IN(club,union_id);
 PERFORM set_config('test.user',owner::text,true);
 SET LOCAL ROLE authenticated;
 result:=public.fn_diamond_spins_owner_terms(union_club,true);
 RESET ROLE;
 PERFORM set_config('test.user',player::text,true);
 IF result->>'ok' IS DISTINCT FROM 'true' OR NOT public.fn_diamond_spins_owner_agreed(union_id,'union') THEN RAISE EXCEPTION 'Union agreement not recorded: %',result; END IF;
 FOR h IN SELECT * FROM (VALUES(club,'club'::text,club),(union_id,'union'::text,union_club)) x(host,kind,club_id) LOOP
  -- One spin per prize kind in the live model. Kinds that end the player's
  -- run (a bonus award blocks the next spin) come last; an Upgrade is forced
  -- onto an instant-chip secondary so the run can continue.
  FOR m IN SELECT DISTINCT ON (x.kind) x.ord,x.kind FROM public.fn_wheel_v3_model() x ORDER BY x.kind,x.weight DESC,x.ord LOOP
   IF m.kind='bonus' THEN CONTINUE; END IF;
   v_kind:=m.kind;secondary_kind:=CASE WHEN v_kind='upgrade' THEN 'chips' END;
   -- The chip prize must cross from Promo into the bank: pay Promo down to half
   -- of one entry's worth first, through the same writer.
   SELECT * INTO cover_before FROM public.fn_diamond_game_cover_lock(h.host,h.kind);
   IF v_kind IN('chips','upgrade') AND cover_before.o_promo>0.50 THEN
    PERFORM public.fn_diamond_game_pay_chips('wheel_prize',h.host,h.kind,h.club_id,player,cover_before.o_promo-0.50,'audit:drain:'||gen_random_uuid(),'Isolated Promo Drain','{}'::jsonb);
    SELECT * INTO cover_before FROM public.fn_diamond_game_cover_lock(h.host,h.kind);
   END IF;
   SELECT diamonds INTO player_before FROM public.profiles WHERE id=player;
   SELECT diamonds INTO owner_before FROM public.profiles WHERE id=owner;
   SELECT chip_balance INTO member_before FROM public.club_members WHERE club_id=h.club_id AND user_id=player;
   SELECT COALESCE(pending_diamonds,0) INTO pending_before FROM public.diamond_spin_days WHERE owner_id=owner AND day=d;
   SELECT count(*) INTO journal_before FROM public.diamond_transactions WHERE user_id=player;
   SELECT COALESCE(array_agg(id),'{}') INTO grants_before FROM public.feature_purchases WHERE user_id=player;
   SELECT COALESCE(sum(uw.amount),0) INTO uw_before FROM public.union_wallet_transactions uw WHERE uw.union_id=h.host AND uw.club_id=h.club_id AND uw.tx_type='wheel_prize' AND uw.direction='debit';
   result:=pg_temp.force_spin(player,h.club_id,m.ord,entry,secondary_kind);
   spin:=(result->>'spin_id')::uuid;prize:=result->'outcome';spins:=spins+1;kinds:=kinds||v_kind;
   IF v_kind='upgrade' THEN prize:=result#>'{secondary,outcome}'; IF prize->>'kind'<>'chips' THEN RAISE EXCEPTION 'Upgrade did not land chips: %',result; END IF; END IF;
   -- 1. The entry: exactly one player journal row, the wallet moved by exactly that.
   IF (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND reference_id='wheel:'||spin AND amount=-entry AND transaction_type='wheel_spin' AND type='wheel_spin')<>1 THEN
    RAISE EXCEPTION 'No exact entry journal row for % spin %',v_kind,spin; END IF;
   IF (SELECT diamonds FROM public.profiles WHERE id=owner)<>owner_before THEN RAISE EXCEPTION 'Owner wallet moved on a spin (%)',v_kind; END IF;
   -- 2. Custody: the entry lands in the owner's open day as one movement.
   IF (SELECT count(*) FROM public.diamond_spin_movements WHERE operation_id='wheel:'||spin||':intake' AND owner_id=owner AND host_id=h.host AND host_kind=h.kind AND player_id=player AND kind='entry' AND amount=entry AND day=d)<>1 THEN
    RAISE EXCEPTION 'No custody intake movement for % spin %',v_kind,spin; END IF;
   dia_prize:=0;item_cost:=0;
   IF v_kind='diamonds' THEN
    dia_prize:=(prize->>'amount')::integer;
    IF dia_prize<=0 OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND reference_id='wheel:'||spin||':prize' AND amount=dia_prize AND transaction_type='transfer' AND issuance_class='transferred')<>1
     OR (SELECT count(*) FROM public.diamond_spin_movements WHERE operation_id='wheel:'||spin||':diamond-prize' AND kind='diamond_prize' AND amount=-dia_prize AND owner_id=owner)<>1 THEN
     RAISE EXCEPTION 'Diamond prize % not journaled both sides for spin %',dia_prize,spin; END IF;
   END IF;
   IF (SELECT diamonds FROM public.profiles WHERE id=player)<>player_before-entry+dia_prize
    OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>journal_before+1+(dia_prize>0)::int THEN
    RAISE EXCEPTION 'Player wallet moved without a matching journal on % spin %: % -> %',v_kind,spin,player_before,(SELECT diamonds FROM public.profiles WHERE id=player); END IF;
   -- 3. Chips: Promo first, then the bank, credited to the player exactly, journaled everywhere.
   IF prize->>'kind'='chips' THEN
    prize_chips:=(prize->>'value_chips')::numeric;
    SELECT * INTO cover_after FROM public.fn_diamond_game_cover_lock(h.host,h.kind);
    from_promo:=cover_before.o_promo-cover_after.o_promo;from_bank:=cover_before.o_bank-cover_after.o_bank;
    SELECT count(*),COALESCE(sum(amount),0) INTO chip_rows,chip_total FROM public.chip_ledger
     WHERE idempotency_key IN('wheel-prize:'||spin,'wheel-prize:'||spin||':bank') AND status='posted' AND category='wheel_prize' AND to_type='player_wallet' AND to_entity_id=player;
    IF prize_chips<=0 OR from_promo<>LEAST(prize_chips,cover_before.o_promo) OR from_bank<>prize_chips-from_promo OR from_bank<=0
     OR chip_total<>prize_chips OR chip_rows<>(from_promo>0)::int+1
     OR (SELECT chip_balance FROM public.club_members WHERE club_id=h.club_id AND user_id=player)<>member_before+prize_chips
     OR (SELECT count(*) FROM public.chip_transactions WHERE club_id=h.club_id AND to_user_id=player AND transaction_type='wheel_prize' AND amount=prize_chips
          AND (metadata->>'from_promo')::numeric=from_promo AND (metadata->>'from_bank')::numeric=from_bank)<>1
     OR (SELECT COALESCE(sum(uw.amount),0) FROM public.union_wallet_transactions uw WHERE uw.union_id=h.host AND uw.club_id=h.club_id AND uw.tx_type='wheel_prize' AND uw.direction='debit')-uw_before
        <>(CASE WHEN h.kind='union' THEN prize_chips ELSE 0 END)
     OR (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key='wheel-prize:'||spin||':bank' AND from_type=(CASE WHEN h.kind='union' THEN 'union_bank' ELSE 'club_treasury' END) AND amount=from_bank)<>1
     OR (from_promo>0 AND (SELECT count(*) FROM public.chip_ledger WHERE idempotency_key='wheel-prize:'||spin AND from_type=(CASE WHEN h.kind='union' THEN 'union_wallet' ELSE 'promo_wallet' END) AND amount=from_promo)<>1)
     OR EXISTS(SELECT 1 FROM public.settlement_invoices i JOIN public.chip_ledger l ON l.id=i.source_ledger_id WHERE l.idempotency_key IN('wheel-prize:'||spin,'wheel-prize:'||spin||':bank')) THEN
     RAISE EXCEPTION 'Chip prize % on % not paid Promo-first and journaled exactly for spin %: promo % bank % rows % total %',prize_chips,h.kind,spin,from_promo,from_bank,chip_rows,chip_total; END IF;
   ELSIF v_kind IN('throwables','time_bank','rabbit_hunt') THEN
    -- 4. Items: one feature_purchases row per grant, and the owner custody cost
    --    equals the granted uses at their recorded price, retired in the register.
    SELECT count(*),COALESCE(sum(uses_remaining),0),COALESCE(sum(cost),0) INTO grant_rows,grant_uses,grant_cost FROM public.feature_purchases
     WHERE user_id=player AND source='diamond_wheel' AND NOT (id=ANY(grants_before));
    SELECT COALESCE(-sum(amount),0),count(*) INTO item_cost,burn_rows FROM public.diamond_spin_movements
     WHERE operation_id IN('wheel:'||spin||':inventory','wheel:'||spin||':inventory-remainder') AND owner_id=owner AND kind IN('throwable','time_bank','rabbit_hunt');
    IF grant_rows<>jsonb_array_length(prize->'grants') OR grant_uses<>(SELECT sum((g->>'uses')::numeric) FROM jsonb_array_elements(prize->'grants') g)
     OR grant_cost<>item_cost OR item_cost<=0
     OR (SELECT count(*) FROM public.ca_mint_ledger x JOIN public.diamond_spin_movements mv ON x.op_id='diamond-spin-custody:'||mv.id
          WHERE mv.operation_id IN('wheel:'||spin||':inventory','wheel:'||spin||':inventory-remainder') AND x.action='burn' AND x.amount=-mv.amount)<>burn_rows THEN
     RAISE EXCEPTION 'Item prize % not recorded exactly for spin %: grants % uses % cost % custody %',v_kind,spin,grant_rows,grant_uses,grant_cost,item_cost; END IF;
    IF (SELECT chip_balance FROM public.club_members WHERE club_id=h.club_id AND user_id=player)<>member_before THEN RAISE EXCEPTION 'Item prize moved chips'; END IF;
   ELSIF v_kind='diamonds' THEN
    IF (SELECT chip_balance FROM public.club_members WHERE club_id=h.club_id AND user_id=player)<>member_before THEN RAISE EXCEPTION 'Diamond prize moved chips'; END IF;
   ELSE
    RAISE EXCEPTION 'The live model produced a kind this audit does not know: % (%)',v_kind,prize;
   END IF;
   -- 5. The owner's open day moved by exactly the movements this spin wrote.
   IF (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>pending_before+entry-dia_prize-item_cost THEN
    RAISE EXCEPTION 'Custody day did not move by the movements of % spin %',v_kind,spin; END IF;
   IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Supply drifted on % spin %',v_kind,spin; END IF;
  END LOOP;
  -- 6. The bonus kind: an award row, nothing paid, nothing debited beyond the entry.
  SELECT x.ord,x.kind INTO m FROM public.fn_wheel_v3_model() x WHERE x.kind='bonus' ORDER BY x.weight DESC,x.ord LIMIT 1;
  IF FOUND THEN
   SELECT diamonds INTO player_before FROM public.profiles WHERE id=player;
   SELECT chip_balance INTO member_before FROM public.club_members WHERE club_id=h.club_id AND user_id=player;
   SELECT COALESCE(pending_diamonds,0) INTO pending_before FROM public.diamond_spin_days WHERE owner_id=owner AND day=d;
   result:=pg_temp.force_spin(player,h.club_id,m.ord,entry);spin:=(result->>'spin_id')::uuid;spins:=spins+1;kinds:=kinds||'bonus'::text;
   IF (SELECT count(*) FROM public.wheel_bonus_awards WHERE spin_id=spin AND user_id=player AND host_id=h.host AND entry_diamonds=entry AND status='pending')<>1
    OR (SELECT diamonds FROM public.profiles WHERE id=player)<>player_before-entry
    OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player AND reference_id='wheel:'||spin AND amount=-entry)<>1
    OR (SELECT chip_balance FROM public.club_members WHERE club_id=h.club_id AND user_id=player)<>member_before
    OR (SELECT pending_diamonds FROM public.diamond_spin_days WHERE owner_id=owner AND day=d)<>pending_before+entry
    OR EXISTS(SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE 'wheel-prize:'||spin||'%') THEN
    RAISE EXCEPTION 'Bonus award not recorded as an award only for spin %',spin; END IF;
   -- The award blocks the next spin in THIS club only; the other host is its own run.
  END IF;
 END LOOP;
 -- 7. The day equals its movements, column by column.
 SELECT * INTO day_row FROM public.diamond_spin_days WHERE owner_id=owner AND day=d;
 SELECT sum(amount) total,count(*) n,
  sum(amount) FILTER (WHERE kind='entry') entries,-sum(amount) FILTER (WHERE kind='diamond_prize') prizes,
  -sum(amount) FILTER (WHERE kind='throwable') throwables,-sum(amount) FILTER (WHERE kind='time_bank') time_banks,-sum(amount) FILTER (WHERE kind='rabbit_hunt') rabbit_hunts
  INTO movement_sum FROM public.diamond_spin_movements WHERE owner_id=owner AND day=d;
 IF day_row.status<>'open' OR day_row.pending_diamonds<>movement_sum.total OR day_row.movement_count<>movement_sum.n
  OR day_row.entry_diamonds<>movement_sum.entries OR day_row.diamond_prizes<>COALESCE(movement_sum.prizes,0)
  OR day_row.throwables<>COALESCE(movement_sum.throwables,0) OR day_row.time_banks<>COALESCE(movement_sum.time_banks,0) OR day_row.rabbit_hunts<>COALESCE(movement_sum.rabbit_hunts,0)
  OR day_row.pending_diamonds<>day_row.entry_diamonds+day_row.bonus_diamonds+day_row.mint_entry_diamonds-day_row.diamond_prizes-day_row.throwables-day_row.time_banks-day_row.rabbit_hunts-day_row.other_expenses THEN
  RAISE EXCEPTION 'Custody day does not equal its movements: % vs %',to_jsonb(day_row),to_jsonb(movement_sum); END IF;
 -- 8. Nothing moved anywhere without a row: player wallet equals its journal, member chips equal their legs.
 IF (SELECT diamonds FROM public.profiles WHERE id=player)<>100000+(SELECT COALESCE(sum(amount),0) FROM public.diamond_transactions WHERE user_id=player) THEN
  RAISE EXCEPTION 'Player wallet and journal disagree'; END IF;
 IF (SELECT sum(chip_balance) FROM public.club_members WHERE user_id=player AND club_id IN(club,union_club))
    <>(SELECT COALESCE(sum(amount),0) FROM public.chip_ledger WHERE to_type='player_wallet' AND to_entity_id=player AND status='posted')
   OR (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger WHERE to_type='player_wallet' AND to_entity_id=player AND status='posted')
    <>(SELECT COALESCE(sum(amount),0) FROM public.chip_transactions WHERE to_user_id=player) THEN
  RAISE EXCEPTION 'Member chips, chip_ledger and chip_transactions disagree'; END IF;
 IF pg_temp.diamond_identity()<>initial_identity THEN RAISE EXCEPTION 'Final supply drift'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 RAISE NOTICE 'PASS Every movement has a ledger row: exact entry journal and custody intake per spin, Promo-first then bank chip prizes journaled in chip_ledger, chip_transactions and union wallet rows, diamond prizes both sides, item grants as feature_purchases with retired custody, bonus as an award only, day equals movements, wallets equal journals, no documents; % paid spins over both hosts (%)',spins,array_to_string(kinds,',');
END $probe$;
ROLLBACK;
