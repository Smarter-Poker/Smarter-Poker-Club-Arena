\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Included in main fixture transaction after positive probes.
RESET ROLE;
DO $private_acl$ DECLARE who text;relation text;priv text;signature text;BEGIN
 FOREACH who IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOREACH relation IN ARRAY ARRAY['accounting_credit_reduction_operations_v1','accounting_credit_reduction_retirements_v1','accounting_credit_change_documents_v1'] LOOP
   FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] LOOP
    PERFORM pg_temp.cr_check(NOT has_table_privilege(who,('public.'||relation)::regclass,priv),'private '||relation||' denies '||who||' '||priv);
   END LOOP;
   FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
    PERFORM pg_temp.cr_check(NOT has_any_column_privilege(who,('public.'||relation)::regclass,priv),'private columns deny '||who||' '||priv);
   END LOOP;
  END LOOP;
  PERFORM pg_temp.cr_check(NOT has_function_privilege(who,'public.fn_accounting_credit_reduction_assert_document(uuid)','EXECUTE'),
   'private document assertion not an API entrypoint: '||who);
  FOREACH signature IN ARRAY ARRAY['public.fn_credit_reduction_lock_v1(uuid,uuid,uuid)',
   'public.fn_credit_reduction_lock_current_manager_v1(uuid,uuid)','public.fn_credit_reduction_observe_v1(uuid,uuid,uuid)',
   'public.fn_credit_reduction_receipt_payload_v1(uuid)','public.fn_credit_reduction_retirement_payload_v1(uuid)',
   'public.fn_agent_credit_control_revision_v1()','public.fn_credit_reduction_immutable_v1()',
   'public.fn_accounting_credit_change_contract_v1(uuid)','public.fn_accounting_credit_change_payload_v1(uuid)'] LOOP
   PERFORM pg_temp.cr_check(NOT has_function_privilege(who,signature,'EXECUTE'),'private helper denies direct execution '||who||':'||signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY['public.fn_agent_credit_reduction_snapshot_v1(uuid,uuid,uuid)',
   'public.fn_reduce_agent_credit_v1(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,boolean,bigint,text)',
   'public.fn_agent_credit_reduction_receipt_v1(uuid,uuid,uuid)','public.fn_retire_agent_credit_reduction_v1(uuid,uuid,uuid)'] LOOP
   PERFORM pg_temp.cr_check(has_function_privilege(who,signature,'EXECUTE') IS NOT DISTINCT FROM (who='authenticated'),
    'four public APIs require actual authenticated role '||who||':'||signature);
  END LOOP;
 END LOOP;
END$private_acl$;
SELECT pg_temp.cr_actor(NULL,'anon');SET LOCAL ROLE anon;
DO $anon_read$ BEGIN
 BEGIN PERFORM * FROM public.accounting_credit_reduction_operations_v1;RAISE EXCEPTION 'anonymous private operation read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END$anon_read$;
RESET ROLE;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $authenticated_direct$ BEGIN
 BEGIN PERFORM * FROM public.accounting_credit_reduction_operations_v1;RAISE EXCEPTION 'authenticated private operation read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN UPDATE public.agents SET credit_control_revision=0 WHERE id=pg_temp.cr_id(201);RAISE EXCEPTION 'authenticated direct revision write accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END$authenticated_direct$;
RESET ROLE;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1),'service_role');SET LOCAL ROLE service_role;
DO $service_tamper$ DECLARE before_book jsonb;BEGIN
 before_book:=pg_temp.cr_book();
 BEGIN PERFORM * FROM public.accounting_credit_reduction_operations_v1;RAISE EXCEPTION 'service direct private operation read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN UPDATE public.agents SET credit_control_revision=0 WHERE id=pg_temp.cr_id(201);RAISE EXCEPTION 'service revision reset accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_control_revision_is_managed' THEN RAISE;END IF;END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'service direct revision refusal preserves entire book');
END$service_tamper$;
RESET ROLE;
DO $immutable$ DECLARE before_book jsonb;BEGIN
 before_book:=pg_temp.cr_book();
 BEGIN UPDATE public.accounting_credit_reduction_operations_v1 SET actor_user_id=actor_user_id;RAISE EXCEPTION 'owner operation UPDATE accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_reduction_evidence_is_immutable' THEN RAISE;END IF;END;
 BEGIN DELETE FROM public.accounting_credit_reduction_operations_v1 WHERE false;RAISE EXCEPTION 'empty owner operation DELETE accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_reduction_evidence_is_immutable' THEN RAISE;END IF;END;
 BEGIN TRUNCATE public.accounting_credit_reduction_retirements_v1;RAISE EXCEPTION 'owner retirement TRUNCATE accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_reduction_evidence_is_immutable' THEN RAISE;END IF;END;
 BEGIN UPDATE public.accounting_credit_change_documents_v1 SET issuer_name=issuer_name;RAISE EXCEPTION 'owner credit document UPDATE accepted';
 EXCEPTION WHEN check_violation THEN IF SQLERRM<>'credit_change_document_is_immutable' THEN RAISE;END IF;END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'owner immutable evidence refuses no-op and empty destructive statements');
END$immutable$;
-- Synthetic boundary fixture only. Replica seeds the original max revision;
-- every attempted application mutation is then made under origin triggers.
SET LOCAL session_replication_role=replica;
UPDATE public.agents SET credit_control_revision=9223372036854775807 WHERE id=pg_temp.cr_id(240);
SET LOCAL session_replication_role=origin;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $overflow$ DECLARE before_book jsonb;BEGIN
 before_book:=pg_temp.cr_book();
 BEGIN PERFORM public.fn_admin_update_agent(pg_temp.cr_id(240),p_status=>'suspended');RAISE EXCEPTION 'revision overflow accepted';
 EXCEPTION WHEN numeric_value_out_of_range THEN IF SQLERRM<>'credit_control_revision_exhausted' THEN RAISE;END IF;END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'overflow rolls back the real shared writer without wrap');
END$overflow$;
RESET ROLE;
