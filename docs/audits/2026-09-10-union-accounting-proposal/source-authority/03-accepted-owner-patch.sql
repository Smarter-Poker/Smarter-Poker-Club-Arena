-- PROPOSAL ONLY. Run in the SAME transaction as cash commission admission.
-- The exact accepted-hand owner keeps its signature, authorization and grants.
DO $patch$
DECLARE v_oid oid; v_body text; v_needle text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_allocate_rake_credits(numeric,jsonb,text)')
   AND md5(prosrc)='a63ce6760dc4178f000f2214a7cf7cd6') THEN
   RAISE EXCEPTION 'Cash commission allocator changed; recapture its accepted cent allocation';
 END IF;
 v_oid:=to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)');
 IF v_oid IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=v_oid) IS DISTINCT FROM
   '0ef3c57a6a31acc383ce4b95a0f9519f' THEN
   RAISE EXCEPTION 'Accepted-hand owner changed; recapture and review the live contract';
 END IF;
 IF has_function_privilege('anon',v_oid,'execute')
    OR has_function_privilege('authenticated',v_oid,'execute')
    OR NOT has_function_privilege('service_role',v_oid,'execute')
    OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN
   RAISE EXCEPTION 'Accepted-hand owner privilege boundary changed';
 END IF;
 v_body:=pg_get_functiondef(v_oid);
 v_needle:=$anchor$    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;$anchor$;
 IF (length(v_body)-length(replace(v_body,v_needle,'')))/length(v_needle)<>1 THEN
   RAISE EXCEPTION 'Accepted-hand source capture anchor is not unique';
 END IF;
 -- Only the first accepted envelope captures facts. Response-loss replays
 -- cannot attach new source facts to an old zero-row/no-agent hand.
 v_body:=replace(v_body,v_needle,v_needle||
   E'\n    PERFORM public.fn_ca_capture_cash_commission_source(v_hand_id,p_stacks);');
 EXECUTE v_body;
 INSERT INTO public.ca_cash_commission_authority(singleton,contract_version,activated_at,
   accepted_owner_before_md5,accepted_owner_after_md5)
 SELECT true,1,clock_timestamp(),'0ef3c57a6a31acc383ce4b95a0f9519f',md5(prosrc)
 FROM pg_proc WHERE oid=v_oid;
 IF NOT EXISTS(SELECT 1 FROM public.ca_cash_commission_authority WHERE singleton
   AND accepted_owner_before_md5<>accepted_owner_after_md5)
   OR has_function_privilege('anon',v_oid,'execute')
   OR has_function_privilege('authenticated',v_oid,'execute')
   OR NOT has_function_privilege('service_role',v_oid,'execute') THEN
   RAISE EXCEPTION 'Accepted-hand source cutover postcondition failed';
 END IF;
END $patch$;

