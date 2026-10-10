-- Owner October 10: deleted players are hidden and their cash returns to the main bank.
-- Authoritative profile status deleted, never player type or display name.
-- Exact locked board independently proven by one self-aborting production DO call:
-- 62 accounts, 8940782.63 cash, md5 d51aa23ba8af0e9143c38c86bfac3627; identical bank/ledger/receipt sums,
-- repeat zero and deferred constraints passed. Each affected account and its source
-- amounts are retained in the resolved financial_alerts.context.board; no seat changes.
-- Current lifecycle credit hooks already return subsequent credits atomically.
-- Lock the bank then NOWAIT each source wallet: busy activity aborts without a cycle.
-- Exact board/amount assertion aborts if activity changed this qualified input.
-- Version reserved by scripts/new-migration.mjs; this is a one-time settlement.
BEGIN;
SET LOCAL lock_timeout='4s';
SET LOCAL statement_timeout='25s';
DO $probe$
DECLARE c uuid; r record; board jsonb; expected numeric; bank_before numeric; bank_after numeric;
 moved numeric:=0; repeat_moved numeric:=0; journal numeric; receipts numeric; result jsonb;
BEGIN
 PERFORM set_config('lock_timeout','4s',true);
 PERFORM set_config('statement_timeout','25s',true);
 SELECT id INTO STRICT c FROM public.clubs WHERE slug='shark-club' AND asset='chips' AND lifecycle_status='active';
 PERFORM 1 FROM public.profiles p WHERE p.status='deleted' AND EXISTS(SELECT 1 FROM public.club_members m WHERE m.user_id=p.id AND m.club_id=c) ORDER BY p.id FOR SHARE;
 SELECT chip_treasury INTO bank_before FROM public.clubs WHERE id=c FOR UPDATE;
 PERFORM 1 FROM public.agents a JOIN public.profiles p ON p.id=a.user_id WHERE a.club_id=c AND p.status='deleted' ORDER BY a.user_id FOR UPDATE OF a NOWAIT;
 PERFORM 1 FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id WHERE m.club_id=c AND p.status='deleted' ORDER BY m.user_id FOR UPDATE OF m NOWAIT;
 SELECT jsonb_agg(jsonb_build_object('user',m.user_id,'player',coalesce(m.chip_balance,0),'held',coalesce(m.held_chips,0),'locked',coalesce(m.locked_chips,0),'agent',coalesce(a.agent_wallet_balance,0)) ORDER BY m.user_id),
 sum(greatest(coalesce(m.chip_balance,0)-coalesce(m.held_chips,0)-coalesce(m.locked_chips,0),0)+greatest(coalesce(a.agent_wallet_balance,0),0))
 INTO board,expected FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id LEFT JOIN public.agents a ON a.club_id=m.club_id AND a.user_id=m.user_id WHERE m.club_id=c AND p.status='deleted';
 IF md5(board::text)<>'d51aa23ba8af0e9143c38c86bfac3627' OR expected<>8940782.63 OR jsonb_array_length(board)<>62 THEN RAISE EXCEPTION 'DELETED_CUSTODY_BOARD_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_alerts WHERE source='deleted_cashier_custody_20261010' AND resolved) THEN RAISE EXCEPTION 'ALREADY_SETTLED'; END IF;
 FOR r IN SELECT m.user_id FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id WHERE m.club_id=c AND p.status='deleted' ORDER BY m.user_id LOOP
  result:=public.fn_ca_deleted_account_bank_return(c,r.user_id);
  IF result->>'success'<>'true' THEN RAISE EXCEPTION 'RETURN_REFUSED %',result; END IF;
  moved:=moved+coalesce((result->>'amount')::numeric,0);
  result:=public.fn_ca_deleted_account_bank_return(c,r.user_id);
  repeat_moved:=repeat_moved+coalesce((result->>'amount')::numeric,0);
 END LOOP;
 SELECT chip_treasury INTO bank_after FROM public.clubs WHERE id=c;
 SELECT coalesce(sum(l.amount),0) INTO journal FROM public.chip_transactions t JOIN public.chip_ledger l ON l.idempotency_key='deleted_account_bank_return:'||(t.metadata->>'op_id') WHERE t.created_at>=transaction_timestamp() AND t.xmin=txid_current()::text::xid AND t.club_id=c AND t.metadata->>'reason'='deleted_account' AND l.club_id=c AND l.category='club_bank_claim' AND l.to_type='club_treasury';
 SELECT coalesce(sum(amount),0) INTO receipts FROM public.chip_transactions WHERE created_at>=transaction_timestamp() AND xmin=txid_current()::text::xid AND club_id=c AND metadata->>'reason'='deleted_account';
 IF moved<>expected OR bank_after-bank_before<>expected OR journal<>expected OR receipts<>expected OR repeat_moved<>0 THEN
  RAISE EXCEPTION 'CONSERVATION_FAILED %,%,%,%,%,%',expected,moved,bank_after-bank_before,journal,receipts,repeat_moved;
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE xmin=txid_current()::text::xid AND user_id IN (SELECT m.user_id FROM public.club_members m JOIN public.profiles p ON p.id=m.user_id WHERE m.club_id=c AND p.status='deleted')) THEN RAISE EXCEPTION 'SEAT_CHANGED'; END IF;
 SET CONSTRAINTS ALL IMMEDIATE;
 INSERT INTO public.financial_alerts(severity,source,message,context,resolved,resolved_at,resolution)
 VALUES('warning','deleted_cashier_custody_20261010','Legacy Deleted Shark Club Wallet Custody Returned To Main Bank', jsonb_build_object('club',c,'members',jsonb_array_length(board),'board_md5',md5(board::text),'amount',moved,'bank_before',bank_before,'bank_after',bank_after,'journal',journal,'receipts',receipts,'repeat_amount',repeat_moved,'board',board),true,now(),'Owner October 10 Instruction: Return Deleted Account Free Cash To Main Bank. Source Ledger Writers And Bank Receipts Preserve Conservation. Held And Locked Chips, Seats, Game Stacks, Promo, Tickets And Diamonds Remain Untouched. Authoritative Profile Status Defines Deletion. Repeat Return Amount Is Zero.');
END $probe$;

COMMIT;
