-- FIFO5 preventive retention only. SOURCE CANDIDATE / UNRUN / UNINSTALLED.
-- No schedule, historical repair, financial mutation, new function or table.
-- Apply only through the existing owner-controlled DDL serialization boundary:
-- read/replace/read does not prevent another owner concurrently replacing DDL.
-- Forward/rollback are exact-body guarded and replay their own complete image.
-- Rollback restores eligibility; it cannot reconstruct deleted history.
DO $spin_history_retention$
DECLARE
  v_rollback constant boolean := false;
  v_oid oid := to_regprocedure('public.sp_prune_hand_history(integer)');
  v_pre constant text := $preimage$CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_budget constant interval := interval '20 seconds';
  v_deadline timestamptz := clock_timestamp()+v_budget;
  v_days integer;
  v_window interval;
  v_doomed uuid[];
  v_keepers uuid[];
  v_deleted integer := 0;
  v_round integer;
BEGIN
  SELECT greatest(coalesce(horse_retention_days,7),1)
    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;
  IF v_days IS NULL THEN v_days := 7; END IF;
  v_window := make_interval(days=>v_days);

  LOOP
    v_doomed := NULL;
    v_keepers := NULL;
    WITH candidates AS (
      SELECT hh.id,hh.players
        FROM public.hand_history hh
       WHERE hh.has_human IS DISTINCT FROM true
         AND hh.reported IS NOT true
         AND hh.created_at<now()-v_window
         AND NOT EXISTS (
           SELECT 1 FROM public.bbj_payouts bp
            WHERE bp.table_id=hh.table_id AND bp.hand_number=hh.hand_number)
         AND NOT EXISTS (
           SELECT 1 FROM public.hand_projection_outbox o WHERE o.hand_id=hh.id)
         AND NOT EXISTS (
           SELECT 1 FROM public.tournament_knockout_candidates c
            WHERE c.hand_id=hh.id AND c.state='pending')
       ORDER BY hh.created_at
       LIMIT p_batch
       FOR UPDATE SKIP LOCKED
    ), classified AS (
      SELECT c.id,
        CASE
          WHEN jsonb_typeof(c.players) IS DISTINCT FROM 'array' THEN true
          WHEN jsonb_array_length(c.players)=0 THEN true
          ELSE EXISTS (
            SELECT 1
              FROM jsonb_array_elements(c.players) e
              LEFT JOIN public.profiles p ON p.id=(CASE
                WHEN length(e.value->>'userId')=36
                 AND (e.value->>'userId') ~
                   '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN (e.value->>'userId')::uuid END)
             WHERE p.id IS NULL OR p.is_horse IS NOT true)
        END AS is_human
        FROM candidates c
    )
    SELECT array_agg(id) FILTER (WHERE is_human IS false),
           array_agg(id) FILTER (WHERE is_human IS DISTINCT FROM false)
      INTO v_doomed,v_keepers FROM classified;

    EXIT WHEN v_doomed IS NULL AND v_keepers IS NULL;
    IF v_keepers IS NOT NULL AND cardinality(v_keepers)>0 THEN
      UPDATE public.hand_history SET has_human=true WHERE id=ANY(v_keepers);
    END IF;
    IF v_doomed IS NOT NULL AND cardinality(v_doomed)>0 THEN
      DELETE FROM public.rake_attributions WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.ca_hand_player_idx WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_atomic_commits WHERE hand_id=ANY(v_doomed);
      DELETE FROM public.hand_history WHERE id=ANY(v_doomed);
      GET DIAGNOSTICS v_round=ROW_COUNT;
      v_deleted := v_deleted+v_round;
    END IF;
    EXIT WHEN clock_timestamp()>=v_deadline;
  END LOOP;
  RETURN v_deleted;
END;
$function$
$preimage$;
  v_post constant text := replace(v_pre, $needle$       ORDER BY hh.created_at
$needle$, $replacement$         -- Missing/blank classification or conflicting ownership stays retained.
         -- A known Spin's history remains evidence until canonical terminal
         -- state commits; do not require a first legacy receipt to exist.
         AND EXISTS (
           SELECT 1 FROM public.tables tb
           LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
            WHERE tb.id=hh.table_id
              AND (hh.tournament_id IS NULL
                   OR hh.tournament_id=tb.tournament_id)
              AND (
                (hh.tournament_id IS NULL AND tb.tournament_id IS NULL)
                OR (
                  t.id IS NOT NULL
                  AND NULLIF(btrim(t.variant::text),'') IS NOT NULL
                  AND NULLIF(btrim(t.tournament_type::text),'') IS NOT NULL
                  AND (
                    (lower(t.variant::text)<>'spin'
                     AND upper(t.tournament_type::text)<>'SPIN')
                    OR (upper(COALESCE(t.status::text,''))='COMPLETED'
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_terminal_settlements terminal
                           WHERE terminal.tournament_id=t.id))
                    OR (upper(COALESCE(t.status::text,'')) IN ('CANCELLED','CANCELED')
                        AND EXISTS (
                          SELECT 1 FROM public.tournament_cancellation_receipts cancellation
                           WHERE cancellation.tournament_id=t.id))
                  )
                )
              )
         )
       ORDER BY hh.created_at
$replacement$);
  v_target text;
  v_actual text;
  v_before jsonb;
  v_after jsonb;
  v_relation text;
  v_column record;
  v_trigger record;
  v_pass integer;
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR v_oid IS NULL
     OR md5(v_pre) IS DISTINCT FROM '03f156a50f882354f7d09f30fe08afd2'
     OR md5(v_post) IS DISTINCT FROM '8a5858c8586296d772add9e233abc269'
     OR array_length(string_to_array(v_pre, $needle$       ORDER BY hh.created_at
$needle$),1) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'spin history retention: owner, version or exact source missing'
      USING ERRCODE='55000';
  END IF;
  v_actual := pg_get_functiondef(v_oid);
  IF v_actual IS DISTINCT FROM v_pre AND v_actual IS DISTINCT FROM v_post THEN
    RAISE EXCEPTION 'spin history retention: unsupported function drift' USING ERRCODE='55000';
  END IF;
  -- Full function text pins argument/default/return/language/body/attributes/config.
  -- Owner and raw ACL are separately pinned because pg_get_functiondef omits them.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid
      AND pg_get_userbyid(p.proowner)='postgres'
      AND p.proacl::text='{postgres=X/postgres}'
      AND NOT p.prosecdef
      AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]) THEN
    RAISE EXCEPTION 'spin history retention: target authority drift' USING ERRCODE='55000';
  END IF;
  SELECT to_jsonb(p)-'prosrc' INTO v_before FROM pg_proc p WHERE p.oid=v_oid;
  v_target := CASE WHEN v_rollback THEN v_pre ELSE v_post END;
  FOR v_pass IN 1..2 LOOP
    -- These four are the new ownership/evidence reads. Keep exact real table
    -- kinds/owners; do not accept a view or replacement fake evidence provider.
    FOREACH v_relation IN ARRAY ARRAY['tables','tournaments',
      'tournament_terminal_settlements','tournament_cancellation_receipts'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_class c
          WHERE c.oid=to_regclass('public.'||v_relation)
            AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres') THEN
        RAISE EXCEPTION 'spin history retention: dependency relation drift %',v_relation
          USING ERRCODE='55000';
      END IF;
    END LOOP;
    FOR v_column IN SELECT * FROM (VALUES
        ('tables','id','uuid'),('tables','tournament_id','uuid'),
        ('tournaments','id','uuid'),('tournaments','variant','text'),
        ('tournaments','tournament_type','text'),('tournaments','status','text'),
        ('tournament_terminal_settlements','tournament_id','uuid'),
        ('tournament_cancellation_receipts','tournament_id','uuid')
      ) AS required(relation_name,column_name,type_name) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute a
          WHERE a.attrelid=to_regclass('public.'||v_column.relation_name)
            AND a.attname=v_column.column_name AND a.attnum>0 AND NOT a.attisdropped
            AND a.atttypid=to_regtype(v_column.type_name)
            AND a.attgenerated='' AND a.attidentity='') THEN
        RAISE EXCEPTION 'spin history retention: dependency column drift %.%',
          v_column.relation_name,v_column.column_name USING ERRCODE='55000';
      END IF;
    END LOOP;
    -- Closure evidence is private and append-only, not an ordinary service JSON
    -- assertion. No receipt is inserted or invoked by this component.
    FOREACH v_relation IN ARRAY ARRAY['tournament_terminal_settlements',
      'tournament_cancellation_receipts'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_class c
          WHERE c.oid=to_regclass('public.'||v_relation)
            AND c.relrowsecurity AND NOT c.relforcerowsecurity
            AND c.relacl::text='{postgres=arwdDxtm/postgres}')
         OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('public.'||v_relation))
         OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||v_relation)
           AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL)
         OR NOT EXISTS (SELECT 1 FROM pg_constraint c
            WHERE c.conrelid=to_regclass('public.'||v_relation) AND c.contype='p'
              AND c.convalidated AND NOT c.condeferrable
              AND c.conkey=ARRAY[(SELECT a.attnum FROM pg_attribute a
                WHERE a.attrelid=c.conrelid AND a.attname='tournament_id')]::smallint[]) THEN
        RAISE EXCEPTION 'spin history retention: receipt authority/identity drift %',v_relation
          USING ERRCODE='55000';
      END IF;
    END LOOP;
    FOR v_trigger IN SELECT * FROM (VALUES
       ('tournament_terminal_settlements','tournament_terminal_settlements_append_only',
        'public.fn_tournament_terminal_receipts_are_append_only()',
        '618843a6d0646709dac2a9c3b24a7652','{postgres=X/postgres}'),
       ('tournament_cancellation_receipts','tournament_cancellation_receipts_append_only',
        'public.fn_tournament_cancellation_receipts_append_only()',
        'fae27fa0a4d44ff04516e0bf069f6f9c','{postgres=X/postgres}')
       ) AS pinned(relation_name,trigger_name,signature,full_definition_md5,acl) LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgrelid=to_regclass('public.'||v_trigger.relation_name)
            AND t.tgname=v_trigger.trigger_name AND NOT t.tgisinternal
            AND t.tgenabled='O' AND t.tgtype=27
            AND NOT t.tgdeferrable AND NOT t.tginitdeferred
            AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgattr=''::int2vector
            AND t.tgfoid=to_regprocedure(v_trigger.signature)
            AND pg_get_userbyid(p.proowner)='postgres'
            AND p.proacl::text=v_trigger.acl
            AND md5(pg_get_functiondef(p.oid))=v_trigger.full_definition_md5) THEN
        RAISE EXCEPTION 'spin history retention: receipt immutability binding drift %',
          v_trigger.trigger_name USING ERRCODE='55000';
      END IF;
    END LOOP;
    IF v_pass=1 AND v_actual IS DISTINCT FROM v_target THEN EXECUTE v_target; END IF;
    IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_target THEN
      RAISE EXCEPTION 'spin history retention: target readback failed' USING ERRCODE='55000';
    END IF;
    SELECT to_jsonb(p)-'prosrc' INTO v_after FROM pg_proc p WHERE p.oid=v_oid;
    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'spin history retention: authority or other function metadata changed'
        USING ERRCODE='55000';
    END IF;
  END LOOP;
END;
$spin_history_retention$;
