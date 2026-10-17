DO $mig$
DECLARE src text; out_src text;
 c_receipt CONSTANT text := 'inv.chips_transferred AND inv.invoice_type NOT IN(''credit_limit_change'',''accounting_correction'',''cashier_cashout'')';
BEGIN
 src := pg_get_functiondef('public.fn_deliver_accounting_invoice(uuid)'::regprocedure);
 out_src := replace(src, $a$VALUES(person,'accounting_invoice',CASE WHEN inv.invoice_type='credit_limit_change'$a$,
   'VALUES(person,CASE WHEN '||c_receipt||' THEN ''accounting_invoice_detail'' ELSE ''accounting_invoice'' END,CASE WHEN inv.invoice_type=''credit_limit_change''');
 IF out_src = src THEN RAISE EXCEPTION 'deliver_patch_type_anchor_missing'; END IF;
 src := out_src;
 out_src := replace(src, $a$meta,false,'/hub/messenger?conversation='$a$, 'meta,('||c_receipt||'),''/hub/messenger?conversation=''');
 IF out_src = src THEN RAISE EXCEPTION 'deliver_patch_read_anchor_missing'; END IF;
 EXECUTE out_src;

 src := pg_get_functiondef('public.fn_messenger_notification_visible_to(uuid,uuid)'::regprocedure);
 out_src := replace(src, $a$n.type IS DISTINCT FROM 'accounting_invoice_detail'$a$,
   $a$n.type IS DISTINCT FROM 'accounting_invoice_detail' AND COALESCE(n.data->>'_push','') <> 'ledger_only'$a$);
 IF out_src = src THEN RAISE EXCEPTION 'visible_patch_anchor_missing'; END IF;
 EXECUTE out_src;

 src := pg_get_functiondef('public.get_unified_user_profile(uuid)'::regprocedure);
 out_src := regexp_replace(src, 'WHERE user_id = p_user_id AND COALESCE\(read, false\) = false',
   $a$WHERE user_id = p_user_id AND COALESCE(read, false) = false AND type IS DISTINCT FROM 'accounting_invoice_detail' AND COALESCE(data->>'_push','') <> 'ledger_only'$a$, 'g');
 out_src := regexp_replace(out_src, 'WHERE user_id = p_user_id(\s+)ORDER BY created_at DESC LIMIT 5',
   $a$WHERE user_id = p_user_id AND type IS DISTINCT FROM 'accounting_invoice_detail' AND COALESCE(data->>'_push','') <> 'ledger_only'\1ORDER BY created_at DESC LIMIT 5$a$, 'g');
 IF out_src = src THEN RAISE EXCEPTION 'profile_patch_anchor_missing'; END IF;
 EXECUTE out_src;

 src := pg_get_functiondef('public.get_user_cross_product_summary(uuid)'::regprocedure);
 out_src := regexp_replace(src, 'WHERE user_id = p_user_id AND COALESCE\(read, false\) = false',
   $a$WHERE user_id = p_user_id AND COALESCE(read, false) = false AND type IS DISTINCT FROM 'accounting_invoice_detail' AND COALESCE(data->>'_push','') <> 'ledger_only'$a$, 'g');
 IF out_src = src THEN RAISE EXCEPTION 'summary_patch_anchor_missing'; END IF;
 EXECUTE out_src;
END $mig$;

UPDATE public.notifications n
   SET type='accounting_invoice_detail', read=true, is_read=true
  FROM public.accounting_invoice_deliveries d
  JOIN public.settlement_invoices i ON i.id=d.invoice_id
 WHERE d.notification_id=n.id AND n.type='accounting_invoice' AND i.chips_transferred
   AND i.invoice_type NOT IN('credit_limit_change','accounting_correction','cashier_cashout');

UPDATE public.notifications SET read=true, is_read=true
 WHERE data->>'_push'='ledger_only' AND COALESCE(read,false)=false;

UPDATE public.push_outbox o SET status='skipped', failure_reason='ledger_only_transfer_receipt'
  FROM public.notifications n
 WHERE o.accounting_notification_id=n.id AND n.type='accounting_invoice_detail'
   AND o.status IN('pending','processing');