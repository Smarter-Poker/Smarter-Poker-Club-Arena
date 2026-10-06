-- 20261004123650_a_union_rake_treasury_leg_names_its_wallet.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A UNION RAKE TREASURY LEG NAMES ITS WALLET
--
-- What happened. At 06:40 UTC on 2026-10-04 the nightly ledger replay
-- (job 286, fn_ca_ledger_replay) read Midway Union's rake treasury
-- (union_wallet:fade0000-...-0001:union_wallets.rake_wallet) as having moved
-- -754,464.37 since its reading of 2026-10-01 06:47 while the journal it could
-- key accounted for +734,884.10, and tripped the kill switch at
-- -1,489,348.47 (UNCONFIRMED). Nothing was missing. Every chip of the
-- difference is in chip_ledger, on 590 legs whose from_label is NULL:
--
--   2026-10-01 22:43  union close f3470e1f (week 09-21): 2 club rakeback legs
--                     387,082.68 + the retained-share transfer 43,012.21
--   2026-10-02 06:11  owner legacy round 3: 582 player legs 117,192.35
--   2026-10-02 10:04  owner legacy round 1: 2 club legs 339,323.01
--   2026-10-03 10:25  overdue agent commission funding (one-off): 3 legs
--                     602,748.22
--   total 1,489,358.47, read under exactly the replay's two snapshots; the
--   union_wallet_transactions journal of the same window agrees to the cent.
--
-- The replay resolves a union_wallet leg to a balance column by its label, and
-- an unlabeled one only when its counterparty is a promo store; everything
-- else is 'unkeyable' and left out of every account. The three writers that
-- debit union_wallets.rake_wallet with a hand-written leg -
-- fn_union_weekly_rakeback_close (each club's rakeback),
-- fn_union_close_post_rake_debit (the retained share) and
-- fn_accounting_legacy_pay_week (rounds 1 and 3 when the union pays) - never
-- wrote a from_label. The account was first judged on 2026-09-26, so the close
-- of 2026-10-01 was the first one the replay ever saw; the week closing
-- 2026-10-05 would have tripped it again on its first reading after the close.
--
-- The fix is at the writer: each of those legs now names the column it debits,
-- 'union_wallets.rake_wallet'. Nothing else changes - same amounts, same
-- idempotency keys, same receipts, same locks. The legs already written are
-- immutable (hash chained) and their window is closed: the replay's next
-- reading starts from the 2026-10-04 06:41 snapshot.
--
-- @live-proof: position('''union_wallets.rake_wallet'') RETURNING id INTO v_ledger_id' in pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('''union_wallets.rake_wallet'') RETURNING id INTO v_ledger_id' in pg_get_functiondef('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure)) > 0
-- @live-proof: position('''union_wallets.rake_wallet'') RETURNING id INTO ledger_id' in pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- 1. Each club's weekly rakeback leg.
 s:='public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'6cb1cce06a2f553697e434d8004d64b8' THEN RAISE EXCEPTION 'close preimage %',md5(d); END IF;
 a:=$a$metadata,pre_to_balance,post_to_balance)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',$a$;
 r:=$r$metadata,pre_to_balance,post_to_balance,from_label)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'close anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$(v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO v_ledger_id;$a$;
 r:=$r$(v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric,'union_wallets.rake_wallet') RETURNING id INTO v_ledger_id;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'close anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'close postimage differs from the substituted text'; END IF;

 -- 2. The retained share, rake treasury -> general bank.
 s:='public.fn_union_close_post_rake_debit(jsonb)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'ecbe8d54d177c002b4bd9c76770ac11a' THEN RAISE EXCEPTION 'debit preimage %',md5(d); END IF;
 a:=$a$     amount, category, union_id, description, idempotency_key, metadata)
  VALUES
    (v_actor, 'union_wallet', u, 'union_bank', u,$a$;
 r:=$r$     amount, category, union_id, description, idempotency_key, metadata, from_label)
  VALUES
    (v_actor, 'union_wallet', u, 'union_bank', u,$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'debit anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$'clubs_paid', (p->>'clubs_paid')::int)) RETURNING id INTO v_ledger_id;$a$;
 r:=$r$'clubs_paid', (p->>'clubs_paid')::int), 'union_wallets.rake_wallet') RETURNING id INTO v_ledger_id;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'debit anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'debit postimage differs from the substituted text'; END IF;

 -- 3. The legacy cascade: round 1 (always the union) and round 3 (when the
 --    union pays). Its one union_wallets update debits rake_wallet.
 s:='public.fn_accounting_legacy_pay_week(uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'c2d44f4f6462a307228673452cf993dc' THEN RAISE EXCEPTION 'legacy preimage %',md5(d); END IF;
 a:=$a$metadata,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'club_treasury',$a$;
 r:=$r$metadata,pre_to_balance,post_to_balance,from_label)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'club_treasury',$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'legacy anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$(v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric) RETURNING id INTO ledger_id;$a$;
 r:=$r$(v_credit->>'balance_before')::numeric,(v_credit->>'balance_after')::numeric,'union_wallets.rake_wallet') RETURNING id INTO ledger_id;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'legacy anchor 2 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club'$a$;
 r:=$r$metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance,from_label)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club'$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'legacy anchor 3 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$'recorded_period_club_id',r.period_club_id),
    payer_before,payer_after,payee_before,payee_after) RETURNING id INTO ledger_id;$a$;
 r:=$r$'recorded_period_club_id',r.period_club_id),
    payer_before,payer_after,payee_before,payee_after,
    CASE r.payer_kind WHEN 'club' THEN NULL WHEN 'agent' THEN NULL ELSE 'union_wallets.rake_wallet' END) RETURNING id INTO ledger_id;$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'legacy anchor 4 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'legacy postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
