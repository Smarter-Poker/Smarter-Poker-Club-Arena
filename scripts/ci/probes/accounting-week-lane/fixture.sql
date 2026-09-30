-- A faithful model of the weekly accounting lock discipline, and nothing else.
--
-- Two tables stand for the real pair: the close writes the run row, and every
-- accrual reads it to refuse a closed week, then writes its own disjoint row.
CREATE TABLE accounting_routed_settlement_runs(
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  standalone_club_id uuid
);
CREATE TABLE accounting_cash_rake_sources(
  rake_record_id uuid PRIMARY KEY,
  club_id uuid NOT NULL,
  rake_credit numeric NOT NULL
);

-- The accrual. p_shared selects the lock mode so one fixture can run the
-- before and the after; production has no such switch, it is simply shared.
CREATE FUNCTION accrue(p_rake uuid, p_club uuid, p_lock_key text, p_shared boolean, p_work numeric)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_shared THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock_key,0));
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(p_lock_key,0));
  END IF;
  IF EXISTS(SELECT 1 FROM accounting_routed_settlement_runs r WHERE r.standalone_club_id=p_club) THEN
    RAISE EXCEPTION 'cash_accrual_closed_period_requires_adjustment' USING ERRCODE='23514';
  END IF;
  PERFORM pg_sleep(p_work);
  INSERT INTO accounting_cash_rake_sources VALUES(p_rake,p_club,1);
END $$;

-- The weekly close. It stays exclusive in production and here.
CREATE FUNCTION close_week(p_club uuid, p_lock_key text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_lock_key,0));
  INSERT INTO accounting_routed_settlement_runs VALUES(now(),now()+interval '7 days',p_club);
END $$;

-- The settle -> recognition chain: two guards, one key, one transaction. In
-- production fn_settle_tournament_rake calls
-- fn_lock_accounting_tournament_recognition_week. If one of those two were
-- left exclusive the chain would request an upgrade of its own shared hold.
CREATE FUNCTION settle_then_recognize(p_lock_key text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock_key,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(p_lock_key,0));
END $$;
