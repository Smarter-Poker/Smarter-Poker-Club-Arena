 SET statement_timeout = '600s';
          SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
          SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-ledger-replay'))
                      THEN (public.fn_ca_ledger_replay(5000))::text
                      ELSE 'locked' END;
          SELECT public.fn_ca_currency_meter(); 