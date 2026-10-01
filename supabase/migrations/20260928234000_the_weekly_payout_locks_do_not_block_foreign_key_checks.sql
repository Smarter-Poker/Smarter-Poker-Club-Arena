-- THE WEEKLY PAYOUT LOCKS DO NOT BLOCK FOREIGN-KEY CHECKS (2026-09-28).
--
-- Rounds 2 and 3 of the weekly close pre-lock the payer clubs rows and the
-- payee club_members rows with FOR UPDATE. FOR UPDATE also conflicts with
-- FOR KEY SHARE, the lock every foreign-key check takes on the referenced
-- row. A live horse tournament seating (fn_seat_horse_in_seat_first_game)
-- debits the horse's club_members row and then inserts a
-- tournament_refund_entitlements row whose FK check needs KEY SHARE on the
-- clubs row the close holds FOR UPDATE; the close then wants that member row:
-- deadlock (Deep Stack Society's close, 2026-09-28 23:39:51, postgres log
-- "while locking tuple (47,18) in relation club_members" vs "(282,3) in
-- relation clubs").
--
-- The pre-locks only guard balance columns; no key of clubs or club_members
-- ever changes here, and every balance writer takes FOR NO KEY UPDATE (plain
-- UPDATE does). FOR NO KEY UPDATE therefore serializes exactly the same
-- writers while letting foreign-key checks through. Nothing else changes.
--
-- @live-proof: (SELECT bool_and(pg_get_functiondef(s::regprocedure) !~ '(ORDER BY c\.id|ORDER BY id|cm\.user_id) FOR UPDATE' AND position('FOR NO KEY UPDATE' in pg_get_functiondef(s::regprocedure)) > 0) FROM unnest(ARRAY['public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)','public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)','public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)']) s)
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
DECLARE f record; source text; n int; k int; pair text[];
BEGIN
 FOR f IN SELECT * FROM (VALUES
   ('public.fn_settle_accounting_commission_stage(text,uuid,timestamp with time zone,timestamp with time zone)','ec2dd57271b8061b8ac9f7e7b531d964',
    ARRAY['ORDER BY c.id FOR UPDATE;','ORDER BY c.id FOR NO KEY UPDATE;','ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;','ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;'],ARRAY[1,1]),
   ('public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamp with time zone,timestamp with time zone)','9a7515813a8f48c4430c6ca60378f941',
    ARRAY['ORDER BY c.id FOR UPDATE;','ORDER BY c.id FOR NO KEY UPDATE;','ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;','ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;'],ARRAY[1,1]),
   ('public.fn_settle_accounting_rakeback_stage(text,uuid,timestamp with time zone,timestamp with time zone)','292225abed2d6783c0f3ee0009a05fa3',
    ARRAY['WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR UPDATE;','WHERE id IN(SELECT club_id FROM pg_temp._routed_player_items) ORDER BY id FOR NO KEY UPDATE;','ORDER BY cm.club_id,cm.user_id FOR UPDATE OF cm;','ORDER BY cm.club_id,cm.user_id FOR NO KEY UPDATE OF cm;'],NULL)
 ) v(sig,pre,reps,counts) LOOP
  source:=pg_get_functiondef(f.sig::regprocedure);
  IF md5(source) IS DISTINCT FROM f.pre THEN RAISE EXCEPTION 'preimage mismatch: %',f.sig; END IF;
  FOR k IN 0..1 LOOP
   n:=(length(source)-length(replace(source,f.reps[k*2+1],'')))/length(f.reps[k*2+1]);
   IF n<1 OR (f.counts IS NOT NULL AND n<>f.counts[k+1]) THEN
    RAISE EXCEPTION 'lock text changed in % (% occurrences of %)',f.sig,n,f.reps[k*2+1]; END IF;
   source:=replace(source,f.reps[k*2+1],f.reps[k*2+2]);
  END LOOP;
  EXECUTE source;
 END LOOP;
END $patch$;

REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;

DO $post$
DECLARE s text;
BEGIN
 FOREACH s IN ARRAY ARRAY['public.fn_settle_accounting_commission_stage(text,uuid,timestamptz,timestamptz)',
   'public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz)',
   'public.fn_settle_accounting_rakeback_stage(text,uuid,timestamptz,timestamptz)'] LOOP
  IF pg_get_functiondef(s::regprocedure) ~ '(ORDER BY c\.id|ORDER BY id|cm\.user_id) FOR UPDATE' THEN
   RAISE EXCEPTION 'postimage: % still takes FOR UPDATE on clubs or club_members',s; END IF;
 END LOOP;
END $post$;
COMMIT;
