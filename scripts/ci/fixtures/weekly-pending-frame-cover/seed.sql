CREATE TABLE public.cash_participant_funding_receipts(id uuid PRIMARY KEY,table_id uuid NOT NULL,pending_addon_id uuid UNIQUE,transaction_id xid8,recorded_at timestamptz NOT NULL,amount numeric(15,2) NOT NULL,funding_club_id uuid,user_id uuid NOT NULL,occupancy_id uuid NOT NULL,operation_kind text NOT NULL,payload text NOT NULL);
CREATE INDEX cash_participant_funding_occupancy ON public.cash_participant_funding_receipts(occupancy_id,recorded_at,id);
CREATE INDEX cash_participant_funding_buyin_table ON public.cash_participant_funding_receipts(table_id,user_id)WHERE operation_kind='buyin';
CREATE TABLE public.cash_funding_application_receipts(pending_addon_id uuid PRIMARY KEY,funding_receipt_id uuid UNIQUE NOT NULL,transaction_id xid8,applied_at timestamptz NOT NULL,applied numeric(15,2) NOT NULL,refunded numeric(15,2) NOT NULL);
CREATE TABLE public.union_pnl_transaction_frames(transaction_id xid8 PRIMARY KEY,observed_at timestamptz NOT NULL)WITH(fillfactor=90);
INSERT INTO public.cash_participant_funding_receipts SELECT md5('receipt'||i)::uuid,md5('table'||(1+i%13079))::uuid,CASE WHEN (i::bigint*7919)%300616<51000 THEN md5('addon'||i)::uuid END,
 CASE WHEN i%1000<>0 THEN (((i::bigint*104729)%1000000)+1)::text::xid8 END,
 timestamptz '2026-10-26 07:00Z'+CASE i%11 WHEN 0 THEN interval '1 second' WHEN 1 THEN interval '0 seconds'ELSE interval '-1 day'END,
 100.00,CASE WHEN i%19<>0 THEN md5('club'||(i%5))::uuid END,md5('user'||(i%101))::uuid,md5('occupancy'||i)::uuid,
 CASE WHEN (i::bigint*7919)%300616<51000 THEN 'addon'ELSE 'buyin'END,repeat(md5((i%47)::text),8) FROM generate_series(1,300616)i;
INSERT INTO public.union_pnl_transaction_frames SELECT i::text::xid8,timestamptz '2026-10-26 07:00Z'+CASE i%7 WHEN 0 THEN interval '0 seconds'WHEN 1 THEN interval '1 second'ELSE interval '-2 days'END FROM generate_series(1,1100000)i WHERE i%97<>0;
INSERT INTO public.cash_funding_application_receipts SELECT r.pending_addon_id,r.id,CASE WHEN row_number()OVER(ORDER BY r.id)%999<>0 THEN (1000000+row_number()OVER(ORDER BY r.id))::text::xid8 END,
 timestamptz '2026-10-26 07:00Z'+CASE row_number()OVER(ORDER BY r.id)%5 WHEN 0 THEN interval '0 seconds'WHEN 1 THEN interval '1 second'ELSE interval '-1 day'END,
 CASE row_number()OVER(ORDER BY r.id)%13 WHEN 0 THEN 110.00 WHEN 1 THEN 100.00 ELSE 40.00 END,CASE WHEN row_number()OVER(ORDER BY r.id)%13=1 THEN 0.00 ELSE 10.00 END FROM public.cash_participant_funding_receipts r WHERE pending_addon_id IS NOT NULL ORDER BY r.id LIMIT 48258;
ANALYZE public.cash_participant_funding_receipts;
ANALYZE public.cash_funding_application_receipts;
VACUUM ANALYZE public.union_pnl_transaction_frames;
-- Dirty about four percent of frame pages without changing values. Existing
-- primary-key access and the covering path must both preserve these rows.
UPDATE public.union_pnl_transaction_frames SET observed_at=observed_at WHERE ctid=ANY(ARRAY(SELECT('('||b||',1)')::tid FROM generate_series(0,(pg_relation_size('public.union_pnl_transaction_frames')/current_setting('block_size')::integer-1)::integer,25)b));
ANALYZE public.union_pnl_transaction_frames;
