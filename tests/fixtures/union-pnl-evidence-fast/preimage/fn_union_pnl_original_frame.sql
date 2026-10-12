CREATE OR REPLACE FUNCTION public.fn_union_pnl_original_frame()
 RETURNS union_pnl_transaction_frames
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE frame public.union_pnl_transaction_frames; observed timestamptz; book timestamptz;
BEGIN
 SELECT * INTO frame FROM public.union_pnl_transaction_frames WHERE transaction_id=pg_current_xact_id();
 IF FOUND THEN RETURN frame; END IF;
 observed:=clock_timestamp(); book:=public.fn_union_week_start(observed);
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
 observed:=clock_timestamp();
 IF public.fn_union_week_start(observed)<>book THEN
  book:=public.fn_union_week_start(observed);
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM book)::bigint::text,0));
  observed:=clock_timestamp();
  IF public.fn_union_week_start(observed)<>book THEN RAISE EXCEPTION 'pnl_frame_clock_crossed_twice' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.union_pnl_transaction_frames VALUES(pg_current_xact_id(),observed,book) RETURNING * INTO frame;
 RETURN frame;
END $function$
