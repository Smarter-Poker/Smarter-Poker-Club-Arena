CREATE FUNCTION public.fn_ca_operator_finish_cash_close(p_table_id uuid, p_operation_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.tables WHERE id=p_table_id AND tournament_id IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE table_id=p_table_id AND operation_id=p_operation_id AND status='pending') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND is_complete=false) THEN RETURN false; END IF;
 UPDATE public.tables SET status='closed' WHERE id=p_table_id;
 UPDATE public.ca_operator_table_closes SET status='closed' WHERE table_id=p_table_id AND operation_id=p_operation_id;
 IF NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id AND status='pending') THEN
  UPDATE public.ca_engine_operator_commands SET status='completed',updated_at=clock_timestamp() WHERE id=p_operation_id;
 END IF;
 RETURN true;
END $$;
