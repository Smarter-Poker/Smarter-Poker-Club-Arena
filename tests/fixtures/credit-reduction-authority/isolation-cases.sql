\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Caller begins one of the two rejected isolation modes.
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
\ir helpers.sql
\ir seed.sql
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $isolation$ DECLARE command text;before_book jsonb;state text;message text;BEGIN
 PERFORM pg_temp.cr_check(current_setting('transaction_isolation') IN('repeatable read','serializable'),
  'actual higher-isolation transaction is active');before_book:=pg_temp.cr_book();
 FOREACH command IN ARRAY ARRAY[
  'SELECT public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(2))',
  'SELECT public.fn_reduce_agent_credit_v1(pg_temp.cr_id(1),pg_temp.cr_id(1901),pg_temp.cr_id(101),pg_temp.cr_id(201),pg_temp.cr_id(2),1,100,25,false,0,NULL)',
  'SELECT public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id(1901),pg_temp.cr_id(101))',
  'SELECT public.fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(1),pg_temp.cr_id(1901),pg_temp.cr_id(101))'] LOOP
  BEGIN EXECUTE command;RAISE EXCEPTION 'higher isolation credit API accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   IF state IS DISTINCT FROM '25000' OR message IS DISTINCT FROM 'credit_reduction_read_committed_required' THEN RAISE;END IF;
  END;
  PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'higher isolation refuses the actual API without business writes: '||command);
 END LOOP;
END$isolation$;
RESET ROLE;
