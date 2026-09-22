-- Private, synthetic PostgreSQL only. Actual JWT role and canonical payout legs.
-- Owner rulings of 2026-09-21 (R3, R6, R10, R11, R16), qualified on the real
-- starters, actor, deciders, quotes and receipts after migration 20260921203512:
--   the first step of a bonus game never ruins it (Mines first tile a gem, road
--   street one certain, Crash never below 1.10x); the floor is half the stake, or
--   for a Super award what the player paid, add-on included; Plinko's drop value
--   is the player's again and the floor guards the whole run; the add-on debit
--   names its amount; every payout leaves one chip journal and one transaction.
-- Every expectation below is derived first and read back second. Rolled back.
BEGIN;
SET LOCAL statement_timeout='300s';
SET LOCAL "test.user"='d1000000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}';
DO $$
#variable_conflict use_variable
DECLARE
 player uuid:='d1000000-0000-4000-8000-000000000005'; club uuid:='d1000000-0000-4000-8000-000000000003';
 owner uuid:='d1000000-0000-4000-8000-000000000002';
 c_two48 constant numeric:=281474976710656;
 game text; variant integer; point numeric; point2 numeric; roll numeric; seed text; commit uuid; ticket uuid; nonce bigint; i integer; k integer;
 result jsonb; state jsonb; started jsonb; settled jsonb; refused jsonb; replayed jsonb; award uuid; rid uuid; cell integer; drop jsonb;
 bet numeric; minimum numeric; before_chips numeric; before_dia numeric; paid numeric; ref text; key text;
 secondary_low integer; secondary_high integer; mode text; board integer[]; dealt integer[]; entry integer; stake integer; floor_cents integer;
 prizes numeric[]; ladder integer[]; survivors numeric; ev numeric; target integer; hits bigint; expect numeric; band numeric;
 counts bigint[]; chi numeric; n_boards integer:=2048; tx record; move record; leg record; ctx record; n_tx integer; n_moves integer;
 denoms jsonb; report text:='';
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 UPDATE public.wheel_configs SET exposure_allowance_chips=1000000 WHERE host_id=club;
 INSERT INTO public.diamond_game_configs(host_id,host_kind,game,enabled,min_seconds_between_rounds,exposure_allowance_chips)
 SELECT club,'club',g,true,0,1000000 FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 INSERT INTO public.diamond_game_pools(host_id,game) SELECT club,g FROM unnest(ARRAY['plinko','crash','crossing','mines']) g ON CONFLICT DO NOTHING;
 UPDATE public.diamond_game_configs SET enabled=true,exposure_allowance_chips=1000000,min_seconds_between_rounds=0,max_multiplier_cents=100000,max_bet_diamonds=7500 WHERE host_id=club;
 UPDATE public.diamond_wheel_release SET enabled=true;

 -- ── 0. THE INSTALLED DESIGN, READ BACK ────────────────────────────────────
 IF (SELECT array_agg(version ORDER BY version) FROM public.plinko_tables WHERE activated_at IS NOT NULL) IS DISTINCT FROM ARRAY[4,6] THEN RAISE EXCEPTION 'Open Plinko Tables Are Not Super And Super Double'; END IF;
 IF (SELECT multipliers_cents FROM public.plinko_tables WHERE version=6) IS DISTINCT FROM ARRAY[2000,2000,1000,170,80,75,75,73,72,73,75,75,80,170,1000,2000,2000]
  OR (SELECT spec_rtp FROM public.plinko_tables WHERE version=6)<>0.800000 OR (SELECT hit_rate FROM public.plinko_tables WHERE version=6)<>1 THEN RAISE EXCEPTION 'Super Double Table Is Not As Designed'; END IF;
 -- Exact 0.80 on C(16,k)/65536, in integers, for both open tables.
 FOR variant IN SELECT version FROM public.plinko_tables WHERE activated_at IS NOT NULL LOOP
  IF (SELECT sum(public.fn_choice_choose(16,(s-1)::integer)*m) FROM public.plinko_tables t, unnest(t.multipliers_cents) WITH ORDINALITY x(m,s) WHERE t.version=variant)<>5242880 THEN
   RAISE EXCEPTION 'Plinko Table % Is Not Exactly 0.80',variant; END IF;
 END LOOP;
 ladder:=public.fn_choice_ladder_v4('road');
 IF ladder[1]<>80 OR cardinality(ladder)<>12 OR ladder[12]<>2000 OR (public.fn_choice_ladder('road'))[1]<>110 THEN RAISE EXCEPTION 'The Road Is Not As Designed'; END IF;

 -- ── 1. THE FLOOR, FOR EVERY REACHABLE STAKE, IN CENTS ─────────────────────
 -- An entry E of 25..2500 diamonds: ordinary stake E (floor half), ordinary with
 -- the add-on 2E (half), Super 2E (the entry E), Super with the add-on 3E (the 2E
 -- paid). Every floor is whole cents, the designed value, strictly under 0.80 of
 -- the stake, and the cent-under-0.80 clamp never binds.
 FOR entry IN 25..2500 LOOP
  IF public.fn_diamond_bonus_floor(entry::numeric/100,1,entry,100)*100<>ceil(entry/2.0) THEN RAISE EXCEPTION 'Ordinary Floor Wrong At %',entry; END IF;
  IF public.fn_diamond_bonus_floor(entry*2::numeric/100,1,entry*2,100)*100<>entry THEN RAISE EXCEPTION 'Ordinary Add-On Floor Wrong At %',entry; END IF;
  IF public.fn_diamond_bonus_floor(entry*2::numeric/100,2,entry,100)*100<>entry THEN RAISE EXCEPTION 'Super Floor Wrong At %',entry; END IF;
  IF public.fn_diamond_bonus_floor(entry*3::numeric/100,2,entry*2,100)*100<>entry*2 THEN RAISE EXCEPTION 'Super Add-On Floor Wrong At %',entry; END IF;
  IF ceil(entry/2.0)*5>=4*entry OR entry*5>=4*entry*2 OR entry*2*5>=4*entry*3 THEN RAISE EXCEPTION 'A Floor Beats The Edge At %',entry; END IF;
  -- The table that carries each floor through its multipliers: 0.52x carries the half, 0.72x the two thirds.
  IF public.fn_plinko_table_for_floor(entry::numeric/100,ceil(entry/2.0)/100)<>4 OR public.fn_plinko_table_for_floor(entry*3::numeric/100,entry*2::numeric/100)<>6 THEN RAISE EXCEPTION 'Plinko Table Routing Wrong At %',entry; END IF;
  IF 52*entry<100*ceil(entry/2.0) OR 72*entry*3<100*entry*2 THEN RAISE EXCEPTION 'A Lowest Slot Is Under Its Floor At %',entry; END IF;
 END LOOP;
 -- The owner's example, to the cent.
 IF public.fn_diamond_bonus_floor(75,2,5000,100)<>50 OR public.fn_diamond_bonus_floor(50,2,2500,100)<>25 OR public.fn_diamond_bonus_floor(25,1,2500,100)<>12.5 THEN RAISE EXCEPTION 'The Owner''s Example Is Wrong'; END IF;

 -- ── 2. CRASH: NEVER BELOW 1.10x, AND EVERY TARGET ABOVE IT IS STILL 0.80B ──
 -- P(point >= x) = floor((0.8B - L) 2^48 / (xB/100 - L)) / 2^48 exactly, so the
 -- value of "always cash at x" is that share of xB plus the rest at L: at most
 -- one roll's grain under 0.8B, never over. Proved for the flat two-thirds floor
 -- (Super with the add-on, the harshest), the half, and the sealed extremes.
 FOREACH minimum IN ARRAY ARRAY[0.5,2.0/3] LOOP
  bet:=1;
  IF public.fn_crash_point_cents(c_two48-1,bet,minimum)<>110 OR public.fn_crash_point_cents(0,bet,minimum)<110 THEN RAISE EXCEPTION 'Crash Floor Is Not 1.10x'; END IF;
  FOREACH target IN ARRAY ARRAY[111,112,150,200,500,1000,2000,10000] LOOP
   survivors:=floor((bet*0.8-minimum)*c_two48/(bet*target/100.0-minimum));
   IF public.fn_crash_point_cents(survivors-1,bet,minimum)<target OR public.fn_crash_point_cents(survivors,bet,minimum)>=target THEN RAISE EXCEPTION 'Crash Boundary Wrong At %x',target; END IF;
   ev:=survivors/c_two48*bet*target/100+(1-survivors/c_two48)*minimum;
   IF ev>bet*0.8 OR bet*0.8-ev>(bet*target/100-minimum)/c_two48 THEN RAISE EXCEPTION 'Crash Target %x Is Not Worth 0.80 (%)',target,ev; END IF;
  END LOOP;
  -- Sampled through the real function, against the closed form, fixed seeds.
  FOREACH target IN ARRAY ARRAY[111,150,500] LOOP
   hits:=0; seed:=encode(extensions.digest('first-step-crash-'||minimum||'-'||target,'sha256'),'hex');
   FOR i IN 0..16383 LOOP
    roll:=(('x'||substr(encode(extensions.hmac('first-step:crash:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
    point:=public.fn_crash_point_cents(roll,bet,minimum);
    IF point<110 THEN RAISE EXCEPTION 'Crash Point % Below 1.10x',point; END IF;
    IF point>=target THEN hits:=hits+1; END IF;
   END LOOP;
   expect:=(bet*0.8-minimum)/(bet*target/100.0-minimum);
   band:=4*sqrt(expect*(1-expect)/16384)+0.001;
   IF abs(hits::numeric/16384-expect)>band THEN RAISE EXCEPTION 'Crash Survival To %x Was %, Expected %',target,round(hits::numeric/16384,4),round(expect,4); END IF;
  END LOOP;
 END LOOP;

 -- ── 3. THE ROAD: STREET ONE IS CERTAIN, EVERY STREET IS 0.80B ──────────────
 FOREACH minimum IN ARRAY ARRAY[0.5,2.0/3] LOOP
  bet:=1; prizes:=public.fn_choice_prizes_v4('crossing','road',bet,minimum);
  IF cardinality(prizes)<>12 OR prizes[1]<>0.8 OR prizes[12]<>20 THEN RAISE EXCEPTION 'Road Prizes Wrong'; END IF;
  -- The extreme rolls both survive street one; nothing else can.
  FOREACH roll IN ARRAY ARRAY[0,c_two48-1] LOOP
   IF NOT ((roll+1)*(prizes[1]-minimum)<=(bet*0.8-minimum)*c_two48) THEN RAISE EXCEPTION 'Street One Lost On Roll %',roll; END IF;
  END LOOP;
  FOR k IN 2..12 LOOP
   survivors:=floor((bet*0.8-minimum)*c_two48/(prizes[k]-minimum));
   IF survivors>=c_two48 OR NOT ((survivors)*(prizes[k]-minimum)<=(bet*0.8-minimum)*c_two48) OR (survivors+1)*(prizes[k]-minimum)<=(bet*0.8-minimum)*c_two48 THEN RAISE EXCEPTION 'Street % Boundary Wrong',k; END IF;
   ev:=survivors/c_two48*prizes[k]+(1-survivors/c_two48)*minimum;
   IF ev>bet*0.8 OR bet*0.8-ev>(prizes[k]-minimum)/c_two48 THEN RAISE EXCEPTION 'Street % Is Not Worth 0.80',k; END IF;
   IF prizes[k]<=prizes[k-1] THEN RAISE EXCEPTION 'The Road Is Not Monotone At %',k; END IF;
  END LOOP;
 END LOOP;

 -- ── 4. THE MINES: THE BOARD IS DEALT AROUND THE FIRST PICK, AND IS FAIR ─────
 -- Every stop is L + (0.8B - L) C(24,k-1)/C(18,k-1), worth 0.80B against
 -- P(survive k) = C(18,k-1)/C(24,k-1); the first gem pays 0.80B.
 FOREACH minimum IN ARRAY ARRAY[0.5,2.0/3] LOOP
  prizes:=public.fn_choice_prizes_v4('mines','6',1,minimum);
  IF cardinality(prizes)<>19 OR prizes[1]<>0.8 THEN RAISE EXCEPTION 'Mines Ladder Wrong'; END IF;
  FOR k IN 1..19 LOOP
   ev:=prizes[k]*public.fn_choice_choose(18,k-1)/public.fn_choice_choose(24,k-1)+minimum*(1-public.fn_choice_choose(18,k-1)/public.fn_choice_choose(24,k-1));
   IF abs(ev-0.8)>0.000000001 OR prizes[k]<=minimum OR (k>1 AND prizes[k]<=prizes[k-1]) THEN RAISE EXCEPTION 'Mines Stop % Is Not Worth 0.80 (%)',k,ev; END IF;
  END LOOP;
 END LOOP;
 -- The dealt board never holds the first pick, has six distinct other cells, and
 -- hides a mine in each of the other twenty-four with probability 6/24.
 counts:=array_fill(0::bigint,ARRAY[25]);
 FOR i IN 0..n_boards-1 LOOP
  cell:=i%25;
  board:=public.fn_choice_board_v4(encode(extensions.digest('first-step-mines-'||i,'sha256'),'hex'),'first-step',1,6,cell);
  IF cardinality(board)<>6 OR cell=ANY(board) OR (SELECT count(DISTINCT x) FROM unnest(board) x)<>6 OR (SELECT min(x) FROM unnest(board) x)<0 OR (SELECT max(x) FROM unnest(board) x)>24 THEN
   RAISE EXCEPTION 'Board % Around First Pick % Is Wrong: %',i,cell,board; END IF;
  FOREACH k IN ARRAY board LOOP counts[k+1]:=counts[k+1]+1; END LOOP;
 END LOOP;
 -- Each cell is the first pick in 1/25 of the boards and a mine in 6/24 of the rest.
 expect:=n_boards::numeric*24/25*6/24; chi:=0;
 FOR k IN 1..25 LOOP chi:=chi+(counts[k]-expect)^2/expect; END LOOP;
 IF chi>66.6 THEN RAISE EXCEPTION 'Mines Boards Around The First Pick Are Biased: % (%)',round(chi,2),counts; END IF;
 report:=report||format(' mines boards chi2 %s over %s;',round(chi,2),n_boards);

 -- ── 5. THE OWNER'S EXAMPLE, PLAYED: 2,500 SPIN + 2,500 ADD-ON, FOUR SUPER GAMES ──
 FOR variant IN 1..4 LOOP
  game:=(ARRAY['plinko','crash','crossing','mines'])[variant];
  secondary_low:=(variant-1)*20000; secondary_high:=variant*20000;
  SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('first-step-wheel-'||game||i,'sha256'),'hex');
   point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:first-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
   point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:first-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
   EXIT WHEN point>=98000 AND point2>=secondary_low AND point2<secondary_high;
  END LOOP;
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'first-client',2500,'paid',NULL);
  RESET ROLE;
  IF result->>'ok'<>'true' OR (result#>>'{outcome,ord}')::integer<>12 OR result#>>'{secondary,outcome,game}' IS DISTINCT FROM game THEN RAISE EXCEPTION 'Expected A Super % Award: %',game,result; END IF;
  award:=(result#>>'{bonus,id}')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.wheel_bonus_awards WHERE id=award AND boost_multiplier=2 AND base_diamonds=5000 AND entry_diamonds=2500) THEN RAISE EXCEPTION 'Super Award Shape Wrong'; END IF;
  bet:=75; minimum:=50; stake:=7500;

  -- The quote, WITH the add-on, says exactly what the start will seal.
  SET LOCAL ROLE authenticated;
  state:=public.fn_wheel_bonus_state(club,game,true,NULL,award);
  RESET ROLE;
  IF state->>'ok'<>'true' OR state#>>'{game_state,guarantee}'<>'super' OR (state#>>'{game_state,minimum_payout_chips}')::numeric<>minimum
   OR (state#>>'{game_state,payout_version}')::integer<>4 OR (state#>>'{game_state,paid_diamonds}')::integer<>5000 OR (state#>>'{game_state,bet_diamonds}')::integer<>stake
   OR (state#>>'{game_state,plinko_table}')::integer<>6 OR (state#>>'{game_state,cashout_floor_cents}')::integer<>111 OR (state#>>'{game_state,crash_floor_cents}')::integer<>110
   OR state#>'{game_state,plinko_denominations}'<>'[100,250,500,7500]'::jsonb THEN RAISE EXCEPTION 'Super Add-On Quote Wrong For %: %',game,state; END IF;
  IF game='crossing' AND ((state#>>'{game_state,prizes,0}')::numeric<>bet*0.8 OR (state#>>'{game_state,prizes,1}')::numeric<>bet*1.45 OR (state#>>'{game_state,max_steps}')::integer<>12) THEN RAISE EXCEPTION 'Super Road Quote Wrong: %',state; END IF;
  IF game='mines' AND ((state#>>'{game_state,prizes,0}')::numeric<>bet*0.8 OR abs((state#>>'{game_state,prizes,1}')::numeric-(minimum+(bet*0.8-minimum)*24/18.0))>0.000001) THEN RAISE EXCEPTION 'Super Mines Quote Wrong: %',state; END IF;
  -- And WITHOUT the add-on the Super floor is the entry, unchanged: 25 chips on a 2,500 spin.
  SET LOCAL ROLE authenticated;
  state:=public.fn_wheel_bonus_state(club,game,false,NULL,award);
  RESET ROLE;
  IF (state#>>'{game_state,minimum_payout_chips}')::numeric<>25 OR (state#>>'{game_state,paid_diamonds}')::integer<>2500 OR (state#>>'{game_state,plinko_table}')::integer<>4 THEN RAISE EXCEPTION 'Super Quote Without The Add-On Wrong For %: %',game,state; END IF;

  -- A game seed with a known ending: Crash floored at 1.10x, the road losing street two, any Mines board, any Plinko run.
  IF game='crash' THEN SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
  ELSIF game='plinko' THEN nonce:=0;
  ELSE SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game; END IF;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('first-step-game-'||game||i,'sha256'),'hex');
   roll:=(('x'||substr(encode(extensions.hmac('first-game:'||nonce||CASE WHEN game='crossing' THEN ':road' ELSE '' END,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   EXIT WHEN game IN('mines','plinko') OR (game='crossing' AND (roll+1)*(bet*1.45-minimum)>(bet*0.8-minimum)*c_two48) OR (game='crash' AND public.fn_crash_point_cents(roll,bet,minimum)=110);
  END LOOP;
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  mode:=public.fn_choice_mode(game);
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
  SELECT diamonds INTO before_dia FROM public.profiles WHERE id=player;
  SELECT count(*) INTO n_tx FROM public.diamond_transactions WHERE user_id=player;
  SELECT count(*) INTO n_moves FROM public.diamond_spin_movements WHERE owner_id=owner;

  -- Refusals cost nothing and leave the award pending.
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN
   refused:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,50,6,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Choose A Drop Value That Plays Every Diamond In One To One Hundred Drops' THEN RAISE EXCEPTION '150 Drops Were Not Refused: %',refused; END IF;
   refused:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,75,6,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Choose A Drop Value That Plays Every Diamond In One To One Hundred Drops' THEN RAISE EXCEPTION 'An Unlisted Drop Value Was Not Refused: %',refused; END IF;
   refused:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,250,4,NULL,NULL);
   IF refused->>'error' IS DISTINCT FROM 'Plinko Has One Table. Refresh Before You Play' THEN RAISE EXCEPTION 'The Half-Floor Table Was Not Refused For A Two-Thirds Floor: %',refused; END IF;
  ELSIF game='crash' THEN
   refused:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,NULL,NULL,105,NULL);
   IF refused->>'error' NOT LIKE 'Auto Cash Out Must Be Between 1.11x And %x' THEN RAISE EXCEPTION 'A 1.05x Auto Cash Out Was Not Refused: %',refused; END IF;
  ELSE
   refused:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,CASE game WHEN 'mines' THEN '5' ELSE 'steady' END,NULL,NULL,NULL,1);
   IF refused->>'error' IS DISTINCT FROM 'This Game Has One Setting. Refresh Before You Play' THEN RAISE EXCEPTION 'Old Setting Was Not Refused For %: %',game,refused; END IF;
  END IF;
  RESET ROLE;
  IF (SELECT status FROM public.wheel_bonus_awards WHERE id=award)<>'pending' OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_dia
   OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>n_tx THEN RAISE EXCEPTION 'A Refusal Charged Something For %',game; END IF;

  -- The real start, with the add-on.
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN started:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,250,6,NULL,NULL);
  ELSIF game='crash' THEN started:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,NULL,NULL,NULL,NULL);
  ELSE started:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,mode,NULL,NULL,NULL,CASE WHEN game='crossing' THEN 12 ELSE 8 END); END IF;
  RESET ROLE;
  IF started->>'ok'<>'true' THEN RAISE EXCEPTION 'Super % With The Add-On Did Not Start: %',game,started; END IF;
  IF (started->>'bet_diamonds')::integer<>stake OR (started->>'payout_version')::integer<>4 OR (started->>'minimum_payout_chips')::numeric<>minimum
   OR (started#>>'{bonus,added_diamonds}')::integer<>2500 OR (started#>>'{bonus,total_diamonds}')::integer<>stake THEN RAISE EXCEPTION 'Super % Start Did Not Seal The Paid Floor: %',game,started; END IF;

  -- R16: the add-on is debited exactly once, as itself, with its amount; one custody movement.
  rid:=COALESCE(started->>'round_id',started->>'id')::uuid;
  ref:=CASE game WHEN 'crash' THEN 'crash:'||rid WHEN 'plinko' THEN 'plinko-bonus:'||rid ELSE 'choice:'||rid END;
  IF (SELECT diamonds FROM public.profiles WHERE id=player)<>before_dia-2500 THEN RAISE EXCEPTION 'The Add-On Debit Is Not 2500 For %',game; END IF;
  SELECT count(*) INTO k FROM public.diamond_transactions WHERE user_id=player AND reference_id=ref;
  IF k<>1 OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>n_tx+1 THEN RAISE EXCEPTION 'Expected Exactly One Debit Row For %, Found %',game,k; END IF;
  SELECT * INTO tx FROM public.diamond_transactions WHERE user_id=player AND reference_id=ref;
  IF tx.amount<>-2500 OR tx.description<>format('%s Double Diamonds Add-On (2500 Diamonds Of A 7500 Diamond Stake)',CASE game WHEN 'plinko' THEN 'Diamond Plinko' WHEN 'crash' THEN 'Diamond Crash' WHEN 'mines' THEN 'Diamond Mines' ELSE 'Donkey Cross' END)
   OR (tx.metadata->>'add_on')::boolean IS DISTINCT FROM true OR (tx.metadata->>'added_diamonds')::integer<>2500 OR (tx.metadata->>'stake_diamonds')::integer<>stake
   OR (tx.metadata->>'paid_diamonds')::integer<>5000 OR (tx.metadata->>'award_id')::uuid<>award OR tx.metadata->>'recipient_id'<>owner::text THEN
   RAISE EXCEPTION 'The Add-On Debit Row Is Mislabelled For %: % %',game,tx.description,tx.metadata; END IF;
  SELECT count(*) INTO k FROM public.diamond_spin_movements WHERE owner_id=owner AND operation_id=ref||':intake';
  IF k<>1 OR (SELECT count(*) FROM public.diamond_spin_movements WHERE owner_id=owner)<>n_moves+1 THEN RAISE EXCEPTION 'Expected Exactly One Custody Movement For %',game; END IF;
  SELECT * INTO move FROM public.diamond_spin_movements WHERE owner_id=owner AND operation_id=ref||':intake';
  IF move.amount<>2500 OR move.kind<>'bonus' OR move.player_id<>player OR move.description NOT LIKE '% Double Diamonds Add-On Intake (2500 Diamonds Of A 7500 Diamond Stake)' THEN RAISE EXCEPTION 'The Custody Movement Is Mislabelled For %: %',game,move; END IF;
  -- An exact replay of the start returns the receipt and debits nothing again.
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN replayed:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,250,6,NULL,NULL);
  ELSIF game='crash' THEN replayed:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,NULL,NULL,NULL,NULL,NULL);
  ELSE replayed:=public.fn_wheel_bonus_start(award,ticket,'first-game',true,mode,NULL,NULL,NULL,CASE WHEN game='crossing' THEN 12 ELSE 8 END); END IF;
  RESET ROLE;
  IF replayed->>'ok'<>'true' OR (replayed->>'replayed')::boolean IS DISTINCT FROM true OR (SELECT diamonds FROM public.profiles WHERE id=player)<>before_dia-2500
   OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>n_tx+1 OR (SELECT count(*) FROM public.diamond_spin_movements WHERE owner_id=owner)<>n_moves+1 THEN
   RAISE EXCEPTION 'The Replay Debited Again For %: %',game,replayed; END IF;

  IF game='plinko' THEN
   IF (started->>'table_version')::integer<>6 OR started->>'table_name'<>'Super Double' OR jsonb_array_length(started->'drops')<>30 OR (started->>'drop_count')::integer<>30
    OR (started->>'diamonds_per_drop')::integer<>250 OR (started->>'paid_diamonds')::integer<>5000 THEN RAISE EXCEPTION 'Super Double Plinko Did Not Play Thirty Drops Of 250: %',started; END IF;
   paid:=0;
   FOR drop IN SELECT * FROM jsonb_array_elements(started->'drops') LOOP
    IF (drop->>'multiplier_cents')::integer<72 OR (drop->>'multiplier_cents')::integer<>(SELECT multipliers_cents[(drop->>'slot')::integer+1] FROM public.plinko_tables WHERE version=6) THEN RAISE EXCEPTION 'A Super Double Drop Paid Off The Table: %',drop; END IF;
    paid:=paid+(drop->>'payout_chips')::numeric;
   END LOOP;
   IF (started->>'payout_chips')::numeric<>GREATEST(paid,minimum) OR (started->>'payout_chips')::numeric<minimum THEN RAISE EXCEPTION 'Super Double Plinko Run Below What Was Paid: %',started; END IF;
   paid:=(started->>'payout_chips')::numeric; key:='plinko-bonus-prize:'||rid;
  ELSE
   IF started->>'status'<>'open' THEN RAISE EXCEPTION 'Super % Did Not Open: %',game,started; END IF;
   IF game='crash' THEN
    IF (started->>'cashout_floor_cents')::integer<>111 OR (started->>'crash_floor_cents')::integer<>110 THEN RAISE EXCEPTION 'Crash Receipt Floors Wrong: %',started; END IF;
    -- At 1.05x the ship is flying and nobody may cash out; the sealed point is exactly 1.10x.
    UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '1.3 seconds' WHERE id=rid;
    SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(rid,105); RESET ROLE;
    IF settled->>'error' IS DISTINCT FROM 'Cash Out Starts At 1.11x' OR (SELECT status FROM public.crash_rounds WHERE id=rid)<>'open' THEN RAISE EXCEPTION 'A 1.05x Cash Out Was Not Refused: %',settled; END IF;
    IF (SELECT crash_cents FROM public.crash_rounds WHERE id=rid)<>110 THEN RAISE EXCEPTION 'The Sealed Point Is Not 1.10x'; END IF;
    -- Past 1.10x the round has crashed: the loss pays exactly what the player paid, 50 chips.
    UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '10 seconds' WHERE id=rid;
    SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(rid,111); RESET ROLE;
    IF settled#>>'{outcome,status}'<>'crashed' OR (settled#>>'{outcome,payout_chips}')::numeric<>minimum OR (settled->>'payout_version')::integer<>4 OR (settled#>>'{fairness,crash_cents}')::integer<>110 THEN RAISE EXCEPTION 'Super Crash Loss Did Not Pay What Was Paid: %',settled; END IF;
    paid:=minimum; key:='crash-prize:'||rid;
   ELSIF game='crossing' THEN
    -- The sealed roll fails street two. Street one is crossed regardless, and the second street loses: 50 chips.
    IF (started#>>'{prizes,0}')::numeric<>60 OR (started#>>'{prizes,1}')::numeric<>108.75 THEN RAISE EXCEPTION 'Super Road Ladder Wrong: %',started; END IF;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',0,0); RESET ROLE;
    IF settled->>'status'<>'open' OR jsonb_array_length(settled->'picked')<>1 THEN RAISE EXCEPTION 'The First Street Was Not Certain: %',settled; END IF;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',1,1); RESET ROLE;
    IF settled->>'status'<>'lost' OR (settled->>'payout_chips')::numeric<>minimum OR (settled->>'payout_version')::integer<>4 THEN RAISE EXCEPTION 'Super Road Loss Did Not Pay What Was Paid: %',settled; END IF;
    paid:=minimum; key:='choice-prize:'||rid;
   ELSE
    -- No board exists before the first pick. The pick deals it around itself.
    IF (SELECT mine_cells FROM public.diamond_choice_rounds WHERE id=rid)<>'{}' OR (SELECT payout_version FROM public.diamond_choice_rounds WHERE id=rid)<>4 THEN RAISE EXCEPTION 'Super Mines Dealt A Board Before The First Pick'; END IF;
    -- A wrong board cannot be written in its place.
    BEGIN
     UPDATE public.diamond_choice_rounds SET mine_cells=ARRAY[0,1,2,3,4,5],picked=ARRAY[7] WHERE id=rid;
     RAISE EXCEPTION 'A Forged Board Was Accepted';
    EXCEPTION WHEN OTHERS THEN
     IF SQLERRM<>'A Sealed Game Round Cannot Be Rewritten' THEN RAISE; END IF;
    END;
    cell:=7;
    SELECT public.fn_choice_board_v4(server_seed,client_seed,nonce,6,cell) INTO dealt FROM public.diamond_choice_rounds WHERE id=rid;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,0); RESET ROLE;
    SELECT mine_cells INTO board FROM public.diamond_choice_rounds WHERE id=rid;
    IF settled->>'status'<>'open' OR board<>dealt OR cardinality(board)<>6 OR cell=ANY(board) OR (settled#>>'{prizes,0}')::numeric<>60 THEN RAISE EXCEPTION 'The First Tile Was Not A Gem: % %',settled,board; END IF;
    -- Sealed now: the board cannot move again.
    BEGIN
     UPDATE public.diamond_choice_rounds SET mine_cells=dealt[1:5]||ARRAY[24] WHERE id=rid;
     RAISE EXCEPTION 'A Sealed Board Was Rewritten';
    EXCEPTION WHEN OTHERS THEN
     IF SQLERRM<>'A Sealed Game Round Cannot Be Rewritten' THEN RAISE; END IF;
    END;
    SELECT n INTO cell FROM generate_series(0,24) n WHERE n=ANY(board) LIMIT 1;
    SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,1); RESET ROLE;
    IF settled->>'status'<>'lost' OR (settled->>'payout_chips')::numeric<>minimum OR (settled#>>'{proof,first_pick}')::integer<>7 OR (settled#>>'{proof,payout_version}')::integer<>4
     OR (settled#>'{proof,mine_cells}')<>to_jsonb(board) THEN RAISE EXCEPTION 'Super Mines Loss Did Not Pay What Was Paid: %',settled; END IF;
    paid:=minimum; key:='choice-prize:'||rid;
   END IF;
  END IF;

  -- R16: every payout credits the member by exactly the payout and journals it once, promo first.
  IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+paid THEN RAISE EXCEPTION 'Super % Payout Not Booked To The Member',game; END IF;
  SELECT count(*),sum(amount) INTO k,ev FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank');
  IF k<>1 OR ev<>paid THEN RAISE EXCEPTION 'Super % Payout Journal Is Wrong: % rows, % chips',game,k,ev; END IF;
  SELECT * INTO leg FROM public.chip_ledger WHERE idempotency_key=key;
  IF leg.from_type<>'promo_wallet' OR leg.to_type<>'player_wallet' OR leg.to_entity_id<>player OR leg.category<>game||'_prize' OR leg.status<>'posted' THEN RAISE EXCEPTION 'Super % Journal Leg Wrong: %',game,leg; END IF;
  SELECT count(*),sum(amount) INTO k,ev FROM public.chip_transactions WHERE to_user_id=player AND transaction_type=game||'_prize' AND (metadata->>'round_id'=rid::text OR metadata->>'bonus_id'=rid::text);
  IF k<>1 OR ev<>paid THEN RAISE EXCEPTION 'Super % Chip Transaction Is Wrong: % rows, % chips',game,k,ev; END IF;
  SELECT * INTO tx FROM public.chip_transactions WHERE to_user_id=player AND transaction_type=game||'_prize' AND (metadata->>'round_id'=rid::text OR metadata->>'bonus_id'=rid::text);
  IF (tx.metadata->>'from_promo')::numeric<>paid OR (tx.metadata->>'from_bank')::numeric<>0 THEN RAISE EXCEPTION 'Super % Payout Did Not Come From Promo First: %',game,tx.metadata; END IF;
  IF (SELECT status FROM public.wheel_bonus_awards WHERE id=award)<>'redeemed' THEN RAISE EXCEPTION 'Super Award Not Redeemed'; END IF;
  RAISE NOTICE 'FIRST_STEP_RECEIPT %',jsonb_build_object('game',game,'kind','super-add-on','value',CASE WHEN game='plinko' THEN started ELSE settled END);
  report:=report||format(' super %s paid %s;',game,paid);
 END LOOP;

 -- ── 5b. AN ENTRY NO LISTED VALUE FITS STILL HAS A GAME: THE WHOLE STAKE, ONE DROP ──
 -- 2,489 diamonds is 19 x 131: no listed value divides it into a hundred drops or
 -- fewer, and with the add-on the 7,467 stake is no better. The whole stake as a
 -- single drop is always open, so the award is never stranded.
 SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
 FOR i IN 1..20000 LOOP
  seed:=encode(extensions.digest('first-step-wheel-odd-'||i,'sha256'),'hex');
  point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:first-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
  point2:=floor((('x'||substr(encode(extensions.hmac('wheel-v3-upgrade:first-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
  EXIT WHEN point>=98000 AND point2<20000;
 END LOOP;
 commit:=gen_random_uuid();
 INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 result:=public.fn_wheel_spin_v2(club,commit,'first-client',2489,'paid',NULL);
 award:=(result#>>'{bonus,id}')::uuid;
 state:=public.fn_wheel_bonus_state(club,'plinko',true,NULL,award);
 RESET ROLE;
 IF result->>'ok'<>'true' OR result#>>'{secondary,outcome,game}' IS DISTINCT FROM 'plinko' THEN RAISE EXCEPTION 'Expected A Super Plinko Award At 2489: %',result; END IF;
 IF state#>'{game_state,plinko_denominations}'<>'[7467]'::jsonb OR (state#>>'{game_state,minimum_payout_chips}')::numeric<>49.78 OR (state#>>'{game_state,plinko_table}')::integer<>6 THEN RAISE EXCEPTION 'The Odd Stake Quote Is Wrong: %',state; END IF;
 ticket:=gen_random_uuid(); seed:=encode(extensions.digest('first-step-odd-game','sha256'),'hex');
 INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'plinko',seed,encode(extensions.digest(seed,'sha256'),'hex'));
 SET LOCAL ROLE authenticated;
 refused:=public.fn_wheel_bonus_start(award,ticket,'odd-game',true,NULL,131,6,NULL,NULL);
 started:=public.fn_wheel_bonus_start(award,ticket,'odd-game',true,NULL,7467,6,NULL,NULL);
 RESET ROLE;
 IF refused->>'error' IS DISTINCT FROM 'Choose A Drop Value That Plays Every Diamond In One To One Hundred Drops' THEN RAISE EXCEPTION 'An Unlisted Divisor Was Not Refused: %',refused; END IF;
 IF started->>'ok'<>'true' OR jsonb_array_length(started->'drops')<>1 OR (started->>'diamonds_per_drop')::integer<>7467 OR (started->>'table_version')::integer<>6
  OR (started->>'minimum_payout_chips')::numeric<>49.78 OR (started->>'payout_chips')::numeric<49.78 OR (started->>'payout_chips')::numeric<>GREATEST((started#>>'{drops,0,payout_chips}')::numeric,49.78) THEN
  RAISE EXCEPTION 'The Whole-Stake Single Drop Did Not Play: %',started; END IF;
 RAISE NOTICE 'FIRST_STEP_RECEIPT %',jsonb_build_object('game','plinko','kind','super-add-on-odd-stake','value',started);
 report:=report||format(' odd stake one drop paid %s;',started->>'payout_chips');

 -- ── 6. ORDINARY AWARDS AT A 100 DIAMOND ENTRY: THE HALF, AND THE FIRST STEP ──
 FOREACH game IN ARRAY ARRAY['plinko','crash','crossing','mines'] LOOP
  target:=CASE game WHEN 'plinko' THEN 1 WHEN 'crash' THEN 4 WHEN 'crossing' THEN 7 ELSE 10 END;
  SELECT count(*)+1 INTO nonce FROM public.wheel_spins WHERE user_id=player;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('first-step-plain-'||game||i,'sha256'),'hex');
   point:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:first-client:'||nonce,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
   EXIT WHEN (game='plinko' AND point<10000) OR (game='crash' AND point>=29600 AND point<39600) OR (game='crossing' AND point>=59200 AND point<69200) OR (game='mines' AND point>=85800 AND point<95800);
  END LOOP;
  commit:=gen_random_uuid();
  INSERT INTO public.wheel_seed_commits(id,user_id,server_seed,server_seed_hash) VALUES(commit,player,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  SET LOCAL ROLE authenticated;
  result:=public.fn_wheel_spin_v2(club,commit,'first-client',100,'paid',NULL);
  RESET ROLE;
  IF result->>'ok'<>'true' OR (result#>>'{outcome,ord}')::integer<>target THEN RAISE EXCEPTION 'Expected An Ordinary % Award: %',game,result; END IF;
  award:=(result#>>'{bonus,id}')::uuid; bet:=1; minimum:=0.5; stake:=100;
  SET LOCAL ROLE authenticated;
  state:=public.fn_wheel_bonus_state(club,game,false,NULL,award);
  RESET ROLE;
  IF state#>>'{game_state,guarantee}'<>'standard' OR (state#>>'{game_state,minimum_payout_chips}')::numeric<>minimum OR (state#>>'{game_state,payout_version}')::integer<>4
   OR (state#>>'{game_state,paid_diamonds}')::integer<>100 OR (state#>>'{game_state,plinko_table}')::integer<>4
   OR state#>'{game_state,plinko_denominations}'<>'[1,2,4,5,10,20,25,50,100]'::jsonb THEN RAISE EXCEPTION 'Ordinary Quote Wrong For %: %',game,state; END IF;
  IF game='mines' AND ((state#>>'{game_state,prizes,0}')::numeric<>0.8 OR abs((state#>>'{game_state,prizes,1}')::numeric-0.9)>0.000001) THEN RAISE EXCEPTION 'Ordinary Mines Quote Wrong: %',state; END IF;
  IF game='crossing' AND ((state#>>'{game_state,prizes,0}')::numeric<>0.8 OR (state#>>'{game_state,prizes,11}')::numeric<>20) THEN RAISE EXCEPTION 'Ordinary Road Quote Wrong: %',state; END IF;

  IF game='crash' THEN SELECT count(*)+1 INTO nonce FROM public.crash_rounds WHERE user_id=player;
  ELSIF game='plinko' THEN nonce:=0;
  ELSE SELECT count(*)+1 INTO nonce FROM public.diamond_choice_rounds WHERE user_id=player AND diamond_choice_rounds.game=game; END IF;
  FOR i IN 1..20000 LOOP
   seed:=encode(extensions.digest('first-step-plain-game-'||game||i,'sha256'),'hex');
   roll:=(('x'||substr(encode(extensions.hmac('plain-game:'||nonce||CASE WHEN game='crossing' THEN ':road' ELSE '' END,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   -- The road roll here would have lost the OLD first street (1.10x) as well as street two.
   EXIT WHEN game IN('mines','plinko') OR (game='crossing' AND (roll+1)*(bet*1.1-minimum)>(bet*0.8-minimum)*c_two48) OR (game='crash' AND public.fn_crash_point_cents(roll,bet,minimum)=110);
  END LOOP;
  ticket:=gen_random_uuid();
  INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,game,seed,encode(extensions.digest(seed,'sha256'),'hex'));
  mode:=public.fn_choice_mode(game);
  SELECT chip_balance INTO before_chips FROM public.club_members WHERE club_id=club AND user_id=player;
  SELECT diamonds INTO before_dia FROM public.profiles WHERE id=player;
  SELECT count(*) INTO n_tx FROM public.diamond_transactions WHERE user_id=player;
  SET LOCAL ROLE authenticated;
  IF game='plinko' THEN started:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,1,4,NULL,NULL);
  ELSIF game='crash' THEN started:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,NULL,NULL,NULL,NULL,NULL);
  ELSE started:=public.fn_wheel_bonus_start(award,ticket,'plain-game',false,mode,NULL,NULL,NULL,CASE WHEN game='crossing' THEN 12 ELSE 8 END); END IF;
  RESET ROLE;
  IF started->>'ok'<>'true' OR (started->>'minimum_payout_chips')::numeric<>minimum OR (started->>'payout_version')::integer<>4 THEN RAISE EXCEPTION 'Ordinary % Start Wrong: %',game,started; END IF;
  -- Without the add-on nothing is debited: the wheel funded the whole stake.
  IF (SELECT diamonds FROM public.profiles WHERE id=player)<>before_dia OR (SELECT count(*) FROM public.diamond_transactions WHERE user_id=player)<>n_tx THEN RAISE EXCEPTION 'A Wheel-Funded Start Debited The Player For %',game; END IF;
  rid:=COALESCE(started->>'round_id',started->>'id')::uuid;
  IF game='plinko' THEN
   -- One diamond a drop, a hundred drops, on the table whose lowest slot carries the half.
   IF (started->>'table_version')::integer<>4 OR jsonb_array_length(started->'drops')<>100 OR (started->>'diamonds_per_drop')::integer<>1 THEN RAISE EXCEPTION 'Ordinary Plinko Did Not Play A Hundred Drops On Super: %',started; END IF;
   paid:=0;
   FOR drop IN SELECT * FROM jsonb_array_elements(started->'drops') LOOP paid:=paid+(drop->>'payout_chips')::numeric; END LOOP;
   IF (started->>'payout_chips')::numeric<>GREATEST(paid,minimum) THEN RAISE EXCEPTION 'Ordinary Plinko Run Below The Half: %',started; END IF;
   paid:=(started->>'payout_chips')::numeric; key:='plinko-bonus-prize:'||rid;
  ELSIF game='crash' THEN
   UPDATE public.crash_rounds SET started_at=clock_timestamp()-interval '10 seconds' WHERE id=rid;
   SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(rid,111); RESET ROLE;
   IF settled#>>'{outcome,status}'<>'crashed' OR (settled#>>'{outcome,payout_chips}')::numeric<>minimum OR (settled#>>'{fairness,crash_cents}')::integer<>110 THEN RAISE EXCEPTION 'Ordinary Crash Loss Did Not Pay The Half: %',settled; END IF;
   paid:=minimum; key:='crash-prize:'||rid;
  ELSIF game='crossing' THEN
   SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',0,0); RESET ROLE;
   IF settled->>'status'<>'open' THEN RAISE EXCEPTION 'The First Street Lost On A Roll That Used To Lose It: %',settled; END IF;
   -- Banking street one pays exactly 0.80 of the stake.
   SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'cashout',NULL,1); RESET ROLE;
   IF settled->>'status'<>'cashed' OR (settled->>'payout_chips')::numeric<>0.8 THEN RAISE EXCEPTION 'Street One Did Not Bank 0.80x: %',settled; END IF;
   paid:=0.8; key:='choice-prize:'||rid;
  ELSE
   cell:=12;
   SELECT public.fn_choice_board_v4(server_seed,client_seed,nonce,6,cell) INTO dealt FROM public.diamond_choice_rounds WHERE id=rid;
   SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'pick',cell,0); RESET ROLE;
   IF settled->>'status'<>'open' OR (SELECT mine_cells FROM public.diamond_choice_rounds WHERE id=rid)<>dealt OR cell=ANY(dealt) THEN RAISE EXCEPTION 'Ordinary Mines First Tile Was Not A Gem: %',settled; END IF;
   -- Banking the first gem pays exactly 0.80 of the stake.
   SET LOCAL ROLE authenticated; settled:=public.fn_choice_act(rid,'cashout',NULL,1); RESET ROLE;
   IF settled->>'status'<>'cashed' OR (settled->>'payout_chips')::numeric<>0.8 OR (settled#>>'{proof,first_pick}')::integer<>12 THEN RAISE EXCEPTION 'The First Gem Did Not Bank 0.80x: %',settled; END IF;
   paid:=0.8; key:='choice-prize:'||rid;
  END IF;
  IF (SELECT chip_balance FROM public.club_members WHERE club_id=club AND user_id=player)<>before_chips+paid THEN RAISE EXCEPTION 'Ordinary % Payout Not Booked',game; END IF;
  SELECT count(*),sum(amount) INTO k,ev FROM public.chip_ledger WHERE idempotency_key IN (key,key||':bank');
  IF k<>1 OR ev<>paid THEN RAISE EXCEPTION 'Ordinary % Payout Journal Is Wrong: % rows, % chips',game,k,ev; END IF;
  SELECT count(*),sum(amount) INTO k,ev FROM public.chip_transactions WHERE to_user_id=player AND transaction_type=game||'_prize' AND (metadata->>'round_id'=rid::text OR metadata->>'bonus_id'=rid::text);
  IF k<>1 OR ev<>paid THEN RAISE EXCEPTION 'Ordinary % Chip Transaction Is Wrong',game; END IF;
  RAISE NOTICE 'FIRST_STEP_RECEIPT %',jsonb_build_object('game',game,'kind','ordinary','value',CASE WHEN game='plinko' THEN started ELSE settled END);
  report:=report||format(' ordinary %s paid %s;',game,paid);
 END LOOP;

 -- ── 7. A ROUND SEALED BEFORE TODAY FINISHES UNDER ITS OWN CONTRACT ──────────
 -- The bonus-minimum probe's rounds are gone with their rollback, so seal one the
 -- old way here: an open crash round with no payout_version and a 1.00x point
 -- still cashes out at 1.01x, and its receipt still reads version 2.
 SELECT * INTO ctx FROM public.crash_rounds WHERE user_id=player ORDER BY started_at DESC LIMIT 1;
 ticket:=gen_random_uuid(); rid:=gen_random_uuid();
 INSERT INTO public.diamond_game_commits(id,user_id,game,server_seed,server_seed_hash) VALUES(ticket,player,'crash','old','old-hash');
 INSERT INTO public.crash_rounds(id,host_id,host_kind,club_id,user_id,bet_diamonds,bet_chips,diamonds_per_chip,commit_id,server_seed_hash,server_seed,client_seed,nonce,roll,crash_cents,cap_cents,growth_k,
  auto_cashout_cents,reserved_chips,chips_minted,diamonds_after,member_chips_after,is_fixture,started_at,minimum_payout_chips)
 VALUES(rid,ctx.host_id,ctx.host_kind,ctx.club_id,ctx.user_id,100,1,100,ticket,'old-hash','old','old-contract',ctx.nonce+1,0,105,ctx.cap_cents,ctx.growth_k,
  NULL,ceil(1*ctx.cap_cents)/100,0,0,0,ctx.is_fixture,clock_timestamp()-interval '0.5 seconds',0.1);
 UPDATE public.diamond_game_pools p SET reserved_chips=reserved_chips+ceil(1*ctx.cap_cents)/100 WHERE p.host_id=ctx.host_id AND p.game='crash';
 SET LOCAL ROLE authenticated; settled:=public.fn_crash_cashout(rid,101); RESET ROLE;
 IF settled#>>'{outcome,status}'<>'cashed' OR (settled#>>'{outcome,cashout_cents}')::integer<>101 OR (settled->>'payout_version')::integer<>2 OR (settled->>'cashout_floor_cents')::integer<>101 THEN
  RAISE EXCEPTION 'An Old Round Was Repriced: %',settled; END IF;

 RAISE NOTICE 'PASS First step and paid floor: floors exact for every stake 25..2500 on four stake kinds, crash never below 1.10x and every target 0.80B, street one certain and every street 0.80B, mines dealt around the first pick and fair, owner example 2500+2500 pays at least 50 on all four games, add-on debited once as itself with one custody movement and replay-safe, every payout journaled once from promo, ordinary half floor and 0.80x first steps, old round keeps 1.01x;%',report;
END $$;
ROLLBACK;
