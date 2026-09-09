DO $mig$
DECLARE v_ok boolean := false; i int;
BEGIN
  SET LOCAL statement_timeout = '110s';
  /* A snapshot has to say which reader took it, so a change of reader is
     never mistaken for a movement of money.

     Taken with a 2s lock timeout and retried rather than one long wait: an
     ACCESS EXCLUSIVE request that queues also queues every ordinary writer
     behind it, and that is how this platform took itself down earlier today.
     The blocker is a pg_dump holding AccessShareLock across the schema; it
     finishes on its own. */
  FOR i IN 1..25 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE public.ca_account_snapshots ADD COLUMN IF NOT EXISTS basis_version text;
      v_ok := true;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;

  IF NOT v_ok THEN RAISE EXCEPTION 'could not take the lock on ca_account_snapshots in 25 tries'; END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='ca_account_snapshots' AND column_name='basis_version') <> 1 THEN
    RAISE EXCEPTION 'ca_account_snapshots.basis_version missing after ALTER';
  END IF;
END
$mig$;
