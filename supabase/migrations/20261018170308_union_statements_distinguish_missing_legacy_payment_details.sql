-- Reserved by scripts/new-migration.mjs. Read-only legacy payment availability.
-- A historic paid status without payment detail is not a zero payment or a
-- verified balance. Keep invoices immutable and expose that missing evidence.
-- @live-proof: position('payment_details_available' in pg_get_functiondef('public.ca_union_statement_board(uuid,date,integer)'::regprocedure))>0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $patch$
DECLARE d text:=pg_get_functiondef('public.ca_union_statement_board(uuid,date,integer)'::regprocedure);
BEGIN
 IF position('payment_details_available' in d)>0 THEN RAISE EXCEPTION 'Statement availability already installed'; END IF;
 IF position('COALESCE((i.breakdown->>''paid_total'')::numeric, 0)' in d)=0 THEN RAISE EXCEPTION 'Statement payment source anchor changed'; END IF;
 d:=replace(d,'           i.id                            AS invoice_id,',
 $new$           (i.id IS NULL OR i.status <> 'paid' OR coalesce(i.net_amount,0)=0 OR i.breakdown ? 'paid_total') AS payment_details_available,
           i.id                            AS invoice_id,$new$);
 d:=replace(d,'''paid_total'', round(b.paid_total, 2),',
 '''payment_details_available'', b.payment_details_available, ''paid_total'', CASE WHEN b.payment_details_available THEN round(b.paid_total, 2) END,');
 d:=replace(d,'''outstanding'', round(GREATEST(abs(b.amount) - b.paid_total, 0), 2),',
 '''outstanding'', CASE WHEN b.payment_details_available THEN round(GREATEST(abs(b.amount) - b.paid_total, 0), 2) END,');
 d:=replace(d,'''collected'',  round(COALESCE(SUM(b.paid_total), 0), 2),',
 '''payment_details_available'', coalesce(bool_and(b.payment_details_available),true), ''collected'', CASE WHEN coalesce(bool_and(b.payment_details_available),true) THEN round(COALESCE(SUM(b.paid_total), 0), 2) END,');
 d:=replace(d,'''outstanding'', round(COALESCE(SUM(',
 '''outstanding'', CASE WHEN coalesce(bool_and(b.payment_details_available),true) THEN round(COALESCE(SUM(');
 d:=replace(d,'FILTER (WHERE b.status NOT IN (''missing'',''cancelled'')), 0), 2),',
 'FILTER (WHERE b.status NOT IN (''missing'',''cancelled'')), 0), 2) END,');
 IF position('AS payment_details_available' in d)=0 OR position('''payment_details_available'', b.payment_details_available' in d)=0 THEN RAISE EXCEPTION 'Statement availability patch incomplete'; END IF;
 EXECUTE d;
END $patch$;
REVOKE ALL ON FUNCTION public.ca_union_statement_board(uuid,date,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ca_union_statement_board(uuid,date,integer) TO authenticated,service_role;
COMMIT;
