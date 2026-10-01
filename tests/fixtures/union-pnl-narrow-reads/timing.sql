SET check_function_bodies=off;
-- Harness only: a production-shaped book for the IO comparison. Rows are as
-- wide as production's (inventory events ~730 bytes, nine in ten of them
-- table_seats, interleaved in event order; hand evidence ~1.5 KB, some
-- TOASTed; every credit's and entry's tournament snapshot TOASTed), so the
-- blocks each read touches are counted, not guessed.
CREATE OR REPLACE FUNCTION public.hx_timing_book(p_events integer, p_hands integer, p_credits integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE u uuid:='fade0000-0000-0000-0000-000000000001'; o uuid:=gen_random_uuid(); w0 timestamptz:='2026-09-21 07:00+00'; w1 timestamptz:='2026-09-28 07:00+00';
 pad text:=repeat('p',560); n_t int:=greatest(p_events/2000,10);
BEGIN
 PERFORM setseed(0.42);
 INSERT INTO public.hx_meta VALUES(u,o);
 INSERT INTO public.union_pnl_weekly_capture VALUES(true,'2026-09-18 00:41:12+00',1);
 INSERT INTO public.union_pnl_inventory_capture VALUES(true,'2026-09-18 00:20:48+00',1,'{}');
 INSERT INTO public.hx_inventory SELECT b,jsonb_build_object('status','observed','population',jsonb_build_object('tables','[]'::jsonb,'table_seats','[]'::jsonb,
  'tournaments','[]'::jsonb,'tournament_players','[]'::jsonb,'union_clubs','[]'::jsonb),'issues','[]'::jsonb) FROM unnest(ARRAY[w0,w1]) b;
 CREATE TEMP TABLE hx_t ON COMMIT DROP AS SELECT g n,gen_random_uuid() id,CASE WHEN g%3=0 THEN o ELSE u END union_id FROM generate_series(1,n_t) g;
 -- one frame per event transaction, in event order
 INSERT INTO public.union_pnl_transaction_frames SELECT (100000+g)::text::xid8,w0+(w1-w0)*g/p_events,w0 FROM generate_series(1,p_events) g;
 INSERT INTO public.union_pnl_inventory_events
 SELECT s.g,s.src,s.rid,w0+(w1-w0)*s.g/p_events,(100000+s.g)::text::xid8,'UPDATE',
  CASE WHEN s.src='tournaments' THEN jsonb_build_object('id',s.rid,'union_id',s.union_id,'status','RUNNING','pad',pad)
   ELSE jsonb_build_object('id',s.rid,'tournament_id',s.tid,'user_id',gen_random_uuid(),'status','playing','pad',pad) END,
  CASE WHEN s.src='tournaments' THEN jsonb_build_object('id',s.rid,'union_id',s.union_id,'status','RUNNING','pad',pad)
   ELSE jsonb_build_object('id',s.rid,'tournament_id',s.tid,'user_id',gen_random_uuid(),'status','out','pad',pad) END
 FROM (SELECT g,CASE WHEN g%20=0 THEN 'tournament_players' WHEN g%25=1 THEN 'tournaments' ELSE 'table_seats' END src,
   CASE WHEN g%25=1 THEN t.id ELSE gen_random_uuid() END rid,t.id tid,t.union_id
  FROM generate_series(1,p_events) g JOIN hx_t t ON t.n=1+g%n_t) s ORDER BY s.g;
 -- an entry for every registration touched, its tournament snapshot TOASTed
 INSERT INTO public.tournament_participant_funding_receipts(id,transaction_id,observed_at,registration_id,tournament_id,user_id,operation,asset,amount,
   entitlement_id,ledger_id,funding_club_id,registration_snapshot,tournament_snapshot,ledger_snapshot,wallet_snapshot)
 SELECT gen_random_uuid(),e.transaction_id,e.observed_at,e.row_id,(e.after_row->>'tournament_id')::uuid,gen_random_uuid(),'register','chips',10,
  gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{"club_id":null,"is_satellite_qualifier":false}',
  jsonb_build_object('blob',(SELECT string_agg(md5(random()::text),'') FROM generate_series(1,80))),
  jsonb_build_object('blob',(SELECT string_agg(md5(random()::text),'') FROM generate_series(1,40))),
  jsonb_build_object('blob',(SELECT string_agg(md5(random()::text),'') FROM generate_series(1,40)))
 FROM public.union_pnl_inventory_events e WHERE e.source_name='tournament_players';
 -- hands: ~1.5 KB of evidence, one in eight TOASTed
 INSERT INTO public.union_pnl_transaction_frames SELECT (5000000+g)::text::xid8,w0+(w1-w0)*g/p_hands,w0 FROM generate_series(1,p_hands) g;
 INSERT INTO public.union_pnl_cash_outcomes
 SELECT gen_random_uuid(),g,gen_random_uuid(),(5000000+g)::text::xid8,w0+(w1-w0)*g/p_hands,md5(g::text),s.scope,
  jsonb_build_object('status','ready','basis_certified',true,'all_players_included',true,'game_scope',s.scope,'accepted_rake',0.5,
   'issues','[]'::jsonb,'scope',jsonb_build_object('pad',repeat('s',300)),
   'blob',CASE WHEN g%8=0 THEN (SELECT string_agg(md5(random()::text||g||k),'') FROM generate_series(1,70) k) END,
   'participants',(SELECT jsonb_agg(jsonb_build_object('user_id',gen_random_uuid(),'earning_club_id',gen_random_uuid(),'observed_stack_delta',round((random()*10-5)::numeric,2),
     'is_horse',false,'ownership_scope','club','funding_receipt_ids',jsonb_build_array(gen_random_uuid(),gen_random_uuid()),'ownership_certified',true))
    FROM generate_series(1,2+g%4)))
 FROM generate_series(1,p_hands) g
 CROSS JOIN LATERAL (SELECT jsonb_build_object('game_union_id',CASE WHEN g%5=0 THEN o ELSE u END,'host_club_id',gen_random_uuid(),'tournament_id',NULL,
   'is_private',false,'asset','chips','unit_scale',2) scope) s;
 -- credits: every tournament snapshot TOASTed, as in production
 INSERT INTO public.union_pnl_transaction_frames SELECT (9000000+g)::text::xid8,w0+(w1-w0)*g/p_credits,w0 FROM generate_series(1,p_credits) g;
 INSERT INTO public.tournament_accounting_credit_receipts(transaction_id,id,observed_at,idempotency_key,tournament_id,user_id,asset,amount,ledger_id,
   wallet_transaction_id,payout_id,credited_club_id,ledger_snapshot,wallet_snapshot,payout_snapshot,registration_snapshot,tournament_snapshot,entry_receipt_ids)
 SELECT (9000000+g)::text::xid8,gen_random_uuid(),w0,md5(g::text),r.tournament_id,r.user_id,'chips',5,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
  r.funding_club_id,jsonb_build_object('blob',(SELECT string_agg(md5(random()::text||g||k),'') FROM generate_series(1,40) k)),'{}',
  jsonb_build_object('blob',(SELECT string_agg(md5(random()::text||g||k),'') FROM generate_series(1,40) k)),'{}',
  jsonb_build_object('union_id',t.union_id,'blob',(SELECT string_agg(md5(random()::text||g||k),'') FROM generate_series(1,80) k)),
  -- as in production, nearly every award names the entry it returns to (one in fifty does not)
  CASE WHEN g%50=0 THEN ARRAY[]::uuid[] ELSE ARRAY[r.id] END
 FROM generate_series(1,p_credits) g
 JOIN (SELECT row_number() OVER (ORDER BY q.observed_at,q.id) n,q.* FROM public.tournament_participant_funding_receipts q) r
  ON r.n=1+g%(SELECT count(*) FROM public.tournament_participant_funding_receipts)
 JOIN hx_t t ON t.id=r.tournament_id;
END $$;
-- blocks touched (buffer hits + reads) on every user table, heap + TOAST + index
CREATE OR REPLACE VIEW public.hx_blocks AS
 SELECT relname,COALESCE(heap_blks_read,0)+COALESCE(heap_blks_hit,0) heap,COALESCE(toast_blks_read,0)+COALESCE(toast_blks_hit,0) toast,
  COALESCE(idx_blks_read,0)+COALESCE(idx_blks_hit,0)+COALESCE(tidx_blks_read,0)+COALESCE(tidx_blks_hit,0) idx
 FROM pg_statio_user_tables;
