-- 20261003024413_the_books_close.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE BOOKS CLOSE (phase 4 of 9). Read from production on 2026-10-03; the
-- full account is docs/changelog/2026-10-03-the-books-close.md. No chip moves,
-- nothing is backfilled, no job is added (CLAUDE.md 10.11, 10.12).
--
-- 1. fn_mark_scope_accounting_settled settled fn_accounting_week_clubs only,
--    which leaves out the union's own club row; the square-up opens a period
--    for it, so that period stayed 'processing' for ever. It now settles every
--    period the week opened, and is called once for the week of 2026-09-21.
-- 2. fn_union_age_invoices reminded through fn_union_send_club_message, which
--    seats club admins in a group that is now an accounting conversation, and
--    its audience guard refuses that. fn_union_remind_statement posts where the
--    statement was delivered and seats nobody.
-- 3. fn_union_law_selftest demanded that the retired record_rake delegate.
--    One that only refuses keeps the law; one that writes around
--    atomic_distribute_rake still breaks it.
--
-- Every edited function is pinned to its 2026-10-03 md5 and edited by literal
-- replacement of one block (the 20260909012510 pattern).
--
-- @live-proof: (SELECT to_regprocedure('public.fn_union_remind_statement(uuid,text,jsonb)') IS NOT NULL AND (SELECT status FROM public.settlement_periods WHERE id = '747205e9-ec0a-4474-979d-cd5710dac54a') IN ('settled','closed'))

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Pre-images
-- ---------------------------------------------------------------------------
DO $pins$
DECLARE
  v_expected CONSTANT jsonb := jsonb_build_object(
    'public.fn_union_law_selftest()', '78f67db74acb118fad17bfe8f29249a6',
    'public.fn_mark_scope_accounting_settled(text,uuid,timestamp with time zone,timestamp with time zone)', '8471e94814d37d3fb9359b711682e0b1',
    'public.fn_union_age_invoices(uuid)', 'ae5549f087f405e52638d8d41e13cf6f');
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(v_expected) LOOP
    IF md5(pg_get_functiondef(k::regprocedure)) IS DISTINCT FROM v_expected ->> k THEN
      RAISE EXCEPTION 'BOOKS_MOVED_UNDERNEATH: % is not the body read on 2026-10-03', k;
    END IF;
  END LOOP;
END
$pins$;

-- ---------------------------------------------------------------------------
-- 1. The week settles every period it opened
-- ---------------------------------------------------------------------------
DO $week$
DECLARE
  v_src text;
  v_new text;
  c_old CONSTANT text := ' IF u_id IS NOT NULL THEN clubs:=array_append(clubs,NULL::uuid); END IF;';
  c_new CONSTANT text :=
' -- EVERY PERIOD THE WEEK OPENED IS SETTLED WITH IT (2026-10-03). The square-up
 -- issuer opens a period for the union''s own club row (clubs.id = union id),
 -- which fn_accounting_week_clubs leaves out, so nothing ever settled it.
 IF u_id IS NOT NULL THEN
  SELECT clubs||COALESCE(array_agg(DISTINCT sp.club_id),ARRAY[]::uuid[]) INTO clubs
    FROM public.settlement_periods sp
   WHERE sp.union_id=u_id AND sp.start_at=p_from AND sp.end_at=p_to
     AND sp.club_id IS NOT NULL AND NOT (sp.club_id=ANY(clubs));
  clubs:=array_append(clubs,NULL::uuid);
 END IF;';
BEGIN
  v_src := pg_get_functiondef('public.fn_mark_scope_accounting_settled(text,uuid,timestamp with time zone,timestamp with time zone)'::regprocedure);
  IF (length(v_src) - length(replace(v_src, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'settled: the union-period line is not in the shape this migration expects';
  END IF;
  v_new := replace(v_src, c_old, c_new);
  IF position('EVERY PERIOD THE WEEK OPENED' in v_new) = 0 THEN
    RAISE EXCEPTION 'settled: the replacement did not take';
  END IF;
  EXECUTE v_new;
END
$week$;

-- ---------------------------------------------------------------------------
-- 2. A reminder goes where its statement went
-- ---------------------------------------------------------------------------
DO $mk$
BEGIN
  EXECUTE $src$
CREATE FUNCTION public.fn_union_remind_statement(p_invoice_id uuid, p_body text, p_metadata jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  inv public.settlement_invoices%ROWTYPE;
  r record;
  v_sent integer := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'service_role_required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_body), '') = '' THEN
    RAISE EXCEPTION 'a reminder must say something' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO inv FROM public.settlement_invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR inv.invoice_type IS DISTINCT FROM 'union_weekly_squareup' THEN
    RAISE EXCEPTION 'union_statement_reminder_scope' USING ERRCODE = '22023';
  END IF;

  -- A statement nobody received is delivered first: the reminder follows it.
  IF NOT EXISTS (SELECT 1 FROM public.accounting_invoice_deliveries d WHERE d.invoice_id = inv.id) THEN
    PERFORM public.fn_deliver_accounting_invoice(inv.id);
  END IF;

  -- Into each conversation the statement went to, as the sender who sent it.
  -- Nobody is seated anywhere: an accounting conversation's audience is
  -- fixed (trg accounting_conversation_audience).
  FOR r IN
    SELECT DISTINCT m.conversation_id, m.sender_id
      FROM public.accounting_invoice_deliveries d
      JOIN public.social_messages m ON m.id = d.message_id
     WHERE d.invoice_id = inv.id
     ORDER BY m.conversation_id
  LOOP
    INSERT INTO public.social_messages (conversation_id, sender_id, content, message_type, media_metadata)
    VALUES (r.conversation_id, r.sender_id, p_body, 'invoice',
            NULLIF(COALESCE(p_metadata, '{}'::jsonb), '{}'::jsonb));
    UPDATE public.social_conversations
       SET last_message_at = now(),
           last_message_preview = left(regexp_replace(p_body, E'\\s+', ' ', 'g'), 100),
           updated_at = now()
     WHERE id = r.conversation_id;
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('success', v_sent > 0, 'delivered', v_sent, 'invoice_id', inv.id);
END
$fn$;
$src$;
  REVOKE ALL ON FUNCTION public.fn_union_remind_statement(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_union_remind_statement(uuid, text, jsonb) TO service_role;
END
$mk$;

DO $age$
DECLARE
  v_src text;
  v_new text;
  c_call_old CONSTANT text :=
'      v_msg := fn_union_send_club_message(
        p_union_id, r.club_id, v_body,';
  c_call_new CONSTANT text :=
'      -- A REMINDER GOES WHERE ITS STATEMENT WENT (2026-10-03).
      v_msg := public.fn_union_remind_statement(
        r.id, v_body,';
  c_tail_old CONSTANT text :=
'                           ''reminder_level'', v_level_due),
        ''invoice'');';
  c_tail_new CONSTANT text :=
'                           ''reminder_level'', v_level_due));';
BEGIN
  v_src := pg_get_functiondef('public.fn_union_age_invoices(uuid)'::regprocedure);
  IF position(c_call_old in v_src) = 0 OR position(c_tail_old in v_src) = 0 THEN
    RAISE EXCEPTION 'age: the reminder call is not in the shape this migration expects';
  END IF;
  v_new := replace(replace(v_src, c_call_old, c_call_new), c_tail_old, c_tail_new);
  IF position('fn_union_send_club_message' in v_new) > 0
     OR position('public.fn_union_remind_statement(' in v_new) = 0 THEN
    RAISE EXCEPTION 'age: the replacement did not take';
  END IF;
  EXECUTE v_new;
END
$age$;

-- ---------------------------------------------------------------------------
-- 3. A retired recorder keeps the union law
-- ---------------------------------------------------------------------------
DO $law$
DECLARE
  v_src text;
  v_new text;
  c_old CONSTANT text :=
'  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname=''public'' AND p.proname=''record_rake''
                    AND p.prosrc LIKE ''%atomic_distribute_rake%'') THEN
    v_breaches := v_breaches || jsonb_build_object(''check'',''record_rake_delegation_missing'');';
  c_new CONSTANT text :=
'  -- A RETIRED RECORDER KEEPS THE LAW (2026-10-03). record_rake was retired by
  -- 20261002140203: it records nothing and answers record_rake_retired. The
  -- law is that no rake is recorded around atomic_distribute_rake, so a
  -- record_rake that delegates, or one that only refuses, keeps it, and one
  -- that writes without delegating still breaks it.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname=''public'' AND p.proname=''record_rake''
                AND p.prosrc NOT LIKE ''%atomic_distribute_rake%''
                AND NOT (p.prosrc LIKE ''%record_rake_retired%''
                         AND p.prosrc !~* ''\m(insert|update|delete|perform|execute|call)\M'')) THEN
    v_breaches := v_breaches || jsonb_build_object(''check'',''record_rake_delegation_missing'');';
BEGIN
  v_src := pg_get_functiondef('public.fn_union_law_selftest()'::regprocedure);
  IF (length(v_src) - length(replace(v_src, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'law: the record_rake block is not in the shape this migration expects';
  END IF;
  v_new := replace(v_src, c_old, c_new);
  IF position('A RETIRED RECORDER KEEPS THE LAW' in v_new) = 0
     OR position('atomic_distribute_rake_law_missing' in v_new) = 0
     OR position('fn_resolve_bbj_pool_law_missing' in v_new) = 0
     OR position('tournament_buyin_rake_not_club_scoped' in v_new) = 0
     OR position('required_cron_missing' in v_new) = 0 THEN
    RAISE EXCEPTION 'law: a check went missing in the edit';
  END IF;
  EXECUTE v_new;
  REVOKE ALL ON FUNCTION public.fn_union_law_selftest() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.fn_union_law_selftest() TO service_role, authenticated;
END
$law$;

-- ---------------------------------------------------------------------------
-- 4. The one week that ran under the old settler, closed by its own path
-- ---------------------------------------------------------------------------
DO $close$
BEGIN
  IF (SELECT status FROM public.settlement_periods
       WHERE id = '747205e9-ec0a-4474-979d-cd5710dac54a'
         AND club_id = 'fade0000-0000-0000-0000-000000000001'
         AND union_id = 'fade0000-0000-0000-0000-000000000001'
         AND start_at = '2026-09-21 07:00:00+00' AND end_at = '2026-09-28 07:00:00+00')
     IS DISTINCT FROM 'processing' THEN
    RAISE EXCEPTION 'close: the union''s own period for 2026-09-21 is no longer the one read on 2026-10-03';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.union_accounting_runs
                  WHERE scope_kind = 'union' AND scope_id = 'fade0000-0000-0000-0000-000000000001'
                    AND period_start = '2026-09-21 07:00:00+00' AND period_end = '2026-09-28 07:00:00+00'
                    AND status = 'complete') THEN
    RAISE EXCEPTION 'close: the week of 2026-09-21 is not complete; nothing to close';
  END IF;

  PERFORM public.fn_mark_scope_accounting_settled('union', 'fade0000-0000-0000-0000-000000000001',
    '2026-09-21 07:00:00+00', '2026-09-28 07:00:00+00');

  IF (SELECT status FROM public.settlement_periods WHERE id = '747205e9-ec0a-4474-979d-cd5710dac54a')
     IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'close: the period did not settle';
  END IF;
END
$close$;

COMMIT;
