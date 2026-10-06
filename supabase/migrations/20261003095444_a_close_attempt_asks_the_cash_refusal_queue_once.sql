-- 20261003095444_a_close_attempt_asks_the_cash_refusal_queue_once.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A CLOSE ATTEMPT ASKS THE CASH REFUSAL QUEUE ONCE
--
-- One union close attempt prepares its book twice: the scheduler
-- (fn_process_weekly_accounting_scope) calls fn_prepare_accounting_week, and
-- fn_union_settlement_cascade calls it again for the same (union, week).
-- Each preparation asks fn_cash_source_refusals_for_period, which reads every
-- 'blocked' accounting_cash_source_work row (35,994 measured 2026-10-03) and
-- its receipt. In the auto_explain log of the 2026-10-01 Midway close (job
-- 391) that query ran 95 s and then 98 s, in the same transaction, for the
-- same book. Measured again 2026-10-03 09:55Z at low traffic: 11.4 s cold.
--
-- WHAT CHANGES (fn_prepare_accounting_week; fn_weekly_accounting_attempt_begin
-- and fn_weekly_accounting_attempt_end; exact anchors on the 2026-10-03
-- preimages):
--   * Inside one union close attempt (app.accounting_close_memo = 'on', which
--     only fn_weekly_accounting_attempt_begin(true) sets, and which it and
--     fn_weekly_accounting_attempt_end clear), a 'ready' refusal answer for a
--     book is remembered in the transaction-local setting
--     app.accounting_cash_refusal_memo, and the cascade's preparation of the
--     same book reuses it. The reused value is exactly what the function
--     returns for an empty queue: {"status":"ready","count":0,"sources":[]}.
--   * A 'blocked' answer is never remembered; a standalone club attempt
--     (memo off), and every call outside an attempt, asks the queue as before.
--   * attempt_begin and attempt_end clear the new setting with the others, and
--     a rolled-back subtransaction forgets it with its settings.
-- Both preparations run under the book's week lock, which the attempt takes
-- in the first and holds to its end. A refusal row that turns 'blocked'
-- between the two checks (its writer, fn_process_cash_accounting_source,
-- does not take that lock) is seen by the next attempt's first check instead
-- of this attempt's second; the decision to answer the second check from the
-- first is the coordinator's (2026-10-03).
--
-- @live-proof: position('app.accounting_cash_refusal_memo' in pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
-- @live-proof: position('app.accounting_cash_refusal_memo' in pg_get_functiondef('public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure)) > 0
-- @live-proof: position('app.accounting_cash_refusal_memo' in pg_get_functiondef('public.fn_weekly_accounting_attempt_end()'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- prepare
 s:='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'7d3265c14419e519399d9273c940e299' THEN RAISE EXCEPTION 'prepare preimage %',md5(d); END IF;
 a:=$a$DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;
$a$;
 r:=$r$DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;refusal_key text;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'prepare anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$ source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
$a$;
 r:=$r$ -- ONE REFUSAL CHECK PER ATTEMPT (20261003): inside one union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin,
 -- cleared by it and by attempt_end) the cascade's preparation repeats the
 -- scheduler's, for the same book, under this same week lock, which the
 -- attempt has held since. A 'ready' answer of this attempt is reused there;
 -- anything else, and every call outside an attempt, asks the queue as before.
 refusal_key:=COALESCE(p_union_id,p_club_id)::text||'|'||p_from::text||'|'||p_to::text;
 IF current_setting('app.accounting_close_memo',true)='on'
  AND current_setting('app.accounting_cash_refusal_memo',true)=refusal_key THEN
  source_check:=jsonb_build_object('status','ready','count',0,'sources','[]'::jsonb);
 ELSE
  source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
  IF current_setting('app.accounting_close_memo',true)='on' AND source_check->>'status'='ready'
   AND source_check->'count'='0'::jsonb AND source_check->'sources'='[]'::jsonb THEN
   PERFORM set_config('app.accounting_cash_refusal_memo',refusal_key,true);
  END IF;
 END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'prepare anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'prepare postimage differs from the substituted text'; END IF;
 -- attempt_begin
 s:='public.fn_weekly_accounting_attempt_begin(boolean)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'130c004569f961aa6f312c4f2ed15961' THEN RAISE EXCEPTION 'attempt_begin preimage %',md5(d); END IF;
 a:=$a$ PERFORM set_config('app.union_pnl_evidence_memo','',true);
$a$;
 r:=$r$ PERFORM set_config('app.union_pnl_evidence_memo','',true);
 PERFORM set_config('app.accounting_cash_refusal_memo','',true);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'attempt_begin anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'attempt_begin postimage differs from the substituted text'; END IF;
 -- attempt_end
 s:='public.fn_weekly_accounting_attempt_end()'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'60f06cac8b45e49447155914600f7ca6' THEN RAISE EXCEPTION 'attempt_end preimage %',md5(d); END IF;
 a:=$a$ PERFORM set_config('app.union_pnl_evidence_memo','',true);
$a$;
 r:=$r$ PERFORM set_config('app.union_pnl_evidence_memo','',true);
 PERFORM set_config('app.accounting_cash_refusal_memo','',true);
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'attempt_end anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'attempt_end postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
