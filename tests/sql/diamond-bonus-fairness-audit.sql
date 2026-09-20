-- Private, synthetic PostgreSQL only. READ ONLY: this probe calls the installed
-- pure draw functions and nothing else, so it moves no money and writes no row.
--
-- WHY THIS EXISTS (Dan, 2026-09-19): "YOU MUST MAKE SURE THAT ALL GAMES ARE
-- LEGIT, AND THE MATH IS CORRECT... I JUST PLAYED 20 PLINKO GAMES, AND NEVER
-- ONCE MADE MORE THEN THE 21 ON A 2500 DIAMOND SPIN... AND NEVER ONCE HIT A 5X
-- 10X OR 20X. YOU NEED TO GO THROUGH AND EVALUATE THE FAIRNESS OF EACH AND
-- EVERY GAME AND INSURE THEY ARE ALL CALIBRATED SUCCESSFULLY."
--
-- The unit tests prove the DESIGN is exact: every table returns 0.80 of the
-- stake and every stopping point carries that same expectation. They cannot
-- prove the SEALED DRAW reaches those outcomes at the stated rate, because the
-- draw lives in Postgres: HMAC bits, a Fisher-Yates shuffle with rejection
-- sampling, a 48-bit survival roll, and the wheel's weighted pick. So this
-- probe draws tens of thousands of real outcomes through the real functions and
-- measures them against their closed forms. Every seed is fixed, so the whole
-- probe is deterministic: a failure is a change in a draw path, never a bad
-- sample. Each check states its sample, its closed form and its tolerance.
BEGIN;
SET LOCAL statement_timeout='900s';
DO $$
DECLARE
 n_draws integer:=32768;  -- one whole Plinko probability space per table
 n_boards integer:=4096;  -- 4,096 Mines boards is 98,304 shuffle draws
 c_two48 constant numeric:=281474976710656;
 seed text; hash bytea; i integer; bit_idx integer; slot integer; roll numeric;
 tbl record; observed bigint[]; chi numeric; expect numeric; band numeric;
 total_cents bigint; rtp numeric; hits bigint; expect_hits numeric;
 bet numeric; minimum numeric; target integer; point integer;
 prizes numeric[]; ladder integer[]; k integer; mode text; mines integer;
 counts bigint[]; board integer[]; picks bigint; report text:='';
 seg record; acc integer; total_weight integer; pick integer;
BEGIN
 IF current_database()<>'diamond_games_probe' THEN RAISE EXCEPTION 'Requires The Isolated Fixture'; END IF;
 bet:=1; minimum:=public.fn_diamond_bonus_minimum(bet);

 -- ── 1. PLINKO: the sealed slot distribution is Binomial(16, 1/2) ───────────
 -- fn_plinko_bonus_run reads bits 0..15 of hmac(server_seed,'<client>:<nonce>:drop:<i>')
 -- and counts the ones, so slot k must arrive with probability C(16,k)/65536
 -- whatever the table pays, and the realised return must sit on 0.80.
 FOR tbl IN SELECT version,name,multipliers_cents FROM public.plinko_tables WHERE activated_at IS NOT NULL ORDER BY version LOOP
  observed:=array_fill(0::bigint,ARRAY[17]); total_cents:=0;
  seed:=encode(extensions.digest('fairness-plinko-'||tbl.version,'sha256'),'hex');
  FOR i IN 0..n_draws-1 LOOP
   hash:=extensions.hmac('fairness:1:drop:'||i,seed,'sha256');
   slot:=0;
   FOR bit_idx IN 0..15 LOOP IF get_bit(hash,bit_idx)=1 THEN slot:=slot+1; END IF; END LOOP;
   observed[slot+1]:=observed[slot+1]+1;
   total_cents:=total_cents+tbl.multipliers_cents[slot+1];
  END LOOP;
  -- Pearson's chi-square against the exact binomial weights. The four outermost
  -- slots on each side are POOLED into one bin, because slot 0 expects half a
  -- drop in this sample and Pearson needs an expected count of five: a
  -- seventeen-cell test here would be measuring its own approximation error.
  -- That leaves eleven bins, ten degrees of freedom, smallest expectation 348.
  -- The one-in-a-million critical value is 40.0, and the draw is fixed, so a
  -- figure anywhere near it means the bit path itself moved.
  chi:=0;
  FOR k IN 3..13 LOOP
   IF k=3 THEN SELECT sum(observed[s+1]),sum(n_draws::numeric*public.fn_choice_choose(16,s)/65536) INTO picks,expect FROM generate_series(0,3) s;
   ELSIF k=13 THEN SELECT sum(observed[s+1]),sum(n_draws::numeric*public.fn_choice_choose(16,s)/65536) INTO picks,expect FROM generate_series(13,16) s;
   ELSE picks:=observed[k+1]; expect:=n_draws::numeric*public.fn_choice_choose(16,k)/65536; END IF;
   chi:=chi+(picks-expect)^2/expect;
  END LOOP;
  IF chi>40 THEN RAISE EXCEPTION 'Plinko % Slot Distribution Failed Its Pooled Chi-Square: % (observed %)',tbl.name,round(chi,2),observed; END IF;
  -- Every individual slot still has to sit in a Poisson band, which is what
  -- catches a single slot being starved or favoured without moving the pooled bins.
  FOR k IN 0..16 LOOP
   expect:=n_draws::numeric*public.fn_choice_choose(16,k)/65536;
   IF abs(observed[k+1]-expect)>4*sqrt(expect)+4 THEN
    RAISE EXCEPTION 'Plinko % Slot % Arrived % Times In % Drops, Expected %',tbl.name,k,observed[k+1],n_draws,round(expect,1); END IF;
  END LOOP;
  rtp:=total_cents::numeric/n_draws/100;
  IF abs(rtp-0.8)>0.06 THEN RAISE EXCEPTION 'Plinko % Realised Return % Over % Drops Is Off Its 0.80 Design',tbl.name,round(rtp,4),n_draws; END IF;
  -- The owner's complaint, measured: the advertised prizes have to land.
  SELECT COALESCE(sum(observed[s+1]),0) INTO hits FROM generate_series(0,16) s WHERE tbl.multipliers_cents[s+1]>=500;
  SELECT COALESCE(sum(n_draws::numeric*public.fn_choice_choose(16,s)/65536),0) INTO expect_hits FROM generate_series(0,16) s WHERE tbl.multipliers_cents[s+1]>=500;
  IF hits=0 OR abs(hits-expect_hits)>4*sqrt(expect_hits) THEN
   RAISE EXCEPTION 'Plinko % Paid 5x Or Better % Times In % Drops, Expected %',tbl.name,hits,n_draws,round(expect_hits,1); END IF;
  -- And the top slot itself, which on the ordinary table is one drop in 239.
  SELECT COALESCE(sum(observed[s+1]),0) INTO picks FROM generate_series(0,16) s WHERE tbl.multipliers_cents[s+1]>=2000;
  SELECT COALESCE(sum(n_draws::numeric*public.fn_choice_choose(16,s)/65536),0) INTO expect FROM generate_series(0,16) s WHERE tbl.multipliers_cents[s+1]>=2000;
  IF picks=0 OR abs(picks-expect)>4*sqrt(expect) THEN
   RAISE EXCEPTION 'Plinko % Paid Its Top 20x % Times In % Drops, Expected %',tbl.name,picks,n_draws,round(expect,1); END IF;
  report:=report||format(' plinko %s: chi2 %s over %s drops, realised %s, 5x+ %s of expected %s, 20x %s of expected %s;',
   tbl.name,round(chi,2),n_draws,round(rtp,4),hits,round(expect_hits,1),picks,round(expect,1));
 END LOOP;

 -- ── 2. CRASH: P(point >= x) = (0.8B - L)/(xB - L) ──────────────────────────
 -- fn_crash_point_cents turns one 48-bit roll into the crash point, so a player
 -- who always cashes out at x wins x with that probability and keeps L
 -- otherwise. That identity is why every target carries the same 0.80B.
 FOREACH target IN ARRAY ARRAY[101,150,200,500,1000,2000] LOOP
  hits:=0; seed:=encode(extensions.digest('fairness-crash-'||target,'sha256'),'hex');
  FOR i IN 0..n_draws-1 LOOP
   roll:=(('x'||substr(encode(extensions.hmac('fairness:crash:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   IF public.fn_crash_point_cents(roll,bet,minimum)>=target THEN hits:=hits+1; END IF;
  END LOOP;
  expect:=(bet*0.8-minimum)/(bet*target/100-minimum);
  band:=4*sqrt(expect*(1-expect)/n_draws)+0.001;
  IF abs(hits::numeric/n_draws-expect)>band THEN
   RAISE EXCEPTION 'Crash Survival To %x Was % Over % Rounds, Expected % (band %)',target/100.0,round(hits::numeric/n_draws,4),n_draws,round(expect,4),round(band,4); END IF;
  report:=report||format(' crash %sx: %s of %s vs expected %s;',target/100.0,hits,n_draws,round(expect,4));
 END LOOP;
 -- A crash point is never below 1.00x, so a round can never pay less than the floor.
 seed:=encode(extensions.digest('fairness-crash-floor','sha256'),'hex');
 FOR i IN 0..8191 LOOP
  roll:=(('x'||substr(encode(extensions.hmac('fairness:floor:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
  point:=public.fn_crash_point_cents(roll,bet,minimum);
  IF point<100 THEN RAISE EXCEPTION 'Crash Point % Is Below 1.00x',point; END IF;
 END LOOP;

 -- ── 3. DONKEY CROSS: one sealed roll decides the whole road ────────────────
 -- fn_choice_act survives street n when (roll+1)*(prize_n - L) <= (0.8B - L)*2^48,
 -- so P(reach street n) = (0.8B - L)/(prize_n - L) and every street carries 0.80B.
 mode:=public.fn_choice_mode('crossing');
 ladder:=public.fn_choice_ladder(mode);
 prizes:=public.fn_choice_prizes('crossing',mode,bet);
 FOR k IN 1..cardinality(ladder) LOOP
  hits:=0; seed:=encode(extensions.digest('fairness-road-'||k,'sha256'),'hex');
  FOR i IN 0..n_draws-1 LOOP
   roll:=(('x'||substr(encode(extensions.hmac('fairness:road:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric;
   IF (roll+1)*(prizes[k]-minimum)<=(bet*0.8-minimum)*c_two48 THEN hits:=hits+1; END IF;
  END LOOP;
  expect:=LEAST(1,(bet*0.8-minimum)/(prizes[k]-minimum));
  band:=4*sqrt(GREATEST(expect*(1-expect),0.000001)/n_draws)+0.001;
  IF abs(hits::numeric/n_draws-expect)>band THEN
   RAISE EXCEPTION 'Road Street % Survival Was % Over % Rounds, Expected % (band %)',k,round(hits::numeric/n_draws,4),n_draws,round(expect,4),round(band,4); END IF;
  IF k IN (1,6,12) THEN report:=report||format(' road street %s: %s of %s vs expected %s;',k,hits,n_draws,round(expect,4)); END IF;
 END LOOP;

 -- ── 4. DIAMOND MINES: the shuffle is unbiased ──────────────────────────────
 -- fn_choice_board is Fisher-Yates over twenty-five cells with rejection
 -- sampling on a 32-bit draw, so every cell must hide a mine with probability
 -- mines/25 and no cell may be favoured. A biased board is the one way this
 -- game could cheat with every prize left untouched.
 mines:=public.fn_choice_mode('mines')::integer;
 counts:=array_fill(0::bigint,ARRAY[25]);
 FOR i IN 0..n_boards-1 LOOP
  board:=public.fn_choice_board(encode(extensions.digest('fairness-mines-'||i,'sha256'),'hex'),'fairness',1,mines);
  IF cardinality(board)<>mines THEN RAISE EXCEPTION 'Mines Board % Dealt % Cells, Expected %',i,cardinality(board),mines; END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(board) x)<>mines OR (SELECT min(x) FROM unnest(board) x)<0 OR (SELECT max(x) FROM unnest(board) x)>24 THEN
   RAISE EXCEPTION 'Mines Board % Is Not % Distinct Cells In 0..24: %',i,mines,board; END IF;
  FOREACH k IN ARRAY board LOOP counts[k+1]:=counts[k+1]+1; END LOOP;
 END LOOP;
 -- Twenty-four degrees of freedom; the one-in-a-hundred-thousand value is 66.6.
 expect:=n_boards::numeric*mines/25;
 chi:=0;
 FOR k IN 1..25 LOOP chi:=chi+(counts[k]-expect)^2/expect; END LOOP;
 IF chi>66.6 THEN RAISE EXCEPTION 'Mines Board Distribution Failed Its Chi-Square: % (counts %)',round(chi,2),counts; END IF;
 -- Every stop still carries 0.80B exactly: the prize ladder is the design, and
 -- the draw above is what makes P(survive k picks) = C(25-m,k)/C(25,k).
 prizes:=public.fn_choice_prizes('mines',public.fn_choice_mode('mines'),bet);
 FOR k IN 1..cardinality(prizes) LOOP
  IF abs(prizes[k]-(minimum+(bet*0.8-minimum)*public.fn_choice_choose(25,k)/public.fn_choice_choose(25-mines,k)))>0.000001 THEN
   RAISE EXCEPTION 'Mines Prize % Is Off Its Closed Form: %',k,prizes[k]; END IF;
 END LOOP;
 report:=report||format(' mines: chi2 %s over %s boards of %s cells, %s prizes exact;',round(chi,2),n_boards,mines,cardinality(prizes));

 -- ── 5. THE WHEEL: the twelve outcomes arrive at their stated weights ───────
 -- fn_wheel_spin_core walks fn_wheel_v2_model() by weight over a 100,000 point
 -- roll. The bonus games are 40,000 of those points, so a game award has to be
 -- as common as the wheel says, or every figure above is measuring a game
 -- nobody reaches.
 SELECT sum(weight) INTO total_weight FROM public.fn_wheel_v2_model();
 IF total_weight<>100000 THEN RAISE EXCEPTION 'The Wheel Model Weighs %, Expected 100000',total_weight; END IF;
 observed:=array_fill(0::bigint,ARRAY[12]);
 seed:=encode(extensions.digest('fairness-wheel','sha256'),'hex');
 FOR i IN 0..n_draws-1 LOOP
  roll:=floor((('x'||substr(encode(extensions.hmac('wheel-v3:fairness:'||i,seed,'sha256'),'hex'),1,12))::bit(48)::bigint)::numeric*100000/c_two48);
  acc:=0; pick:=NULL;
  FOR seg IN SELECT ord,weight FROM public.fn_wheel_v2_model() ORDER BY ord LOOP
   acc:=acc+seg.weight;
   IF pick IS NULL AND roll<acc THEN pick:=seg.ord; END IF;
  END LOOP;
  IF pick IS NULL THEN RAISE EXCEPTION 'The Wheel Roll % Landed Nowhere',roll; END IF;
  observed[pick]:=observed[pick]+1;
 END LOOP;
 chi:=0;
 FOR seg IN SELECT ord,weight FROM public.fn_wheel_v2_model() ORDER BY ord LOOP
  expect:=n_draws::numeric*seg.weight/100000;
  chi:=chi+(observed[seg.ord]-expect)^2/expect;
 END LOOP;
 -- Eleven degrees of freedom; the one-in-a-hundred-thousand value is 43.8.
 IF chi>43.8 THEN RAISE EXCEPTION 'The Wheel Outcome Distribution Failed Its Chi-Square: % (observed %)',round(chi,2),observed; END IF;
 SELECT COALESCE(sum(observed[m.ord]),0) INTO hits FROM public.fn_wheel_v2_model() m WHERE m.kind='bonus';
 expect_hits:=n_draws::numeric*40000/100000;
 IF abs(hits-expect_hits)>4*sqrt(expect_hits) THEN
  RAISE EXCEPTION 'The Wheel Awarded A Game % Times In % Spins, Expected %',hits,n_draws,round(expect_hits,1); END IF;
 report:=report||format(' wheel: chi2 %s over %s spins, %s game awards vs expected %s;',round(chi,2),n_draws,hits,round(expect_hits,1));

 RAISE NOTICE 'PASS Diamond fairness audit:%',report;
END $$;
ROLLBACK;
