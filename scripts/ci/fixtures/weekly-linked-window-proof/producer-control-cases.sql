BEGIN;
-- Isolated control-flow qualification of the EXACT rendered producer block.
-- Window/witness/reader fixture functions replace external admission/business;
-- this does not qualify original canonical-reader semantics or production capacity.
CREATE TABLE public.test_windows(window_start timestamptz,window_end timestamptz,links bigint);
CREATE TABLE public.reader_calls(window_start timestamptz);
CREATE TABLE public.accounting_close_partials(kind text,union_id uuid,period_start timestamptz,period_end timestamptz,window_start timestamptz,window_end timestamptz,value jsonb,cash_ids uuid[],cash_md5 bytea,fee_ids uuid[],fee_md5 bytea,computed_at timestamptz,PRIMARY KEY(kind,union_id,period_start,period_end,window_start));
CREATE SCHEMA smarter_private;
CREATE FUNCTION public.fn_accounting_close_windows(timestamptz,timestamptz)RETURNS TABLE(window_start timestamptz,window_end timestamptz)LANGUAGE sql AS $$SELECT window_start,window_end FROM public.test_windows$$;
CREATE FUNCTION public.fn_accounting_close_proof_lifetime()RETURNS interval LANGUAGE sql AS $$SELECT interval '72h'$$;
CREATE FUNCTION smarter_private.weekly_hand_parts_witness(uuid,timestamptz,timestamptz,boolean)RETURNS jsonb LANGUAGE sql STABLE AS $$SELECT jsonb_build_object('links',links,'ordinary_count',0,'escrow_certificates',0)FROM public.test_windows WHERE window_start=$2 AND window_end=$3$$;
CREATE FUNCTION public.fn_union_pnl_linked_cash_outcomes(uuid,timestamptz,timestamptz)RETURNS TABLE(evidence jsonb)LANGUAGE plpgsql AS $$BEGIN INSERT INTO public.reader_calls VALUES($2);RETURN QUERY SELECT '{"status":"ready","basis_certified":true,"all_players_included":true}'::jsonb FROM generate_series(1,(SELECT links::int FROM public.test_windows WHERE window_start=$2));END;$$;
CREATE FUNCTION pg_temp.produce(expired boolean DEFAULT false)RETURNS boolean LANGUAGE plpgsql AS $producer$
DECLARE w record;proved boolean:=false;v_generation text:='GEN';v_hand_projected boolean:=true;stop_at timestamptz:=CASE WHEN expired THEN clock_timestamp()-interval '1s'ELSE clock_timestamp()+interval '120s'END;p_union_id uuid:='fade0000-0000-0000-0000-000000000001';p_start timestamptz:='2026-10-19 07:00Z';p_end timestamptz:='2026-10-26 07:00Z';v_l_value jsonb;v_l_key jsonb;v_l_witness jsonb;v_l_counts jsonb;v_l_valid boolean;v_l_name text;v_l_number numeric;v_l_cached record;
BEGIN


 -- ORIGINAL CANONICAL LINKED WINDOWS. New proof kind; no existing hand JSON ABI
 -- changes. An attempt that proves any linked unit ends warming before later work.
 IF v_generation IS NOT NULL AND v_generation<>'original-inventory-245:unqualified'THEN
  FOR w IN SELECT * FROM public.fn_accounting_close_windows(p_start,p_end)ORDER BY 1 LOOP
   v_l_witness:=smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected);
   v_l_key:=jsonb_build_object('union_id',p_union_id::text,'period_start_epoch',extract(epoch FROM p_start),'period_end_epoch',extract(epoch FROM p_end),'window_start_epoch',extract(epoch FROM w.window_start),'window_end_epoch',extract(epoch FROM w.window_end));v_l_valid:=false;
   SELECT p.*INTO v_l_cached FROM public.accounting_close_partials p WHERE p.kind='pnl_linked_window'
    AND p.union_id=p_union_id AND p.period_start=p_start AND p.period_end=p_end AND p.window_start=w.window_start;
   IF FOUND AND v_l_cached.window_end=w.window_end AND isfinite(v_l_cached.computed_at)
    AND v_l_cached.computed_at>=p_end AND v_l_cached.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime()
    AND v_l_cached.computed_at<=clock_timestamp()AND v_l_cached.cash_ids IS NULL AND v_l_cached.cash_md5 IS NULL
    AND v_l_cached.fee_ids IS NULL AND v_l_cached.fee_md5 IS NULL THEN
    v_l_value:=v_l_cached.value;

 v_l_valid:=false;
 IF jsonb_typeof(v_l_value)='object'
 AND v_l_value->>'contract'='canonical-linked-validation-v1'
 AND v_l_value->>'generation'=v_generation
 AND v_l_value->'projected'=to_jsonb(v_hand_projected)
 AND v_l_value->>'reader_md5'='0c3a826553e9ef65a03030c3ef78eaaf'
 AND v_l_value->>'witness_md5'='a3b1c75ad2b122dc0b0fede8a66813c8'
 AND v_l_value->'input_key'=v_l_key
 AND v_l_value->'witness'=v_l_witness
 AND v_l_value->>'proof_md5'=md5((v_l_value-'proof_md5')::text)
 AND jsonb_typeof(v_l_value->'counts')='object' THEN
  v_l_counts:=v_l_value->'counts';v_l_valid:=true;
  IF(SELECT array_agg(key ORDER BY key)FROM jsonb_object_keys(v_l_counts)key)
    IS DISTINCT FROM ARRAY['bad','resolved','rows','unknown']THEN v_l_valid:=false;END IF;
  IF v_l_valid THEN
   FOREACH v_l_name IN ARRAY ARRAY['rows','bad','resolved','unknown']LOOP
    IF jsonb_typeof(v_l_counts->v_l_name)IS DISTINCT FROM'number'
     OR(v_l_counts->>v_l_name)!~'^[0-9]{1,19}$'THEN v_l_valid:=false;EXIT;END IF;
    v_l_number:=(v_l_counts->>v_l_name)::numeric;
    IF v_l_number>9223372036854775807 THEN v_l_valid:=false;EXIT;END IF;
   END LOOP;
  END IF;
  IF v_l_valid THEN
   IF (v_l_counts->>'rows')::numeric IS DISTINCT FROM
    (v_l_counts->>'bad')::numeric+(v_l_counts->>'resolved')::numeric+(v_l_counts->>'unknown')::numeric THEN v_l_valid:=false;END IF;
  END IF;
 END IF;

   END IF;
   CONTINUE WHEN v_l_valid;
   IF proved AND clock_timestamp()>stop_at THEN RETURN false;END IF;
   -- The canonical reader is a filtered subset of this admitted raw linked
   -- innerjoin bag. An exact zero witness therefore proves an empty result.
   IF (v_l_witness->>'links')::bigint=0 THEN
    v_l_counts:=jsonb_build_object('rows',0,'bad',0,'resolved',0,'unknown',0);
   ELSE
   SELECT jsonb_build_object('rows',count(*),
    'bad',count(*)FILTER(WHERE NOT(k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb)),
    'resolved',count(*)FILTER(WHERE k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb),
    'unknown',count(*)FILTER(WHERE(k.evidence->>'status'='ready'AND k.evidence->'basis_certified'='true'::jsonb AND k.evidence->'all_players_included'='true'::jsonb)IS NULL))
   INTO v_l_counts FROM public.fn_union_pnl_linked_cash_outcomes(p_union_id,w.window_start,w.window_end)k;
   END IF;
   IF v_l_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected)
    THEN RAISE EXCEPTION 'weekly_linked_parts_sources_changed_during_window';END IF;
   v_l_value:=jsonb_build_object('contract','canonical-linked-validation-v1','generation',v_generation,
    'projected',v_hand_projected,'reader_md5','0c3a826553e9ef65a03030c3ef78eaaf',
    'witness_md5','a3b1c75ad2b122dc0b0fede8a66813c8','input_key',v_l_key,'witness',v_l_witness,'counts',v_l_counts);
   v_l_value:=v_l_value||jsonb_build_object('proof_md5',md5(v_l_value::text));
   INSERT INTO public.accounting_close_partials AS current_proof(kind,union_id,period_start,period_end,window_start,window_end,value,computed_at)
   VALUES('pnl_linked_window',p_union_id,p_start,p_end,w.window_start,w.window_end,v_l_value,clock_timestamp())
   ON CONFLICT(kind,union_id,period_start,period_end,window_start)DO UPDATE SET
    window_end=EXCLUDED.window_end,value=EXCLUDED.value,cash_ids=NULL,cash_md5=NULL,fee_ids=NULL,fee_md5=NULL,computed_at=EXCLUDED.computed_at
   WHERE current_proof.window_end IS DISTINCT FROM EXCLUDED.window_end OR current_proof.value IS DISTINCT FROM EXCLUDED.value
    OR current_proof.cash_ids IS NOT NULL OR current_proof.cash_md5 IS NOT NULL OR current_proof.fee_ids IS NOT NULL OR current_proof.fee_md5 IS NOT NULL
    OR NOT isfinite(current_proof.computed_at)OR current_proof.computed_at<p_end
    OR current_proof.computed_at<=clock_timestamp()-public.fn_accounting_close_proof_lifetime()OR current_proof.computed_at>clock_timestamp();
   -- Revalidate after the upsert while its row lock is held: a stale worker
   -- must roll back rather than overwrite a newer committed window proof.
   IF v_l_witness IS DISTINCT FROM smarter_private.weekly_hand_parts_witness(p_union_id,w.window_start,w.window_end,v_hand_projected)
    THEN RAISE EXCEPTION 'weekly_linked_parts_sources_changed_during_write';END IF;
   proved:=true;
   -- Batch sound empty units within the original stop budget. At most one
   -- nonempty canonical reader call is allowed in any original attempt.
   IF (v_l_witness->>'links')::bigint>0 THEN RETURN false;END IF;
  END LOOP;
  IF proved THEN RETURN false;END IF;
 END IF;
RETURN true;END;$producer$;

CREATE FUNCTION public.fixture_afterwrite_drift()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('fixture.afterwrite_drift',true)='on' THEN UPDATE public.test_windows SET links=links+1 WHERE window_start=NEW.window_start;END IF;RETURN NEW;END;$$;
CREATE TRIGGER fixture_afterwrite_drift AFTER INSERT OR UPDATE ON public.accounting_close_partials FOR EACH ROW EXECUTE FUNCTION public.fixture_afterwrite_drift();
DO $cases$DECLARE first_times jsonb;r boolean;BEGIN
 INSERT INTO public.test_windows SELECT '2026-10-19 07:00Z'::timestamptz+i*interval '2h','2026-10-19 09:00Z'::timestamptz+i*interval '2h',0 FROM generate_series(0,83)i;
 r:=pg_temp.produce();
 IF r IS DISTINCT FROM false OR(SELECT count(*)FROM public.accounting_close_partials)<>84 OR EXISTS(SELECT FROM public.reader_calls)THEN RAISE EXCEPTION 'allzero_not_batched';END IF;
 SELECT jsonb_agg(computed_at ORDER BY window_start)INTO first_times FROM public.accounting_close_partials;
 r:=pg_temp.produce();
 IF r IS DISTINCT FROM true OR first_times IS DISTINCT FROM(SELECT jsonb_agg(computed_at ORDER BY window_start)FROM public.accounting_close_partials)THEN RAISE EXCEPTION 'allzero_resume_rewrote';END IF;
 TRUNCATE public.accounting_close_partials,public.test_windows,public.reader_calls;
 INSERT INTO public.test_windows SELECT '2026-10-19 07:00Z'::timestamptz+i*interval '2h','2026-10-19 09:00Z'::timestamptz+i*interval '2h',CASE WHEN i IN(1,3)THEN 1 ELSE 0 END FROM generate_series(0,3)i;
 r:=pg_temp.produce();
 IF r IS DISTINCT FROM false OR(SELECT count(*)FROM public.accounting_close_partials)<>2 OR(SELECT count(*)FROM public.reader_calls)<>1 THEN RAISE EXCEPTION 'mixed_first_attempt_not_bounded';END IF;
 r:=pg_temp.produce();
 IF r IS DISTINCT FROM false OR(SELECT count(*)FROM public.accounting_close_partials)<>4 OR(SELECT count(*)FROM public.reader_calls)<>2 THEN RAISE EXCEPTION 'mixed_resume_not_bounded';END IF;
 r:=pg_temp.produce();
 IF r IS DISTINCT FROM true OR(SELECT count(*)FROM public.reader_calls)<>2 THEN RAISE EXCEPTION 'mixed_fresh_repeated_heavy';END IF;
 TRUNCATE public.accounting_close_partials,public.reader_calls;
 r:=pg_temp.produce(true);
 IF r IS DISTINCT FROM false OR(SELECT count(*)FROM public.accounting_close_partials)<>1 OR EXISTS(SELECT FROM public.reader_calls)THEN RAISE EXCEPTION 'deadline_not_preserved';END IF;
 TRUNCATE public.accounting_close_partials,public.reader_calls;
 PERFORM set_config('fixture.afterwrite_drift','on',true);
 BEGIN
  PERFORM pg_temp.produce();RAISE EXCEPTION 'afterwrite_drift_was_accepted';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'weekly_linked_parts_sources_changed_during_write' THEN RAISE;END IF;
 END;
 IF EXISTS(SELECT FROM public.accounting_close_partials)THEN RAISE EXCEPTION 'afterwrite_drift_not_rolled_back';END IF;
 PERFORM set_config('fixture.afterwrite_drift','off',true);
 RAISE NOTICE 'PRODUCER_CONTROL_CASES_PASS:allzero84,resume_unchanged,mixed_one_heavy,second_resume,completed_reuse,deadline,afterwrite_drift_rollback';
END;$cases$;
ROLLBACK;
