CREATE OR REPLACE FUNCTION public.fn_issue_scope_weekly_accounting(p_scope_kind text, p_scope_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_variable
DECLARE scope record;club uuid;period public.settlement_periods%ROWTYPE;report jsonb;invoice uuid;issued int:=0;period_count int;clubs uuid[];delivery jsonb;expected_users int;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501';END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from) OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'weekly_statement_requires_closed_week' USING ERRCODE='22023';END IF;
 IF current_setting('app.accounting_validated_scope',true) IS DISTINCT FROM p_scope_kind||':'||p_scope_id::text||':'||p_from::text||':'||p_to::text
 THEN RAISE EXCEPTION 'weekly_statement_requires_validated_scope' USING ERRCODE='23514';END IF;
 SELECT * INTO scope FROM public.fn_resolve_accounting_routing_scope(p_scope_kind,p_scope_id,p_from,p_to);
 SELECT COALESCE(array_agg(x.club_id ORDER BY x.club_id),ARRAY[]::uuid[]) INTO clubs FROM (
  SELECT c.club_id FROM public.fn_accounting_week_clubs(scope.union_id,scope.standalone_club_id,p_from,p_to)c
  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))
  UNION SELECT sp.club_id FROM public.settlement_periods sp WHERE sp.start_at=p_from AND sp.end_at=p_to AND sp.club_id IS NOT NULL
   AND (sp.union_id=scope.union_id OR (sp.club_id=scope.standalone_club_id AND sp.union_id IS NULL))
 )x WHERE x.club_id IS DISTINCT FROM scope.union_id;
 FOREACH club IN ARRAY clubs LOOP
  SELECT count(*) INTO period_count FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to;
  IF period_count<>1 THEN RAISE EXCEPTION 'weekly_statement_period_missing_or_duplicated' USING ERRCODE='23514',DETAIL=jsonb_build_object('club_id',club,'period_count',period_count)::text;END IF;
  SELECT * INTO period FROM public.settlement_periods sp WHERE sp.club_id=club AND sp.union_id IS NOT DISTINCT FROM scope.union_id AND sp.start_at=p_from AND sp.end_at=p_to FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('club_weekly_invoice:'||period.id::text,0));
  SELECT i.id INTO invoice FROM public.settlement_invoices i WHERE i.period_id=period.id AND i.club_id=club AND i.invoice_type='club_weekly_accounting';
  IF invoice IS NULL THEN
   report:=public.fn_club_weekly_accounting_summary(period.id);
   IF report->>'ready_to_issue' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'club_weekly_statement_requires_reconciliation' USING ERRCODE='23514',DETAIL=report::text;END IF;
   report:=report||jsonb_build_object('status','complete');
   INSERT INTO public.settlement_invoices(club_id,period_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,breakdown,status,notes)
   VALUES(club,period.id,'club_weekly_accounting','club',club::text,'club',club::text,(report->>'total_rake_funding')::numeric,(report->>'retained_by_club')::numeric,
    (report->>'total_paid_by_club')::numeric,report,'generated','Consolidated Weekly Club Accounting. The Net Movement Is Not An Additional Bill Or Transfer.') RETURNING id INTO invoice;
   issued:=issued+1;
  END IF;
  delivery:=public.fn_deliver_accounting_invoice(invoice);
  SELECT count(*) INTO expected_users FROM public.fn_accounting_party_users('club',club);
  IF delivery->>'success' IS DISTINCT FROM 'true' /* HISTORY-ONLY INVOICE (20261016143729) */ OR expected_users=0 OR (SELECT si.message_sent IS NOT TRUE FROM public.settlement_invoices si WHERE si.id=invoice)
   OR ((SELECT si.invoice_type FROM public.settlement_invoices si WHERE si.id=invoice) IS NOT DISTINCT FROM 'cashier_cashout' AND EXISTS(
   SELECT 1 FROM public.fn_accounting_party_users('club',club)u WHERE NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries d
    JOIN public.social_messages m ON m.id=d.message_id JOIN public.notifications n ON n.id=d.notification_id
    WHERE d.invoice_id=invoice AND d.recipient_id=u.user_id AND m.media_metadata->>'invoice_id'=invoice::text AND n.user_id=u.user_id
     AND m.message_type='invoice' AND n.metadata->>'invoice_id'=invoice::text)))
  THEN RAISE EXCEPTION 'club_weekly_statement_delivery_incomplete' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN jsonb_build_object('success',true,'scope_kind',p_scope_kind,'scope_id',p_scope_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'issued',issued);
END $function$
