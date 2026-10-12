-- 20261003183034_the_weekly_close_seals_its_inventory_six_hours_at_a_time.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE WEEKLY CLOSE SEALS ITS INVENTORY SIX HOURS AT A TIME
--
-- 20261003180832 added fn_union_pnl_inventory_seal_advance, which seals a
-- closed week's original inventory in six-hour layers and assembles exactly
-- the checkpoint the one-transaction seal writes. Proved on the sealed week of
-- 2026-09-28 (base 2026-09-21): 28 layers in three calls of at most 145 s
-- (largest layer 41.6 s, all layers 356 s), assembled in 14.7 s into 478,197
-- rows and 0 issues with rows_md5 969158f5ab29272a49114d497bb4892f,
-- issues_md5 d41d8cd98f00b204e9800998ecf8427e and max_event_id 14440852 -
-- the sealed checkpoint's own values. The week closing 2026-10-05 has ~2.2x
-- those events: ~90 s for its largest layer.
--
-- WHAT CHANGES:
--  1. fn_union_pnl_inventory_checkpoint_due, inside a chunked close tick (job
--     272), seals a missing boundary with fn_union_pnl_inventory_seal_advance
--     and returns status 'sealing' while layers remain; outside one it seals
--     in one go as before.
--  2. fn_process_weekly_accounting_scope ends a tick whose seal is still
--     'sealing' before any scope (every scope's P&L reads the checkpoint).
--  3. fn_union_pnl_inventory_seal_advance starts no layer 90 s after the call
--     began (was 120 s): at the projected ~90 s a layer, a call stays under
--     ~3 minutes.
--  4. fn_accounting_close_seal_held answers false: 20261003155132 held the
--     gated week's seal with its close only because the seal was one long
--     transaction. The gate still holds the week's first close attempt, and
--     the seal now runs in calls of a few minutes from the first 40-minute
--     tick after the week ends.
--  5. Job 272 calls the close on every 5-minute tick while a split seal is in
--     progress (fn_union_pnl_inventory_seal_in_progress: layers staged for
--     the current week's boundary and no checkpoint yet), not only at :40,
--     so a seal of ~7 calls takes ~35 minutes, not ~7 hours.
--  6. The tick that completes a seal visits no scope either: it ran under the
--     large seal budget, and the next :40 tick visits the scopes with the
--     ordinary one.
--
-- @live-proof: position('fn_union_pnl_inventory_seal_advance' in pg_get_functiondef('public.fn_union_pnl_inventory_checkpoint_due()'::regprocedure)) > 0
-- @live-proof: position('''inventory_seal'',v_seal' in pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)) > 0
-- @live-proof: NOT public.fn_accounting_close_seal_held('2026-10-05 07:00:00+00')
-- @live-proof: (SELECT position('fn_union_pnl_inventory_seal_in_progress' in command)>0 FROM cron.job WHERE jobname='union-weekly-rakeback-close')
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- checkpoint due
 s:='public.fn_union_pnl_inventory_checkpoint_due()'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'5f7ed8154e218b7cd17b3402f6989bca' THEN RAISE EXCEPTION 'checkpoint due preimage %',md5(d); END IF;
 a:=$a$DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; b timestamptz; v_sealed jsonb:='[]';
$a$;
 r:=$r$DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; b timestamptz; v_sealed jsonb:='[]'; v_step jsonb;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'checkpoint due anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$   v_sealed:=v_sealed||jsonb_build_array(public.fn_union_pnl_inventory_checkpoint_seal(b,false));
$a$;
 r:=$r$   -- SPLIT SEAL (20261003): inside a chunked close tick, six hours at a time
   -- (fn_union_pnl_inventory_seal_advance); 'sealing' while layers remain.
   IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
    v_step:=public.fn_union_pnl_inventory_seal_advance(b,false);
    IF v_step->>'status'='sealing' THEN
     RETURN jsonb_build_object('status','sealing','boundary',b,'progress',v_step,'sealed',v_sealed);
    END IF;
    v_sealed:=v_sealed||jsonb_build_array(v_step);
   ELSE
   v_sealed:=v_sealed||jsonb_build_array(public.fn_union_pnl_inventory_checkpoint_seal(b,false));
   END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'checkpoint due anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'checkpoint due postimage differs from the substituted text'; END IF;
 -- scheduler
 s:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'a55a0e4c2aa8f2c9d810af063a6060ec' THEN RAISE EXCEPTION 'scheduler preimage %',md5(d); END IF;
 a:=$a$  v_now timestamptz := clock_timestamp();
$a$;
 r:=$r$  v_now timestamptz := clock_timestamp();
  v_seal jsonb;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 1 count'; END IF;
 d:=replace(d,a,r);
 a:=$a$        PERFORM public.fn_union_pnl_inventory_checkpoint_due();
$a$;
 r:=$r$        -- SPLIT SEAL (20261003): while the week's seal is still computed six
        -- hours at a time, this tick visits no scope (their P&L reads it);
        -- nor does the tick that sealed, which ran under the large budget.
        v_seal:=public.fn_union_pnl_inventory_checkpoint_due();
        IF v_seal->>'status'='sealing' OR jsonb_array_length(COALESCE(v_seal->'sealed','[]'::jsonb))>0 THEN
          RETURN jsonb_build_object('success',true,'checked',0,'failed',0,'visited_scopes',0,'more_remaining',true,
            'observed_at',clock_timestamp(),'detail','[]'::jsonb,'inventory_seal',v_seal);
        END IF;
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'scheduler anchor 2 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'scheduler postimage differs from the substituted text'; END IF;
 -- seal advance
 s:='public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'91f022b937ebd5c2175db82ece254198' THEN RAISE EXCEPTION 'seal advance preimage %',md5(d); END IF;
 a:=$a$  IF done_any AND clock_timestamp()>began+interval '120 seconds' THEN
$a$;
 r:=$r$  IF done_any AND clock_timestamp()>began+interval '90 seconds' THEN
$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'seal advance anchor 1 count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'seal advance postimage differs from the substituted text'; END IF;
 -- seal held
 IF md5(pg_get_functiondef('public.fn_accounting_close_seal_held(timestamptz)'::regprocedure))<>'8aeb8ce5fc5ac655b788b822a0d2a36d' THEN
  RAISE EXCEPTION 'seal held preimage'; END IF;
END
$mig$;

CREATE FUNCTION public.fn_union_pnl_inventory_seal_in_progress()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
 -- A split seal of the current week's boundary has started and not finished.
 SELECT EXISTS(SELECT 1 FROM public.union_pnl_inventory_seal_layers l WHERE l.boundary=public.fn_union_week_start(now()))
   AND NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=public.fn_union_week_start(now()))
$f$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_in_progress() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fn_union_pnl_inventory_seal_in_progress() IS
  'Split inventory seal (20261003): true while six-hour layers are staged for the current week''s boundary and its checkpoint is not sealed yet; job 272 then calls the close on every tick.';

DO $job$
DECLARE j bigint; c text; a text:='OR public.fn_accounting_close_gate_lifted_unstarted() THEN';
BEGIN
 SELECT jobid,command INTO j,c FROM cron.job WHERE jobname='union-weekly-rakeback-close';
 IF NOT FOUND THEN RAISE EXCEPTION 'job 272 missing' USING ERRCODE='55000'; END IF;
 IF md5(c)<>'44f3e5a5345938b92158e569d8f0fd70' THEN RAISE EXCEPTION 'job 272 command preimage %',md5(c) USING ERRCODE='55000'; END IF;
 IF (length(c)-length(replace(c,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'job 272 anchor count'; END IF;
 c:=replace(c,a,'OR public.fn_accounting_close_gate_lifted_unstarted() OR public.fn_union_pnl_inventory_seal_in_progress() THEN');
 PERFORM cron.alter_job(j, schedule:='*/5 * * * *', command:=c, active:=true);
 IF (SELECT command FROM cron.job WHERE jobid=j)<>c THEN RAISE EXCEPTION 'job 272 postimage differs'; END IF;
END
$job$;

CREATE OR REPLACE FUNCTION public.fn_accounting_close_seal_held(p_boundary timestamptz)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public'
AS $f$
 -- The seal runs six hours at a time inside the close (20261003183034); no
 -- gate holds it any more. The gate still holds a week's first close attempt.
 SELECT false
$f$;
COMMENT ON FUNCTION public.fn_union_pnl_inventory_seal_advance(timestamptz,boolean) IS
  'Split inventory seal (20261003): computes a closed week''s six-hour inventory layers (at least one per call, none started 90 s after the call began), then seals the week exactly as fn_union_pnl_inventory_checkpoint_seal; with verify, compares the assembled week with an already sealed checkpoint instead.';
COMMENT ON FUNCTION public.fn_accounting_close_seal_held(timestamptz) IS
  'Weekly close gate (20261003): false - the inventory seal runs six hours at a time inside the close and is no longer held with a gated week.';

COMMIT;
