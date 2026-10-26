-- Runs inside the existing Phase 6 PostgreSQL 17 physical-settlement chain.
-- Keep its exact predecessor for subsequent qualifications in the same owner.
CREATE TEMP TABLE folded_refund_preimage AS
SELECT pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure) AS definition;
CREATE TEMP TABLE folded_refund_case (
  game uuid, hand_id uuid, folder uuid, winner uuid, request_id uuid,
  results jsonb, hand_row jsonb, before_stacks text, before_folder numeric
);

DO $before$
DECLARE g uuid; ids uuid[]; f jsonb; h uuid; r jsonb; spec jsonb;
  request uuid := gen_random_uuid(); saved text; starting numeric;
BEGIN
  g := harness.cluster('folded blind refund');
  -- The first folder is a horse, the other participants are people. Same door.
  ids := ARRAY[(harness.at(g,true,true))[1], (harness.at(g,true,false))[1], (harness.at(g,true,false))[2]];
  f := harness.form(g,ids); h := (f->>'hand_id')::uuid;
  PERFORM harness.deal((f->>'instance_id')::uuid);
  starting := harness.anchor_stack(g,ids[1]);
  r := public.fn_lightning_fast_fold(h,ids[1],gen_random_uuid(),'fast',0.25);
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'fold refused: %',r; END IF;
  spec := jsonb_build_object(ids[1]::text,jsonb_build_object('d',-0.24,'c',0.24,'f','fast'),
                            ids[2]::text,jsonb_build_object('d',0.24,'c',0.24));
  saved := harness.stacks(g);
  INSERT INTO folded_refund_case VALUES(g,h,ids[1],ids[2],request,harness.results(h,spec),
    jsonb_build_object('pot_size',0.48,'returned_uncalled',jsonb_build_object(ids[1]::text,0.01)),saved,starting);
  -- Roll back the refusal's diagnostic freeze, retaining the same original
  -- hand/request, fold commitment and unspent anchor stacks for the repair.
  BEGIN
    r := harness.settle(h,request,harness.results(h,spec),0,0,
      jsonb_build_object('pot_size',0.48,'returned_uncalled',jsonb_build_object(ids[1]::text,0.01)));
    IF r->>'reason' IS DISTINCT FROM 'settlement_invariant_failed'
       OR r->>'invariant' IS DISTINCT FROM 'fold_commitment' THEN
      RAISE EXCEPTION 'baseline did not reproduce the recorded fold refund refusal: %',r;
    END IF;
    IF harness.stacks(g) IS DISTINCT FROM saved THEN RAISE EXCEPTION 'refusal moved chips'; END IF;
    RAISE EXCEPTION 'expected_fold_refund_refusal' USING ERRCODE='P0002';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'expected_fold_refund_refusal' THEN RAISE; END IF;
  END;
END $before$;
\echo 'PASS: the original physical settlement refuses the legitimate 0.01 folded-blind refund without moving chips'

\i :refund_migration

DO $after$
DECLARE c record; f jsonb; h2 uuid; r jsonb; again jsonb; second_player uuid; saved text;
BEGIN
  SELECT * INTO STRICT c FROM folded_refund_case;
  second_player := (harness.at(c.game,false,false))[1];
  -- The folder has already entered another hand, conservatively withholding
  -- all 0.25 committed to the first until its settlement returns the penny.
  f := harness.form(c.game,ARRAY[c.folder,second_player]); h2 := (f->>'hand_id')::uuid;
  IF (SELECT stack_before FROM lightning_hand_player WHERE hand_id=h2 AND player_id=c.folder)
       IS DISTINCT FROM c.before_folder-0.25 THEN RAISE EXCEPTION 'second hand spent the pending refund'; END IF;
  PERFORM harness.deal((f->>'instance_id')::uuid);
  r := harness.settle(h2,gen_random_uuid(),harness.results(h2,'{}'),0,0);
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'second hand refused: %',r; END IF;
  r := harness.settle(c.hand_id,c.request_id,c.results,0,0,c.hand_row);
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'legitimate refund refused: %',r; END IF;
  IF harness.anchor_stack(c.game,c.folder) IS DISTINCT FROM c.before_folder-0.24
     OR (SELECT committed_at_fold FROM lightning_hand_player WHERE hand_id=c.hand_id AND player_id=c.folder) IS DISTINCT FROM 0.25
     OR (SELECT net_result FROM lightning_hand_player WHERE hand_id=c.hand_id AND player_id=c.folder) IS DISTINCT FROM -0.24 THEN
    RAISE EXCEPTION 'original commitment or final physical refund is wrong';
  END IF;
  IF (SELECT post_commit_payload->'accepted_hand_facts'->'returned_uncalled'->>c.folder::text
        FROM hand_atomic_commits WHERE hand_id=(r->>'hand_history_id')::uuid)::numeric IS DISTINCT FROM 0.01 THEN
    RAISE EXCEPTION 'physical receipt lost the refund';
  END IF;
  saved := harness.stacks(c.game);
  again := harness.settle(c.hand_id,c.request_id,c.results,0,0,c.hand_row);
  IF again->>'replay' IS DISTINCT FROM 'true' OR harness.stacks(c.game) IS DISTINCT FROM saved THEN
    RAISE EXCEPTION 'replay paid twice: %',again;
  END IF;
  again := harness.settle(c.hand_id,gen_random_uuid(),c.results,0,0,c.hand_row);
  IF again->>'ok' IS DISTINCT FROM 'false' OR harness.stacks(c.game) IS DISTINCT FROM saved THEN
    RAISE EXCEPTION 'conflicting request paid twice';
  END IF;
END $after$;
\echo 'PASS: exact folded refund, overlapping hand, immutable fold commitment, physical receipt, replay and conflict'

DO $boundaries$
DECLARE label text; g uuid; ids uuid[]; f jsonb; h uuid; r jsonb; spec jsonb; row_data jsonb; saved text;
BEGIN
  FOREACH label IN ARRAY ARRAY['missing','wrong_refund','folder_wins','normal','human'] LOOP
    g := harness.cluster('fold refund '||label);
    ids := ARRAY[(harness.at(g,true,false))[1],(harness.at(g,true,false))[2]];
    f := harness.form(g,ids); h := (f->>'hand_id')::uuid;
    PERFORM harness.deal((f->>'instance_id')::uuid);
    r := public.fn_lightning_fast_fold(h,ids[1],gen_random_uuid(),'fast',0.25);
    IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'boundary fold refused'; END IF;
    spec := jsonb_build_object(ids[1]::text,jsonb_build_object('d',-0.24,'c',0.24,'f','fast'),
                              ids[2]::text,jsonb_build_object('d',0.24,'c',0.24));
    row_data := jsonb_build_object('pot_size',0.48,'returned_uncalled',jsonb_build_object(ids[1]::text,0.01));
    IF label='missing' THEN row_data := row_data-'returned_uncalled'; END IF;
    IF label='wrong_refund' THEN row_data := jsonb_set(row_data,ARRAY['returned_uncalled',ids[1]::text],'0.02'); END IF;
    IF label='folder_wins' THEN
      spec := jsonb_set(spec,ARRAY[ids[1]::text,'c'],'0.25');
    END IF;
    IF label='normal' THEN
      spec := jsonb_build_object(ids[1]::text,jsonb_build_object('d',-0.25,'c',0.25,'f','fast'),
                                ids[2]::text,jsonb_build_object('d',0.25,'c',0.25));
      row_data := jsonb_build_object('pot_size',0.50);
    END IF;
    saved := harness.stacks(g);
    r := harness.settle(h,gen_random_uuid(),harness.results(h,spec),0,0,row_data);
    IF label IN ('normal','human') THEN
      IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'valid % refused: %',label,r; END IF;
    ELSE
      IF r->>'ok' IS DISTINCT FROM 'false' OR r->>'invariant' IS DISTINCT FROM 'fold_commitment'
         OR harness.stacks(g) IS DISTINCT FROM saved
         OR (SELECT cluster_mode FROM cash_games WHERE id=g) IS DISTINCT FROM 'frozen' THEN
        RAISE EXCEPTION 'invalid % escaped the financial guard: %',label,r;
      END IF;
    END IF;
  END LOOP;
  IF has_function_privilege('anon','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'browser acquired settlement authority';
  END IF;
END $boundaries$;
\echo 'PASS: absent/mismatched refund and a winning folder still freeze without moving chips; ordinary folds and human refunds settle'

-- This qualification shares its disposable catalogue with other original-path
-- tests. Restore only the saved source in that isolated catalogue afterward.
DO $restore$ DECLARE d text; BEGIN SELECT definition INTO STRICT d FROM folded_refund_preimage; EXECUTE d; END $restore$;
