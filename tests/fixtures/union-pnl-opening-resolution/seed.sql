-- Midway-shaped fixture: boundary 2026-09-21 07:00, original inventory
-- capture 2026-09-18 00:20:48, frames (weekly capture) from 00:41:12.
CREATE FUNCTION public.u(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(p)::uuid $$;
CREATE SEQUENCE public.hx_ev; CREATE SEQUENCE public.hx_tx START 1000; CREATE SEQUENCE public.hx_seq;
INSERT INTO public.hx_meta VALUES(public.u('U'),public.u('O'));
INSERT INTO public.union_pnl_inventory_capture VALUES(true,'2026-09-18 00:20:48+00',1,'{}');
INSERT INTO public.union_pnl_weekly_capture VALUES(true,'2026-09-18 00:41:12+00',1);
CREATE FUNCTION public.hx_frame(p_at timestamptz) RETURNS xid8 LANGUAGE plpgsql AS $$
DECLARE x xid8:=nextval('public.hx_tx')::text::xid8;
BEGIN INSERT INTO public.union_pnl_transaction_frames VALUES(x,p_at,'2026-09-14 07:00+00'); RETURN x; END $$;
-- a tournament: live terms, its first inventory event, its checkpoint row
CREATE FUNCTION public.hx_t(p text, p_union text, p_status text, p_op text, p_buy numeric, p_fee numeric, p_rebuy numeric, p_addon numeric, p_free boolean)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE e bigint:=nextval('public.hx_ev'); r jsonb;
BEGIN
 r:=jsonb_build_object('id',public.u(p),'status',p_status,'club_id',public.u(p_union),'union_id',public.u(p_union),'ended_at',NULL,'is_private',false,
  'prize_pool',0,'started_at','2026-09-18T02:00:00+00:00','bounty_pool',0,'bounty_pool_paid',0);
 INSERT INTO public.tournaments VALUES(public.u(p),p_buy,p_fee,p_rebuy,p_addon,p_rebuy IS NOT NULL,p_rebuy IS NOT NULL,p_addon IS NOT NULL,p_free);
 INSERT INTO public.union_pnl_inventory_events VALUES(e,'tournaments',public.u(p),
  CASE WHEN p_op='baseline' THEN '2026-09-18 00:20:48+00' ELSE '2026-09-18 01:00+00' END::timestamptz,
  CASE WHEN p_op='baseline' THEN NULL ELSE public.hx_frame('2026-09-18 01:00+00') END,p_op,NULL,r);
 INSERT INTO public.union_pnl_inventory_checkpoint_rows VALUES('2026-09-21 07:00+00','tournaments',public.u(p),e,p_op,r);
END $$;
-- a registration: its first inventory event and its checkpoint row
CREATE FUNCTION public.hx_r(p text, p_t text, p_user text, p_club text, p_op text, p_at timestamptz, p_sat boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE e bigint:=nextval('public.hx_ev'); r jsonb;
BEGIN
 r:=jsonb_build_object('id',public.u(p),'prize',0,'status','playing','club_id',public.u(p_club),'user_id',public.u(p_user),'eliminated_at',NULL,
  'registered_at',p_at,'tournament_id',public.u(p_t),'bounty_winnings',0,'source_satellite_id',CASE WHEN p_sat THEN public.u('SAT') END);
 INSERT INTO public.union_pnl_inventory_events VALUES(e,'tournament_players',public.u(p),
  CASE WHEN p_op='baseline' THEN '2026-09-18 00:20:48+00'::timestamptz ELSE p_at END,
  CASE WHEN p_op='baseline' OR p_at<'2026-09-18 00:41:12+00' THEN NULL ELSE public.hx_frame(p_at) END,p_op,NULL,r);
 INSERT INTO public.union_pnl_inventory_checkpoint_rows VALUES('2026-09-21 07:00+00','tournament_players',public.u(p),e,p_op,r);
END $$;
-- a posted, hash-chained ledger row
CREATE FUNCTION public.hx_l(p text, p_t text, p_user text, p_debit boolean, p_amount numeric, p_cat text, p_club text, p_at timestamptz, p_status text DEFAULT 'posted')
RETURNS uuid LANGUAGE sql AS $$
 INSERT INTO public.chip_ledger VALUES(public.u(p),
  CASE WHEN p_debit THEN 'player_wallet' ELSE 'prize_liability' END,CASE WHEN p_debit THEN public.u(p_user) ELSE public.u(p_t) END,
  CASE WHEN p_debit THEN 'prize_liability' ELSE 'player_wallet' END,CASE WHEN p_debit THEN public.u(p_t) ELSE public.u(p_user) END,
  p_amount,p_cat,public.u(p_club),public.u(p_t),p_at,p_status,nextval('public.hx_seq'),md5(p)) RETURNING id $$;
-- a framed tournament entry receipt (the normal path)
CREATE FUNCTION public.hx_entry(p text, p_reg text, p_t text, p_user text, p_club text, p_amount numeric, p_ledger uuid, p_at timestamptz, p_framed boolean DEFAULT true)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.tournament_participant_funding_receipts(id,transaction_id,observed_at,registration_id,tournament_id,user_id,operation,asset,amount,
  ledger_id,funding_club_id,registration_snapshot)
 VALUES(public.u(p),CASE WHEN p_framed THEN public.hx_frame(p_at) END,p_at,public.u(p_reg),public.u(p_t),public.u(p_user),'entry','chips',p_amount,
  p_ledger,CASE WHEN p_amount>0 THEN public.u(p_club) END,
  jsonb_build_object('club_id',public.u(p_club),'source_satellite_id',NULL,'is_satellite_qualifier',false)) $$;
-- a framed tournament credit receipt for a ledger return
CREATE FUNCTION public.hx_credit(p text, p_t text, p_user text, p_club text, p_ledger uuid, p_amount numeric, p_at timestamptz)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO public.tournament_accounting_credit_receipts(transaction_id,id,observed_at,tournament_id,user_id,asset,amount,ledger_id,credited_club_id,
  tournament_snapshot,entry_receipt_ids)
 VALUES(public.hx_frame(p_at),public.u(p),p_at,public.u(p_t),public.u(p_user),'chips',p_amount,p_ledger,public.u(p_club),
  jsonb_build_object('union_id',public.u('U')),'{}') $$;

-- T_INS: created after capture (first event INSERT); untouched by this change
SELECT public.hx_t('T_INS','U','RUNNING','INSERT',9,1,NULL,NULL,false);
SELECT public.hx_r('i1','T_INS','ui1','A','INSERT','2026-09-19 10:00+00');
SELECT public.hx_entry('ri1','i1','T_INS','ui1','A',10,public.hx_l('li1','T_INS','ui1',true,10,'tournament_buyin','A','2026-09-19 10:00+00'),'2026-09-19 10:00+00');
SELECT public.hx_r('i2','T_INS','ui2','B','INSERT','2026-09-19 10:05+00');      -- no receipt: refused as before
-- T_OK: baseline paid bounty MTT, 18+2
SELECT public.hx_t('T_OK','U','RUNNING','baseline',18,2,NULL,NULL,false);
SELECT public.hx_r('o1','T_OK','uo1','A','baseline','2026-09-16 05:00+00');
SELECT public.hx_l('lo1','T_OK','uo1',true,20,'tournament_buyin','A','2026-09-16 05:00+00');
SELECT public.hx_credit('co1','T_OK','uo1','A',public.hx_l('ko1','T_OK','uo1',false,5,'bounty','A','2026-09-18 03:00+00'),5,'2026-09-18 03:00+00');
SELECT public.hx_r('o2','T_OK','uo2','B','baseline','2026-09-16 05:01+00');
SELECT public.hx_l('lo2','T_OK','uo2',true,20,'tournament_buyin','B','2026-09-16 05:01+00');
SELECT public.hx_r('o3','T_OK','uo3','A','INSERT','2026-09-18 01:30+00');       -- normal path
SELECT public.hx_entry('ro3','o3','T_OK','uo3','A',20,public.hx_l('lo3','T_OK','uo3',true,20,'tournament_buyin','A','2026-09-18 01:30+00'),'2026-09-18 01:30+00');
SELECT public.hx_r('o4','T_OK','uo4','B','INSERT','2026-09-18 00:25+00');       -- before receipt capture
SELECT public.hx_l('lo4','T_OK','uo4',true,20,'tournament_buyin','B','2026-09-18 00:25+00');
-- T_FREE: baseline free-buy with 1-chip add-ons
SELECT public.hx_t('T_FREE','U','RUNNING','baseline',0,0,1,1,true);
SELECT public.hx_r('f1','T_FREE','uf1','A','baseline','2026-09-17 20:00+00');
SELECT public.hx_l('lf1','T_FREE','uf1',true,1,'addon','A','2026-09-17 20:10+00');
SELECT public.hx_r('f2','T_FREE','uf2','B','INSERT','2026-09-18 00:35+00');     -- receipt written before frames began
SELECT public.hx_entry('rf2','f2','T_FREE','uf2','B',0,NULL,'2026-09-18 00:35+00',false);
-- T_BAD: baseline paid, one provable and ten unprovable registrations
SELECT public.hx_t('T_BAD','U','RUNNING','baseline',18,2,NULL,5,false);
SELECT public.hx_r('b0','T_BAD','ub0','A','baseline','2026-09-16 06:00+00');
SELECT public.hx_l('lb0','T_BAD','ub0',true,20,'tournament_buyin','A','2026-09-16 06:00+00');
SELECT public.hx_r('b1','T_BAD','ub1','A','baseline','2026-09-16 06:01+00');   -- two buy-ins
SELECT public.hx_l('lb1a','T_BAD','ub1',true,20,'tournament_buyin','A','2026-09-16 06:01+00');
SELECT public.hx_l('lb1b','T_BAD','ub1',true,20,'tournament_buyin','A','2026-09-16 06:02+00');
SELECT public.hx_r('b2','T_BAD','ub2','A','baseline','2026-09-16 06:03+00');   -- off-schedule amount
SELECT public.hx_l('lb2','T_BAD','ub2',true,25,'tournament_buyin','A','2026-09-16 06:03+00');
SELECT public.hx_r('b3','T_BAD','ub3','A','baseline','2026-09-16 06:04+00');   -- no ledger entry at all
SELECT public.hx_r('b4','T_BAD','ub4','A','baseline','2026-09-16 06:05+00');   -- ticket admission
SELECT public.hx_l('lb4','T_BAD','ub4',true,20,'tournament_buyin','A','2026-09-16 06:05+00');
INSERT INTO public.tournament_ticket_admission_authorizations VALUES(public.u('tk4'),public.u('ticket4'),public.u('T_BAD'),public.u('ub4'),public.u('b4'),'2026-09-16 06:05+00');
SELECT public.hx_r('b5','T_BAD','ub5','A','baseline','2026-09-16 06:06+00');   -- two funding clubs
SELECT public.hx_l('lb5a','T_BAD','ub5',true,20,'tournament_buyin','A','2026-09-16 06:06+00');
SELECT public.hx_l('lb5b','T_BAD','ub5',true,5,'addon','B','2026-09-17 06:06+00');
SELECT public.hx_r('b6','T_BAD','ub6','A','baseline','2026-09-16 06:07+00');   -- post-capture add-on without its receipt
SELECT public.hx_l('lb6a','T_BAD','ub6',true,20,'tournament_buyin','A','2026-09-16 06:07+00');
SELECT public.hx_l('lb6b','T_BAD','ub6',true,5,'addon','A','2026-09-19 06:07+00');
SELECT public.hx_r('b7','T_BAD','ub7','A','baseline','2026-09-16 06:08+00');   -- return credited to another club
SELECT public.hx_l('lb7','T_BAD','ub7',true,20,'tournament_buyin','A','2026-09-16 06:08+00');
SELECT public.hx_credit('cb7','T_BAD','ub7','B',public.hx_l('kb7','T_BAD','ub7',false,5,'bounty','B','2026-09-18 04:00+00'),5,'2026-09-18 04:00+00');
SELECT public.hx_r('b8','T_BAD','ub8','A','baseline','2026-09-16 06:09+00');   -- ledger row not posted
SELECT public.hx_l('lb8','T_BAD','ub8',true,20,'tournament_buyin','A','2026-09-16 06:09+00','pending');
SELECT public.hx_r('b9','T_BAD','ub9','A','baseline','2026-09-16 06:10+00',true); -- satellite seat
SELECT public.hx_r('b10','T_BAD','ub10','A','baseline','2026-09-16 06:11+00');  -- post-capture return without its receipt
SELECT public.hx_l('lb10','T_BAD','ub10',true,20,'tournament_buyin','A','2026-09-16 06:11+00');
SELECT public.hx_l('kb10','T_BAD','ub10',false,5,'bounty','A','2026-09-18 05:00+00');
-- T_DONE: baseline but completed before the boundary: not in the population
SELECT public.hx_t('T_DONE','U','COMPLETED','baseline',18,2,NULL,NULL,false);
SELECT public.hx_r('d1','T_DONE','ud1','A','baseline','2026-09-16 05:00+00');
-- T_OTH: another Union's baseline tournament
SELECT public.hx_t('T_OTH','O','RUNNING','baseline',9,1,NULL,NULL,false);
SELECT public.hx_r('x1','T_OTH','ux1','A','baseline','2026-09-16 05:00+00');
SELECT public.hx_l('lx1','T_OTH','ux1',true,10,'tournament_buyin','A','2026-09-16 05:00+00');
SELECT public.hx_seal('2026-09-21 07:00+00');
