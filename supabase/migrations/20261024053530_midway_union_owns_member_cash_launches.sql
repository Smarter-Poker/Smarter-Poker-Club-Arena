-- @live-proof: (SELECT count(*)=3 AND bool_and(position('MIDWAY_UNION_HOST_ONLY' IN pg_get_functiondef(p.oid))>0) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fn_cash_game_create','fn_cash_game_create_impl_20260905','fn_cash_game_ensure')) AND NOT EXISTS(SELECT 1 FROM public.cash_games g WHERE g.enabled AND g.club_id='946747c6-b991-4220-b0cb-effbea46ecd2') AND (SELECT count(*)=9 AND bool_and(NOT s.enabled AND coalesce(t.enabled,false) AND t.club_id='fade0000-0000-0000-0000-000000000001' AND t.union_id=t.club_id AND t.template_name='classic' AND t.variant=s.variant AND t.sb=s.sb AND t.bb=s.bb) FROM public.cash_games s LEFT JOIN public.cash_games t ON t.id::text=s.ruleset_snapshot->>'retired_to_union_game_id' WHERE s.club_id='946747c6-b991-4220-b0cb-effbea46ecd2' AND s.id IN ('13b27cf7-dce5-4758-ac8b-914d824ca792','353a3cda-789e-497d-91bb-8432fe3a0b17','72a2aab2-829c-4aa4-a9b3-e82e3c84e301','7efae3ce-09e5-459a-ad35-e1e735219632','8f23f730-2990-481d-a78c-030ad5e74ada','929003a4-4d84-47b4-a16e-f68766ed2e40','b94cd234-183a-40bc-80ba-c234515d4e94','e4f9241f-bd35-4b7b-b1cc-e5c06e9979be','e6dadbfb-6172-4934-96b8-ecdb04b0e6c2'))
-- Owner: launch Midway member-club cash games from Midway Union only.
-- Exact original creation/ensure authorities; no wallet, seat, hand or payout writes.
-- Explicit finite relocation of nine empty Classic keys; preserve every historical ID.
-- No replay of installed 20261023230807. One short transaction; no relation locks.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
SET LOCAL TIME ZONE 'UTC';

DO $authority$
DECLARE r record; s text; n text;
 guard_sql text := $guard$
  -- MIDWAY_UNION_HOST_ONLY: member wallets pay; the union owns new games.
  IF p_club_id <> 'fade0000-0000-0000-0000-000000000001'::uuid
     AND EXISTS (SELECT 1 FROM public.fn_club_union_context(p_club_id) ctx
       WHERE ctx.member_union_id='fade0000-0000-0000-0000-000000000001'::uuid) THEN
    RAISE EXCEPTION 'UNION_HOST_REQUIRED: launch Midway games from Midway Union'
      USING ERRCODE='23514';
  END IF;
$guard$;
 anchor_sql text := $anchor$  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;$anchor$;
BEGIN
 FOR r IN SELECT * FROM (VALUES
 ('fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)','c1c66ea2cc05eef5fb8e272f89949380'),
 ('fn_cash_game_create_impl_20260905(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)','f42b96b9168a2fd3da2fb7f7397cada8'),
 ('fn_cash_game_ensure(uuid,text,numeric,numeric,text,integer)','d0e515a21c129357721afb9eabd7f05a')
 ) x(sig,want) LOOP
  s:=pg_get_functiondef(r.sig::regprocedure);
  IF md5(s)<>r.want THEN RAISE EXCEPTION 'Midway creation source changed: %',r.sig; END IF;
  IF r.sig LIKE 'fn_cash_game_ensure(%' THEN
   n:=replace(s,E'BEGIN\n  IF v_t NOT IN',E'BEGIN\n'||guard_sql||E'\n  IF v_t NOT IN');
  ELSE
   n:=replace(s,anchor_sql,anchor_sql||E'\n'||guard_sql);
  END IF;
  IF n=s OR position('MIDWAY_UNION_HOST_ONLY' IN n)=0 THEN
   RAISE EXCEPTION 'Midway creation anchor changed: %',r.sig;
  END IF;
  EXECUTE n;
 END LOOP;
END $authority$;

DO $catalog$
DECLARE r record; t record; g public.cash_games%ROWTYPE; target_id uuid; v_count integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.fn_club_union_context('946747c6-b991-4220-b0cb-effbea46ecd2') ctx
     WHERE ctx.member_union_id='fade0000-0000-0000-0000-000000000001') THEN
  RAISE EXCEPTION 'Club Savage no longer belongs to Midway';
 END IF;
 FOR r IN SELECT * FROM (VALUES
 ('13b27cf7-dce5-4758-ac8b-914d824ca792'::uuid,'ee5feb2b13bc9c58aa818603c54a29e2'),
 ('353a3cda-789e-497d-91bb-8432fe3a0b17'::uuid,'84462b018abae6adc0c8d40f37b9c70c'),
 ('72a2aab2-829c-4aa4-a9b3-e82e3c84e301'::uuid,'1fa9d091c7036260633957a337a142c0'),
 ('7efae3ce-09e5-459a-ad35-e1e735219632'::uuid,'0fef6b562f134a6b095a9c6b17e4c7c3'),
 ('8f23f730-2990-481d-a78c-030ad5e74ada'::uuid,'cdeda3d71d2acdd0d9604aa3250c0fa4'),
 ('929003a4-4d84-47b4-a16e-f68766ed2e40'::uuid,'1dbedc4fe3e99a515ce35178bdfe431b'),
 ('b94cd234-183a-40bc-80ba-c234515d4e94'::uuid,'940dfbab034f3153b7d3b72a633c1503'),
 ('e4f9241f-bd35-4b7b-b1cc-e5c06e9979be'::uuid,'4243c9e8329e5bffc3b52612b6f24ecd'),
 ('e6dadbfb-6172-4934-96b8-ecdb04b0e6c2'::uuid,'d00cc8b45ae8385935ecf5ce2e2efab0')
 ) x(id,want) ORDER BY id LOOP
  SELECT * INTO STRICT g FROM public.cash_games WHERE id=r.id FOR UPDATE NOWAIT;
  IF md5((to_jsonb(g)-'updated_at'-'last_tick_at'-'last_tick_actions')::text)<>r.want
    OR g.club_id<>'946747c6-b991-4220-b0cb-effbea46ecd2'::uuid OR g.union_id IS NOT NULL
    OR NOT g.enabled OR g.template_name<>'classic' OR g.sb<>.5 OR g.bb<>1
    OR g.cluster_mode<>'must_move' OR coalesce(g.lightning_enabled,false) THEN
   RAISE EXCEPTION 'Savage empty-game preimage changed: %',r.id;
  END IF;
  FOR t IN SELECT id FROM public.tables WHERE cluster_id=g.id ORDER BY id LOOP
   IF NOT pg_try_advisory_xact_lock(hashtextextended('table_seat:'||t.id::text,0)) THEN
    RAISE EXCEPTION 'Savage original seat authority busy: %',t.id;
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
      WHERE tb.cluster_id=g.id AND s.left_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.lightning_pool_session p WHERE p.cluster_id=g.id AND p.exited_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.lightning_instance i WHERE i.cluster_id=g.id AND i.state IN ('forming','reserved','dealing','settling'))
    OR EXISTS(SELECT 1 FROM public.lightning_reservation q WHERE q.cluster_id=g.id AND q.state IN ('pending','committed'))
    OR EXISTS(SELECT 1 FROM public.hand_state_snapshots h JOIN public.tables tb ON tb.id=h.table_id
      WHERE tb.cluster_id=g.id AND NOT h.is_complete AND h.updated_at>clock_timestamp()-interval '6 hours')
    OR EXISTS(SELECT 1 FROM public.cash_game_waitlist w WHERE w.game_id=g.id AND w.status IN ('waiting','notified'))
    OR EXISTS(SELECT 1 FROM public.cash_seat_moves m WHERE m.game_id=g.id AND m.state='pending')
    OR EXISTS(SELECT 1 FROM public.cash_player_session c WHERE c.closed_at IS NULL
      AND (c.cluster_id=g.id OR c.scope_id=g.id
        OR c.table_id IN (SELECT id FROM public.tables WHERE cluster_id=g.id)
        OR c.scope_id IN (SELECT id FROM public.tables WHERE cluster_id=g.id))) THEN
   RAISE EXCEPTION 'Savage game has live custody or reservations: %',g.id;
  END IF;
  -- Explicit owner relocation, not a planner overriding an unrelated operator close.
  target_id:=public.fn_cash_game_ensure('fade0000-0000-0000-0000-000000000001',
     g.variant,g.sb,g.bb,'classic',g.handedness);
  IF NOT EXISTS(SELECT 1 FROM public.cash_games c WHERE c.id=target_id
      AND c.club_id='fade0000-0000-0000-0000-000000000001'
      AND c.union_id='fade0000-0000-0000-0000-000000000001'
      AND c.enabled AND c.template_name='classic' AND c.variant=g.variant AND c.sb=g.sb AND c.bb=g.bb
      AND c.cluster_mode='must_move' AND NOT coalesce(c.lightning_enabled,false)) THEN
   RAISE EXCEPTION 'Original ensure did not produce the matching union Classic: %',g.id;
  END IF;
  UPDATE public.cash_games SET enabled=false,state='dormant',
    ruleset_snapshot=ruleset_snapshot||jsonb_build_object('retired_to_union_game_id',target_id::text),
    updated_at=clock_timestamp() WHERE id=g.id;
  INSERT INTO public.cash_cluster_events(game_id,kind,cluster_epoch,payload)
    VALUES(g.id,'game_retired_to_union',g.cluster_epoch,jsonb_build_object(
      'source_game_id',g.id,'target_game_id',target_id,'owner_order','Midway Union owns all Midway launches',
      'migration','20261024053530','seated_at_retirement',0));
  v_count:=v_count+1;
 END LOOP;
 IF v_count<>9 OR EXISTS(SELECT 1 FROM public.cash_games WHERE club_id='946747c6-b991-4220-b0cb-effbea46ecd2' AND enabled) THEN
  RAISE EXCEPTION 'Savage finite catalog retirement did not cover exactly nine keys';
 END IF;
END $catalog$;
COMMIT;
