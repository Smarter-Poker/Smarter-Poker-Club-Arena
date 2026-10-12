-- tests/fixtures/ledger-invariant/refusal-regression.sql
--
-- Executes *_a_ledger_refusal_is_recorded_outside_its_rollback.sql on the
-- fixture after every invariant proof has run. The point of the file is the
-- thing the invariant could not do before: a refused transaction rolls back
-- whole, and its record must still be there afterwards.
--
--   F1  a REAL top-level transaction is refused at COMMIT and rolled back; the
--       stack is unchanged, and the refusal row, the counter and a critical
--       incident all exist afterwards;
--   F2  the same refusal again folds into the same open incident
--       (occurrences 2) while each refusal keeps its own row;
--   F3  the refusal a caller sees is unchanged: SQLSTATE 23514, same message;
--   F4  a suspense refusal is recorded with what it moved;
--   F5  the recorder cannot reach the database (its login is refused): the
--       refusal is raised exactly as before, the counter still
--       counts it, and the watch turns the missing record into an explicit
--       'unrecorded' row and a critical incident - never a silent zero;
--   F6  a late record replaces the watch's placeholder;
--   F7  the recorder's login can file a refusal and do nothing else.
-- The recorder authenticates over TCP with scram (test-ledger-invariant.sh
-- adds that pg_hba line), so every recorded row also proves the password the
-- migration generated, which nobody saw, round-trips through Vault.

\set ON_ERROR_STOP on
\set QUIET on

DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 0 OR c.recorded <> 0 OR c.unrecorded <> 0 THEN
    RAISE EXCEPTION 'FIXTURE: the census does not start at zero: %', to_jsonb(c);
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE mode <> 'refuse') THEN
    RAISE EXCEPTION 'FIXTURE: every chip store must refuse for these cases';
  END IF;
END $$;

CREATE TEMP TABLE fx_before AS
  SELECT stack FROM public.table_seats WHERE id = '55555555-0000-0000-0000-000000000002';

-- ===========================================================================
-- F1 a real transaction, refused at COMMIT, rolled back whole
-- ===========================================================================

\set ON_ERROR_STOP off
BEGIN;
UPDATE public.table_seats SET stack = stack + 48 WHERE id = '55555555-0000-0000-0000-000000000002';
COMMIT;
\set ON_ERROR_STOP on

DO $$
DECLARE r record; i record; c record;
BEGIN
  IF (SELECT stack FROM public.table_seats WHERE id = '55555555-0000-0000-0000-000000000002')
     IS DISTINCT FROM (SELECT stack FROM fx_before) THEN
    RAISE EXCEPTION 'FIXTURE: F1 the refused transaction was not rolled back';
  END IF;
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 1 OR c.recorded <> 1 OR c.unrecorded <> 0 OR c.unraised <> 0 THEN
    RAISE EXCEPTION 'FIXTURE: F1 census after one refusal: %', to_jsonb(c);
  END IF;
  SELECT * INTO r FROM public.ca_ledger_invariant_refusals WHERE counter_no = 1;
  IF r.kind <> 'balance_moved_without_its_ledger_row' OR r.account_key NOT LIKE 'table_stack%'
     OR r.balance_delta <> 48 OR r.ledger_net <> 0 OR r.mode <> 'refuse'
     OR r.rpc <> 'update public.table_seats' OR r.txid IS NULL OR r.refused_at IS NULL
     OR r.message NOT LIKE 'REFUSED: balance_moved_without_its_ledger_row account=table_stack%balance_delta=48.00 ledger_net=0.00'
     OR r.incident_id IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: F1 the refusal record is wrong: %', to_jsonb(r);
  END IF;
  SELECT * INTO i FROM public.ca_drift_incidents WHERE id = r.incident_id;
  IF i.severity <> 'critical' OR i.source <> 'ledger_invariant.refused' OR i.layer <> 'ledger'
     OR i.classification <> 'ledger_imbalance' OR i.occurrences <> 1 OR i.discrepancy_amount <> 48
     OR i.dedupe_key <> 'ledger-invariant-refused:balance_moved_without_its_ledger_row:update public.table_seats:' || r.account_key
     OR i.metadata ->> 'function' <> 'update public.table_seats' THEN
    RAISE EXCEPTION 'FIXTURE: F1 the incident is wrong: %', to_jsonb(i);
  END IF;
  RAISE NOTICE 'ok  recorded  F1 a refused transaction rolled back whole; its refusal row, counter 1 and a critical incident survived it';
END $$;

-- ===========================================================================
-- F2 the same refusal again folds into the same incident
-- ===========================================================================

\set ON_ERROR_STOP off
BEGIN;
UPDATE public.table_seats SET stack = stack + 48 WHERE id = '55555555-0000-0000-0000-000000000002';
COMMIT;
\set ON_ERROR_STOP on

DO $$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 2 OR c.recorded <> 2 OR c.unrecorded <> 0 THEN
    RAISE EXCEPTION 'FIXTURE: F2 census after two refusals: %', to_jsonb(c);
  END IF;
  IF (SELECT count(DISTINCT incident_id) FROM public.ca_ledger_invariant_refusals) <> 1
     OR (SELECT occurrences FROM public.ca_drift_incidents WHERE source = 'ledger_invariant.refused') <> 2
     OR (SELECT count(*) FROM public.ca_drift_incidents WHERE source = 'ledger_invariant.refused') <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: F2 a repeated refusal did not fold into one incident';
  END IF;
  RAISE NOTICE 'ok  folded    F2 the same refusal twice: two rows, one critical incident, occurrences 2';
END $$;

-- ===========================================================================
-- F3 + F4 what the caller sees is unchanged; a suspense refusal is recorded
-- ===========================================================================

CREATE OR REPLACE FUNCTION pg_temp.refusal_seen(p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    RETURN 'COMMITTED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    RETURN v_state || ' ' || v_msg;
  END;
END $$;

DO $$
DECLARE v text; r record;
BEGIN
  v := pg_temp.refusal_seen($q$ SELECT set_config('app.ledger_autoskip_club_members', '1', true);
         UPDATE public.club_members SET chip_balance = chip_balance + 10
          WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
  IF v <> '23514 REFUSED: balance_moved_without_its_ledger_row account=player_wallet:aaaaaaaa-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111 balance_delta=10.00 ledger_net=0.00' THEN
    RAISE EXCEPTION 'FIXTURE: F3 the refusal the caller sees changed: %', v;
  END IF;
  PERFORM set_config('app.ledger_autoskip_club_members', '', true);

  v := pg_temp.refusal_seen($q$ UPDATE public.club_members SET chip_balance = chip_balance + 10
          WHERE club_id = '11111111-1111-1111-1111-111111111111' AND user_id = 'aaaaaaaa-0000-0000-0000-000000000001' $q$);
  IF v NOT LIKE '23514 REFUSED: balance_moved_against_settlement_suspense suspense_legs=10.00 moved=player_wallet:%' THEN
    RAISE EXCEPTION 'FIXTURE: F4 the suspense refusal the caller sees changed: %', v;
  END IF;
  SELECT * INTO r FROM public.ca_ledger_invariant_refusals WHERE counter_no = 4;
  IF r.kind <> 'balance_moved_against_settlement_suspense' OR r.account_key <> 'settlement_suspense'
     OR r.ledger_net <> 10 OR r.balance_delta <> 10 OR r.moved NOT LIKE 'player_wallet:aaaaaaaa-0000-0000-0000-000000000001:% 10.00'
     OR r.rpc IS NULL OR r.incident_id IS NULL THEN
    RAISE EXCEPTION 'FIXTURE: F4 the suspense refusal record is wrong: %', to_jsonb(r);
  END IF;
  RAISE NOTICE 'ok  recorded  F3 the caller still sees 23514 and the same message; F4 a suspense refusal is recorded with what it moved';
END $$;

-- ===========================================================================
-- F5 the recorder cannot reach the database: counted, then made explicit
-- ===========================================================================

-- the recorder's login is refused (a wrong password): dblink_connect fails
-- inside the refusing transaction, which is exactly the path that must never
-- change or block the refusal
CREATE TEMP TABLE fx_secret AS
  SELECT secret FROM vault.secrets WHERE name = 'ca_ledger_refusal_recorder_conninfo';
UPDATE vault.secrets SET secret = regexp_replace(secret, 'password=\S+', 'password=not_the_password')
 WHERE name = 'ca_ledger_refusal_recorder_conninfo';

DO $$
DECLARE v text; c record; n integer; r record;
BEGIN
  -- the watch's first pass only notes how far the counter has reached
  PERFORM public.fn_ca_ledger_invariant_refusal_watch();

  v := pg_temp.refusal_seen($q$ UPDATE public.table_seats SET stack = stack + 7 WHERE id = '55555555-0000-0000-0000-000000000002' $q$);
  IF v NOT LIKE '23514 REFUSED: balance_moved_without_its_ledger_row account=table_stack%balance_delta=7.00 ledger_net=0.00' THEN
    RAISE EXCEPTION 'FIXTURE: F5 an unreachable recorder changed the refusal: %', v;
  END IF;
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 5 OR c.recorded <> 4 OR c.unrecorded <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: F5 the counter did not count the unrecorded refusal: %', to_jsonb(c);
  END IF;

  -- counter 5 was taken after the first pass: the next pass leaves it its interval
  n := public.fn_ca_ledger_invariant_refusal_watch();
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_refusals WHERE counter_no = 5) THEN
    RAISE EXCEPTION 'FIXTURE: F5 the watch judged a refusal unrecorded before its interval had passed';
  END IF;
  n := public.fn_ca_ledger_invariant_refusal_watch();
  SELECT * INTO r FROM public.ca_ledger_invariant_refusals WHERE counter_no = 5;
  IF n <> 1 OR r.kind <> 'unrecorded' OR r.incident_id IS NULL
     OR (SELECT severity FROM public.ca_drift_incidents WHERE id = r.incident_id) <> 'critical'
     OR (SELECT dedupe_key FROM public.ca_drift_incidents WHERE id = r.incident_id) <> 'ledger-invariant-refusal-unrecorded' THEN
    RAISE EXCEPTION 'FIXTURE: F5 the lost record did not become an explicit unrecorded row and incident: n=% %', n, to_jsonb(r);
  END IF;
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 5 OR c.unrecorded <> 1 THEN
    RAISE EXCEPTION 'FIXTURE: F5 the census hid the unrecorded refusal: %', to_jsonb(c);
  END IF;
  RAISE NOTICE 'ok  counted   F5 recorder unreachable: refusal unchanged, counter 5, the watch filed an explicit unrecorded row and a critical incident';
END $$;

UPDATE vault.secrets SET secret = (SELECT secret FROM fx_secret) WHERE name = 'ca_ledger_refusal_recorder_conninfo';

-- ===========================================================================
-- F6 a late record replaces the placeholder
-- ===========================================================================

DO $$
DECLARE c record;
BEGIN
  PERFORM public.fn_ca_ledger_refusal_file(jsonb_build_object(
    'counter_no', 5, 'kind', 'balance_moved_without_its_ledger_row',
    'account_key', 'table_stack:fixture', 'balance_delta', 7, 'ledger_net', 0, 'rpc', 'late'));
  SELECT * INTO c FROM public.fn_ca_ledger_invariant_refusal_census();
  IF c.counted <> 5 OR c.recorded <> 5 OR c.unrecorded <> 0
     OR (SELECT kind FROM public.ca_ledger_invariant_refusals WHERE counter_no = 5) <> 'balance_moved_without_its_ledger_row' THEN
    RAISE EXCEPTION 'FIXTURE: F6 a late record did not replace its placeholder: %', to_jsonb(c);
  END IF;
  RAISE NOTICE 'ok  replaced  F6 a late record replaces the unrecorded placeholder';
END $$;

-- ===========================================================================
-- F7 the recorder's login can file a refusal and nothing else
-- ===========================================================================

DO $$
DECLARE v_ok int := 0;
BEGIN
  PERFORM set_config('role', 'ca_ledger_refusal_recorder', true);
  BEGIN
    INSERT INTO public.ca_ledger_invariant_refusals (kind) VALUES ('unrecorded');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  BEGIN
    PERFORM count(*) FROM public.ca_ledger_invariant_refusals;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  BEGIN
    PERFORM public.fn_ca_ledger_refusal_record('{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  BEGIN
    UPDATE public.club_members SET chip_balance = chip_balance WHERE false;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  PERFORM set_config('role', 'none', true);
  IF v_ok <> 4 THEN
    RAISE EXCEPTION 'FIXTURE: F7 the recorder login reached something other than its two doors (% of 4 refused)', v_ok;
  END IF;
  RAISE NOTICE 'ok  confined  F7 the recorder login cannot read or write a table or call the recorder itself';
END $$;
