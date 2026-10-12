-- Book 2026-09-21 07:00 .. 09-28 07:00 (helpers: union-pnl-opening-resolution/seed.sql).
-- T_OK: baseline paid bounty MTT 18+2, T_FREE: baseline free-buy, T_INS: after capture.
SELECT public.hx_t('T_OK','U','RUNNING','baseline',18,2,NULL,NULL,false);
SELECT public.hx_r('o1','T_OK','uo1','A','baseline','2026-09-16 05:00+00');
SELECT public.hx_l('lo1','T_OK','uo1',true,20,'tournament_buyin','A','2026-09-16 05:00+00');
SELECT public.hx_credit('co1','T_OK','uo1','A',public.hx_l('ko1','T_OK','uo1',false,5,'bounty','A','2026-09-18 03:00+00'),5,'2026-09-18 03:00+00');
SELECT public.hx_r('o2','T_OK','uo2','B','baseline','2026-09-16 05:01+00');
SELECT public.hx_l('lo2','T_OK','uo2',true,20,'tournament_buyin','B','2026-09-16 05:01+00');
SELECT public.hx_r('o3','T_OK','uo3','A','INSERT','2026-09-18 01:30+00');
SELECT public.hx_entry('ro3','o3','T_OK','uo3','A',20,public.hx_l('lo3','T_OK','uo3',true,20,'tournament_buyin','A','2026-09-18 01:30+00'),'2026-09-18 01:30+00');
SELECT public.hx_t('T_FREE','U','RUNNING','baseline',0,0,1,1,true);
SELECT public.hx_r('f1','T_FREE','uf1','A','baseline','2026-09-17 20:00+00');
SELECT public.hx_l('lf1','T_FREE','uf1',true,1,'addon','A','2026-09-17 20:10+00');
SELECT public.hx_t('T_INS','U','RUNNING','INSERT',9,1,NULL,NULL,false);
SELECT public.hx_r('i1','T_INS','ui1','A','INSERT','2026-09-19 10:00+00');
SELECT public.hx_entry('ri1','i1','T_INS','ui1','A',10,public.hx_l('li1','T_INS','ui1',true,10,'tournament_buyin','A','2026-09-19 10:00+00'),'2026-09-19 10:00+00');
-- another Union's baseline tournament, never resolved
SELECT public.hx_t('T_OTH','O','RUNNING','baseline',9,1,NULL,NULL,false);
SELECT public.hx_r('x1','T_OTH','ux1','A','baseline','2026-09-16 05:00+00');
SELECT public.hx_l('lx1','T_OTH','ux1',true,10,'tournament_buyin','A','2026-09-16 05:00+00');
SELECT public.hx_seal('2026-09-21 07:00+00');
-- the week: every registration is touched (a bust) and every tournament ends
CREATE FUNCTION public.hx_touch(p_reg text, p_t text, p_at timestamptz) RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.union_pnl_inventory_events VALUES(nextval('public.hx_ev'),'tournament_players',public.u(p_reg),p_at,public.hx_frame(p_at),'UPDATE',
  jsonb_build_object('id',public.u(p_reg),'tournament_id',public.u(p_t)),jsonb_build_object('id',public.u(p_reg),'tournament_id',public.u(p_t),'status','eliminated')) $$;
-- an award: the posted ledger credit and the platform's credit receipt
CREATE FUNCTION public.hx_award(p text, p_t text, p_user text, p_reg text, p_club text, p_amount numeric, p_ids uuid[], p_at timestamptz,
 p_ledger_amount numeric DEFAULT NULL, p_cat text DEFAULT 'tournament_prize') RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.tournament_accounting_credit_receipts(transaction_id,id,observed_at,tournament_id,user_id,asset,amount,ledger_id,credited_club_id,
  registration_snapshot,tournament_snapshot,entry_receipt_ids)
 VALUES(public.hx_frame(p_at),public.u(p),p_at,public.u(p_t),public.u(p_user),'chips',p_amount,
  public.hx_l('l'||p,p_t,p_user,false,COALESCE(p_ledger_amount,p_amount),p_cat,p_club,p_at),public.u(p_club),
  jsonb_build_object('id',public.u(p_reg)),jsonb_build_object('union_id',public.u('U')),p_ids) $$;
SELECT public.hx_touch(k,t,'2026-09-24 10:00+00') FROM (VALUES('o1','T_OK'),('o2','T_OK'),('o3','T_OK'),('f1','T_FREE'),('i1','T_INS')) v(k,t);
SELECT public.hx_award('ao2','T_OK','uo2','o2','B',50,'{}','2026-09-25 10:00+00');
SELECT public.hx_award('ao1b','T_OK','uo1','o1','A',3.75,'{}','2026-09-25 09:00+00',NULL,'bounty');
SELECT public.hx_award('af1','T_FREE','uf1','f1','A',10,'{}','2026-09-25 10:01+00');
SELECT public.hx_award('ao3','T_OK','uo3','o3','A',30,ARRAY[public.u('ro3')],'2026-09-25 10:02+00');
SELECT public.hx_award('ai1','T_INS','ui1','i1','A',12,ARRAY[public.u('ri1')],'2026-09-25 10:03+00');
INSERT INTO public.union_pnl_inventory_checkpoint_rows
 SELECT '2026-09-28 07:00+00',source_name,row_id,latest_event_id,first_operation,
  CASE WHEN source_name='tournaments' THEN jsonb_set(after_row,'{status}','"COMPLETED"') ELSE after_row END
 FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary='2026-09-21 07:00+00' AND row_id<>public.u('T_OTH');
SELECT public.hx_seal('2026-09-28 07:00+00');
INSERT INTO public.hx_eco VALUES(public.u('U'),'{"status":"ready","segments":[{"terms":{"eco_rate":0.10,"eco_enabled":true,"eco_base_mode":"club_cash_profit"}}]}'),
 (public.u('O'),'{"status":"ready","segments":[{"terms":{"eco_rate":0.10,"eco_enabled":true,"eco_base_mode":"club_cash_profit"}}]}');
