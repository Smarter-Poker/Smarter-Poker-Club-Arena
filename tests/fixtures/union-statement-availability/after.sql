DO $$ DECLARE j jsonb:=ca_union_statement_board('00000000-0000-4000-8000-000000000001',null,8); BEGIN
 IF j->'totals'->'payment_details_available'<>'false'::jsonb OR j->'totals'->'collected'<>'null'::jsonb OR j->'totals'->'outstanding'<>'null'::jsonb THEN RAISE EXCEPTION 'Unknown totals became numbers: %',j; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'clubs') x WHERE x->>'status'='paid' AND x->'payment_details_available'='false'::jsonb AND x->'paid_total'='null'::jsonb AND x->'outstanding'='null'::jsonb AND (x->>'amount')::numeric=100) THEN RAISE EXCEPTION 'Legacy invoice amount or unknown details changed: %',j; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j->'clubs') x WHERE x->>'status'='generated' AND x->'payment_details_available'='true'::jsonb AND (x->>'paid_total')::numeric=25 AND (x->>'outstanding')::numeric=75) THEN RAISE EXCEPTION 'Current partial payment changed'; END IF;
 IF (SELECT hash FROM original_invoice_snapshot) IS DISTINCT FROM (SELECT md5(string_agg(to_jsonb(i)::text,',' ORDER BY id)) FROM settlement_invoices i) THEN RAISE EXCEPTION 'Source invoice rewritten'; END IF;
 PERFORM set_config('app.user_id','00000000-0000-4000-8000-000000000009',true);
 BEGIN PERFORM ca_union_statement_board('00000000-0000-4000-8000-000000000001',null,8); RAISE EXCEPTION 'Unauthorized read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
