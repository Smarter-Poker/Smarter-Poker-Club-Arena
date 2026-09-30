-- Digest helpers: every call's value, or its refusal (SQLSTATE, message, detail).
CREATE FUNCTION public.hx_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; m text; d text; s text;
BEGIN
 EXECUTE p_sql INTO r; RETURN 'value:'||COALESCE(r,'<null>');
EXCEPTION WHEN OTHERS THEN
 GET STACKED DIAGNOSTICS m=MESSAGE_TEXT,d=PG_EXCEPTION_DETAIL,s=RETURNED_SQLSTATE;
 RETURN 'error:'||s||':'||m||':'||COALESCE(d,'');
END $$;
CREATE FUNCTION public.hx_calls(p_label text, p_sql text) RETURNS TABLE(label text, digest text, bytes int, body text) LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN v:=public.hx_try(p_sql); RETURN QUERY SELECT p_label,md5(v),length(v),v; END $$;
-- all read paths, outside a close; then the same inside one close attempt
CREATE FUNCTION public.hx_digest() RETURNS TABLE(label text, digest text, bytes int, body text) LANGUAGE plpgsql AS $$
DECLARE u uuid; o uuid; w0 text:='2026-09-21 07:00+00'; w1 text:='2026-09-28 07:00+00'; wp text:='2026-09-14 07:00+00';
BEGIN
 SELECT union_id,other_union_id INTO u,o FROM public.hx_meta;
 RETURN QUERY SELECT * FROM public.hx_calls('evidence', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',u,w0,w1));
 RETURN QUERY SELECT * FROM public.hx_calls('evidence_other', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',o,w0,w1));
 RETURN QUERY SELECT * FROM public.hx_calls('evidence_prior_week', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',u,wp,w0));
 RETURN QUERY SELECT * FROM public.hx_calls('evidence_open_week', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',u,w1,'2026-10-05 07:00+00'));
 RETURN QUERY SELECT * FROM public.hx_calls('boundary_open', format('SELECT public.fn_union_pnl_boundary(%L,%L)::text',u,w0));
 RETURN QUERY SELECT * FROM public.hx_calls('boundary_close', format('SELECT public.fn_union_pnl_boundary(%L,%L)::text',u,w1));
 RETURN QUERY SELECT * FROM public.hx_calls('boundary_other', format('SELECT public.fn_union_pnl_boundary(%L,%L)::text',o,w1));
 RETURN QUERY SELECT * FROM public.hx_calls('close_quality', format('SELECT public.fn_union_pnl_close_quality(%L,%L,%L)::text',u,w0,w1));
 RETURN QUERY SELECT * FROM public.hx_calls('qualified_clubs', format('SELECT public.fn_union_pnl_qualified_clubs(%L,%L,%L)::text',u,w0,w1));
 -- one close attempt: the same answers, however many times asked
 PERFORM public.fn_weekly_accounting_attempt_begin(true);
 PERFORM setval('public.hx_reports',1,false);
 RETURN QUERY SELECT 'close:'||c.label,c.digest,c.bytes,c.body FROM public.hx_calls('close_quality', format('SELECT public.fn_union_pnl_close_quality(%L,%L,%L)::text',u,w0,w1)) c;
 RETURN QUERY SELECT 'close:'||c.label,c.digest,c.bytes,c.body FROM public.hx_calls('qualified_clubs', format('SELECT public.fn_union_pnl_qualified_clubs(%L,%L,%L)::text',u,w0,w1)) c;
 RETURN QUERY SELECT 'close:'||c.label,c.digest,c.bytes,c.body FROM public.hx_calls('evidence', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',u,w0,w1)) c;
 RETURN QUERY SELECT 'close:'||c.label,c.digest,c.bytes,c.body FROM public.hx_calls('evidence_other', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',o,w0,w1)) c;
 RETURN QUERY SELECT 'close:'||c.label,c.digest,c.bytes,c.body FROM public.hx_calls('evidence_again', format('SELECT public.fn_union_pnl_evidence_report(%L,%L,%L)::text',u,w0,w1)) c;
 PERFORM public.fn_weekly_accounting_attempt_end();
 RETURN QUERY SELECT 'reports_computed_in_close'::text, (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public.hx_reports)::text, 0, ''::text;
 RETURN QUERY SELECT 'memo_after_end'::text, md5(COALESCE(current_setting('app.union_pnl_evidence_memo',true),'')), 0, COALESCE(current_setting('app.union_pnl_evidence_memo',true),'');
END $$;
