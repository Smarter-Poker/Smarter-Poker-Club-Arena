-- Actual paid-entry helpers retain one survivor and recorded eliminated places.
-- Only future delivery conditions differ; all financial authorities remain real.
DO $single_value$
DECLARE asset text; mode text; label text; c jsonb; s uuid; target uuid; u uuid; winner uuid;
 r jsonb; first_receipt jsonb; tk uuid; i integer; table_id uuid; before_wallet numeric; after_wallet numeric;
BEGIN
 FOR asset IN SELECT unnest(ARRAY['chips','diamonds']) LOOP
  FOR mode IN SELECT unnest(ARRAY['closed','full','held','cap']) LOOP
   label:='single_'||asset||'_'||mode;
   IF asset='chips' THEN c:=pg_temp.single_value_case(label,1,false);
   ELSE c:=pg_temp.single_diamond_case(label,1,false); END IF;
   s:=(c->>'tournament_id')::uuid;target:=(c->>'target_id')::uuid;
   winner:=md5('l04:'||label||':user:1')::uuid;
   IF mode='closed' THEN
    PERFORM set_config('session_replication_role','replica',true);
    UPDATE public.tournaments SET status='COMPLETED',prize_pool_finalized=true WHERE id=target;
    PERFORM set_config('session_replication_role','origin',true);
   ELSIF mode IN ('full','held') THEN
    FOR i IN SELECT generate_series(CASE WHEN mode='held' THEN 1 ELSE 2 END,CASE WHEN mode='held' THEN 3 ELSE 4 END) LOOP
     u:=md5('l04:'||label||':user:'||i)::uuid;
     PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',md5('l04:'||label||':session:'||i)::uuid)::text,true);
     PERFORM set_config('request.jwt.claim.role','authenticated',true);
     PERFORM set_config('request.jwt.claim.sub',u::text,true);
     EXECUTE 'SET LOCAL ROLE authenticated';
     r:=public.fn_register_for_tournament_request(target,md5(label||':target-entry:'||i)::uuid);
     EXECUTE 'RESET ROLE';
     PERFORM pg_temp.qualifier_assert((r->>'ok')::boolean,label||': actual target entry '||i||' returned '||r::text);
    END LOOP;
   ELSE
    -- Synthetic existing occupancy is an opening scene, not a chip-buyin test.
    PERFORM set_config('session_replication_role','replica',true);
    FOR i IN 1..4 LOOP
     table_id:=md5(label||':cap-table:'||i)::uuid;
     INSERT INTO public.cash_games(id,club_id,name,template_name,variant,sb,bb,handedness,ruleset_snapshot) VALUES(table_id,(SELECT club_id FROM public.tournaments WHERE id=s),'Single Value Cap','classic','nlh',i,2*i,6,'{}');
     INSERT INTO public.tables(id,name,status,lifecycle,current_players,game_type,club_id,seat_game_scope,seat_admission_key,cluster_id)
      VALUES(table_id,'Single Value Cap','running','live',2,'cash',(SELECT club_id FROM public.tournaments WHERE id=s),'cluster:'||table_id,'cash',table_id);
     INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,club_id,active_game_scope,active_parent_key)
      VALUES(md5(label||':cap-seat:'||i)::uuid,table_id,1,winner,0,'active',NULL,(SELECT club_id FROM public.tournaments WHERE id=s),'cluster:'||table_id,'cash');
     INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,left_at,club_id,active_game_scope,active_parent_key)
      VALUES(md5(label||':cap-runner-seat:'||i)::uuid,table_id,2,md5('l04:'||label||':user:2')::uuid,0,'active',NULL,(SELECT club_id FROM public.tournaments WHERE id=s),'cluster:'||table_id,'cash');
    END LOOP;
    PERFORM set_config('session_replication_role','origin',true);
   END IF;
   PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
   PERFORM set_config('request.jwt.claim.role','service_role',true);
   PERFORM set_config('request.jwt.claim.sub','',true);
   IF asset='chips' THEN SELECT sum(chip_balance) INTO before_wallet FROM public.club_members WHERE club_id=(SELECT club_id FROM public.tournaments WHERE id=s);
   ELSE SELECT sum(diamonds) INTO before_wallet FROM public.profiles WHERE id IN(SELECT user_id FROM public.tournament_players WHERE tournament_id=s); END IF;
   EXECUTE 'SET LOCAL ROLE service_role';
   first_receipt:=public.fn_settle_satellite_tournament(s,winner);
   EXECUTE 'RESET ROLE';
   PERFORM pg_temp.qualifier_assert((first_receipt->>'fully_settled')::boolean,label||': exact legacy authority settles');
   PERFORM pg_temp.qualifier_assert(EXISTS(SELECT 1 FROM public.tournament_satellite_awards WHERE tournament_id=s AND user_id=winner AND delivery_kind='ticket') AND NOT EXISTS(SELECT 1 FROM public.tournament_satellite_awards WHERE tournament_id=s AND delivery_kind='cash'),'SINGLE_VALUE_EXPECT_REUSABLE_TICKET '||label||' target='||(SELECT jsonb_build_object('max',max_players,'type',tournament_type,'format',format_contract,'count',(SELECT count(*) FROM public.tournament_players WHERE tournament_id=target))::text FROM public.tournaments WHERE id=target)||' receipt='||first_receipt::text);
   FOR tk IN SELECT ticket_id FROM public.tournament_satellite_awards WHERE tournament_id=s AND delivery_kind='ticket' LOOP
    PERFORM pg_temp.qualifier_assert(public.fn_ca_assert_satellite_value_ticket(tk)=asset,label||': exact native ticket backing');
   END LOOP;
   IF asset='chips' THEN SELECT sum(chip_balance) INTO after_wallet FROM public.club_members WHERE club_id=(SELECT club_id FROM public.tournaments WHERE id=s);
   ELSE SELECT sum(diamonds) INTO after_wallet FROM public.profiles WHERE id IN(SELECT user_id FROM public.tournament_players WHERE tournament_id=s); END IF;
   PERFORM pg_temp.qualifier_assert(after_wallet-before_wallet=CASE WHEN asset='chips' THEN 5 ELSE 8 END,label||': only bubble cash changes wallets');
   EXECUTE 'SET LOCAL ROLE service_role';
   r:=public.fn_settle_satellite_tournament(s,winner);
   EXECUTE 'RESET ROLE';
   PERFORM pg_temp.qualifier_assert(r=first_receipt,label||': immutable exact replay');
   PERFORM pg_temp.qualifier_assert((SELECT status='COMPLETED' AND current_players=0 FROM public.tournaments WHERE id=s),label||': terminal close');
  END LOOP;
 END LOOP;
END $single_value$;
