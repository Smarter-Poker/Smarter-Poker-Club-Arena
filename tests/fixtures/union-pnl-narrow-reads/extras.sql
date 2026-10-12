SET check_function_bodies=off;
-- Harness only: edge shapes added to every randomized book (gen.py of
-- union-pnl-evidence-fast), for the reads this change moves: deleted and
-- re-pointed registrations, non-canonical and missing tournament ids,
-- events whose frame is outside the week or missing, tournaments that change
-- Union, baseline first operations at both boundaries, participants that are
-- not objects or lack keys, rakes as strings or missing, credits with no or
-- another Union or frame, and zero-amount entries of every snapshot shape.
-- p_break: 1 = participants not an array, 2 = a rake that is not a number,
-- 3 = participants JSON null (the report must refuse all three exactly as before).
CREATE SEQUENCE IF NOT EXISTS public.hx_xev START 10000000;
-- deterministic under setseed (gen_random_uuid is not), so a book can be written twice
CREATE OR REPLACE FUNCTION public.hx_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$ SELECT md5(random()::text||random()::text)::uuid $$;
CREATE SEQUENCE IF NOT EXISTS public.hx_xfirst START 1 INCREMENT 1;
CREATE SEQUENCE IF NOT EXISTS public.hx_xtx START 900000;
CREATE OR REPLACE FUNCTION public.hx_xframe(p_at timestamptz) RETURNS xid8 LANGUAGE plpgsql AS $$
DECLARE x xid8:=nextval('public.hx_xtx')::text::xid8;
BEGIN IF p_at IS NOT NULL THEN INSERT INTO public.union_pnl_transaction_frames VALUES(x,p_at,public.fn_union_week_start(p_at)); END IF; RETURN x; END $$;
CREATE OR REPLACE FUNCTION public.hx_xevent(p_first boolean, p_source text, p_row uuid, p_at timestamptz, p_frame_at timestamptz, p_op text, p_before jsonb, p_after jsonb)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.union_pnl_inventory_events VALUES(
  CASE WHEN p_first THEN -nextval('public.hx_xfirst') ELSE nextval('public.hx_xev') END,p_source,p_row,p_at,public.hx_xframe(p_frame_at),p_op,p_before,p_after) $$;
CREATE OR REPLACE FUNCTION public.hx_extras(p_seed integer, p_break integer DEFAULT 0) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u uuid; o uuid; w0 timestamptz:='2026-09-21 07:00+00'; w1 timestamptz:='2026-09-28 07:00+00';
 t record; reg uuid; tid text; at timestamptz; fat timestamptz; k int; op text; row jsonb; c uuid; r uuid; amt numeric; snap jsonb; i int;
 tours uuid[]; pop jsonb; x jsonb;
BEGIN
 PERFORM setseed(((p_seed*7919)%10000)/10000.0);
 SELECT union_id,other_union_id INTO u,o FROM public.hx_meta;
 tours:=ARRAY(SELECT DISTINCT row_id FROM public.union_pnl_inventory_events WHERE source_name='tournaments' ORDER BY 1);
 IF cardinality(tours)=0 THEN RETURN; END IF;
 -- A. registration events of every shape in and around the week
 FOR k IN 1..(8+floor(random()*16))::int LOOP
  reg:=CASE WHEN random()<0.25 THEN (SELECT e.row_id FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players' ORDER BY random() LIMIT 1)
   ELSE public.hx_uuid() END;
  IF reg IS NULL THEN reg:=public.hx_uuid(); END IF;
  tid:=(tours[1+floor(random()*cardinality(tours))::int])::text;
  tid:=CASE WHEN random()<0.08 THEN upper(tid) WHEN random()<0.08 THEN 'garbage' WHEN random()<0.05 THEN NULL ELSE tid END;
  at:=w0+random()*(w1-w0); IF random()<0.1 THEN at:=w0-interval '3 hours'; END IF;
  fat:=CASE WHEN random()<0.1 THEN NULL WHEN random()<0.1 THEN w1+interval '1 hour' ELSE at END;
  op:=(ARRAY['INSERT','UPDATE','UPDATE','DELETE'])[1+floor(random()*4)::int];
  row:=jsonb_build_object('id',reg,'user_id',public.hx_uuid(),'status','playing');
  IF tid IS NOT NULL THEN row:=row||jsonb_build_object('tournament_id',CASE WHEN random()<0.04 THEN to_jsonb(7) ELSE to_jsonb(tid) END); END IF;
  PERFORM public.hx_xevent(false,'tournament_players',reg,at,fat,op,CASE WHEN op<>'INSERT' THEN row END,CASE WHEN op<>'DELETE' THEN row||jsonb_build_object('status','out') END);
  -- F. its entry receipts: none, normal, zero-amount of every snapshot shape, non-chips
  IF random()<0.8 THEN
   FOR i IN 1..(1+floor(random()*2))::int LOOP
    amt:=CASE WHEN random()<0.45 THEN 0 ELSE round((random()*80)::numeric,2) END;
    snap:=jsonb_build_object('club_id',CASE WHEN random()<0.85 THEN public.hx_uuid()::text END);
    IF random()<0.7 THEN snap:=snap||jsonb_build_object('is_satellite_qualifier',random()<0.3); END IF;
    IF random()<0.2 THEN snap:=snap||jsonb_build_object('source_satellite_id',public.hx_uuid()); END IF;
    INSERT INTO public.tournament_participant_funding_receipts(id,transaction_id,observed_at,registration_id,tournament_id,user_id,operation,asset,amount,
      entitlement_id,ledger_id,funding_club_id,registration_snapshot,tournament_snapshot)
    VALUES(public.hx_uuid(),public.hx_xframe(at),at,reg,CASE WHEN tid ~ '^[0-9a-f-]{36}$' THEN tid::uuid ELSE public.hx_uuid() END,public.hx_uuid(),'register',
      CASE WHEN random()<0.08 THEN 'ticket' ELSE 'chips' END,amt,
      CASE WHEN amt>0 OR random()<0.3 THEN public.hx_uuid() END,CASE WHEN amt>0 OR random()<0.3 THEN public.hx_uuid() END,
      CASE WHEN amt>0 THEN public.hx_uuid() END,snap,'{}');
   END LOOP;
  END IF;
 END LOOP;
 -- B. tournaments that change Union, are deleted, or name none
 FOR k IN 1..(2+floor(random()*4))::int LOOP
  r:=tours[1+floor(random()*cardinality(tours))::int]; at:=w0+random()*(w1-w0);
  op:=(ARRAY['UPDATE','UPDATE','DELETE'])[1+floor(random()*3)::int];
  row:=jsonb_build_object('id',r,'status','RUNNING','union_id',CASE WHEN random()<0.5 THEN u WHEN random()<0.5 THEN o END);
  IF random()<0.15 THEN row:=row-'union_id'; END IF;
  PERFORM public.hx_xevent(false,'tournaments',r,at,at,op,row,CASE WHEN op<>'DELETE' THEN row END);
 END LOOP;
 -- C. first operations at both boundaries: baseline tournaments, and their
 -- registrations first captured as INSERT, baseline or UPDATE
 FOR pop IN SELECT result FROM public.hx_inventory LOOP
  FOR x IN SELECT v FROM jsonb_array_elements(COALESCE(pop#>'{population,tournaments}','[]')) v LOOP
   IF random()<0.3 THEN
    PERFORM public.hx_xevent(true,'tournaments',(x#>>'{row,id}')::uuid,'2026-09-18 00:20:48+00',NULL,'baseline',NULL,x->'row');
   END IF;
  END LOOP;
  FOR x IN SELECT v FROM jsonb_array_elements(COALESCE(pop#>'{population,tournament_players}','[]')) v LOOP
   IF random()<0.4 AND (x#>>'{row,id}') ~ '^[0-9a-f-]{36}$' THEN
    PERFORM public.hx_xevent(true,'tournament_players',(x#>>'{row,id}')::uuid,'2026-09-18 00:20:48+00',NULL,
     (ARRAY['INSERT','baseline','UPDATE'])[1+floor(random()*3)::int],NULL,x->'row');
   END IF;
  END LOOP;
 END LOOP;
 -- D. hands whose participants or rake take every odd shape
 FOR k IN 1..(6+floor(random()*10))::int LOOP
  at:=w0+random()*(w1-w0);
  x:=jsonb_build_array(jsonb_build_object('earning_club_id',public.hx_uuid(),'user_id',public.hx_uuid(),'observed_stack_delta',round((random()*40-20)::numeric,2),'extra',repeat('x',50)));
  IF random()<0.3 THEN x:=x||jsonb_build_array(jsonb_build_object('user_id',public.hx_uuid())); END IF;
  IF random()<0.2 THEN x:=x||jsonb_build_array(to_jsonb(5)); END IF;
  IF random()<0.2 THEN x:=x||jsonb_build_array('null'::jsonb); END IF;
  IF random()<0.2 THEN x:=x||jsonb_build_array(jsonb_build_array(1,2)); END IF;
  IF random()<0.2 THEN x:=x||jsonb_build_array(jsonb_build_object('earning_club_id',NULL,'user_id',public.hx_uuid(),'observed_stack_delta','3.25')); END IF;
  IF p_break=1 AND k=1 THEN x:=jsonb_build_object('earning_club_id',public.hx_uuid()); END IF;
  snap:=jsonb_build_object('status',CASE WHEN random()<0.8 THEN 'ready' ELSE 'blocked' END,'basis_certified',random()<0.9,'all_players_included',true,
   'game_scope',jsonb_build_object('game_union_id',u,'host_club_id',public.hx_uuid(),'tournament_id',NULL,'is_private',false,'asset','chips','unit_scale',2),
   'participants',x);
  snap:=CASE WHEN random()<0.2 THEN snap WHEN random()<0.3 THEN snap||jsonb_build_object('accepted_rake','1.50')
   ELSE snap||jsonb_build_object('accepted_rake',round((random()*3)::numeric,2)) END;
  IF p_break=2 AND k=1 THEN snap:=snap||jsonb_build_object('accepted_rake','abc'); END IF;
  IF random()<0.1 THEN snap:=snap-'participants'; END IF;
  IF p_break=3 AND k=2 THEN snap:=snap||jsonb_build_object('participants','null'::jsonb); END IF;
  INSERT INTO public.union_pnl_cash_outcomes VALUES(public.hx_uuid(),floor(random()*1e6)::bigint,public.hx_uuid(),public.hx_xframe(at),at,md5(random()::text),
   snap->'game_scope',snap);
 END LOOP;
 -- E. credits with no Union, another Union, no frame, a frame outside the
 -- week, and entries of every shape
 FOR k IN 1..(4+floor(random()*8))::int LOOP
  at:=w0+random()*(w1-w0); fat:=CASE WHEN random()<0.1 THEN NULL WHEN random()<0.1 THEN w0-interval '2 days' ELSE at END;
  r:=(SELECT id FROM public.tournament_participant_funding_receipts ORDER BY random() LIMIT 1);
  c:=public.hx_uuid();
  INSERT INTO public.tournament_accounting_credit_receipts(transaction_id,id,observed_at,idempotency_key,tournament_id,user_id,asset,amount,ledger_id,
    wallet_transaction_id,payout_id,credited_club_id,ledger_snapshot,wallet_snapshot,payout_snapshot,registration_snapshot,tournament_snapshot,entry_receipt_ids)
  SELECT public.hx_xframe(fat),c,at,md5(random()::text),tours[1+floor(random()*cardinality(tours))::int],COALESCE(q.user_id,public.hx_uuid()),'chips',
   round((random()*30)::numeric,2),public.hx_uuid(),public.hx_uuid(),public.hx_uuid(),
   CASE WHEN random()<0.6 THEN public.fn_union_pnl_tournament_entry_club(q) ELSE public.hx_uuid() END,'{}','{}','{}','{}',
   CASE WHEN random()<0.15 THEN '{}'::jsonb WHEN random()<0.3 THEN jsonb_build_object('union_id',o) ELSE jsonb_build_object('union_id',u) END,
   CASE WHEN random()<0.15 OR r IS NULL THEN ARRAY[]::uuid[] WHEN random()<0.1 THEN ARRAY[public.hx_uuid()] ELSE ARRAY[r] END
  FROM (SELECT 1) one LEFT JOIN public.tournament_participant_funding_receipts q ON q.id=r;
 END LOOP;
END $$;
-- Harness only: every projection row equals its source's projection, and
-- every source row of the projected kinds has one (the full proof; the
-- migration's fn_union_pnl_projection_verify samples the same test).
CREATE OR REPLACE FUNCTION public.hx_projection_exact() RETURNS text LANGUAGE sql AS $$
 SELECT (SELECT count(*) FROM (
   (SELECT e.event_id,e.source_name,e.row_id,e.observed_at,e.transaction_id,b.observed_at,e.operation,
     COALESCE(e.after_row,e.before_row)->>'tournament_id',COALESCE(e.after_row,e.before_row)->>'union_id'
    FROM public.union_pnl_inventory_events e LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=e.transaction_id
    WHERE e.source_name IN ('tournament_players','tournaments')
    EXCEPT ALL SELECT event_id,source_name,row_id,observed_at,transaction_id,frame_observed_at,operation,tournament_id,union_id FROM public.union_pnl_inventory_touches)
   UNION ALL
   (SELECT event_id,source_name,row_id,observed_at,transaction_id,frame_observed_at,operation,tournament_id,union_id FROM public.union_pnl_inventory_touches
    EXCEPT ALL SELECT e.event_id,e.source_name,e.row_id,e.observed_at,e.transaction_id,b.observed_at,e.operation,
     COALESCE(e.after_row,e.before_row)->>'tournament_id',COALESCE(e.after_row,e.before_row)->>'union_id'
    FROM public.union_pnl_inventory_events e LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=e.transaction_id
    WHERE e.source_name IN ('tournament_players','tournaments'))) d)||'/'||
  (SELECT count(*) FROM (
   (SELECT to_jsonb(t)::text FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence) t
    EXCEPT ALL SELECT to_jsonb(h)::text FROM public.union_pnl_cash_outcome_touches h)
   UNION ALL
   (SELECT to_jsonb(h)::text FROM public.union_pnl_cash_outcome_touches h
    EXCEPT ALL SELECT to_jsonb(t)::text FROM public.union_pnl_cash_outcomes o CROSS JOIN LATERAL public.fn_union_pnl_cash_outcome_touch_row(o.table_id,o.hand_number,o.recognized_at,o.game_scope,o.evidence) t)) d)||'/'||
  (SELECT count(*) FROM (
   (SELECT c.id,c.transaction_id,b.observed_at,c.tournament_snapshot->>'union_id' FROM public.tournament_accounting_credit_receipts c
     LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id
    EXCEPT ALL SELECT id,transaction_id,frame_observed_at,union_id FROM public.union_pnl_credit_touches)
   UNION ALL
   (SELECT id,transaction_id,frame_observed_at,union_id FROM public.union_pnl_credit_touches
    EXCEPT ALL SELECT c.id,c.transaction_id,b.observed_at,c.tournament_snapshot->>'union_id' FROM public.tournament_accounting_credit_receipts c
     LEFT JOIN public.union_pnl_transaction_frames b ON b.transaction_id=c.transaction_id)) d)
$$;
