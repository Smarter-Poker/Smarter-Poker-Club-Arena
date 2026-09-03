-- ===========================================================================
-- R3, LOG-ONLY: A TOURNAMENT CREDIT THAT DID NOT COME THROUGH THE SETTLE
-- FUNCTION IS WRITTEN DOWN, NEVER REFUSED
-- Chip Accounting Standard, Lane A3 (obligations), 2026-09-02.
-- docs/CHIP-ACCOUNTING-STANDARD.md section 3.3, rule R3.
--
-- R3 says only one function may credit a player from a tournament. The
-- enforcing form of that rule (a BEFORE trigger that refuses the row) could
-- refuse a legitimate live payout while the engine is still being deployed
-- on the obligation path, so under Dan's risk rule this ships LOG-ONLY:
--
--   * `ca_money_path_violations` records every wallet_transactions credit in a
--     tournament category (prize, bounty, refund, tournament_prize,
--     tournament_refund, tourney*) that was NOT stamped
--     app.money_path = 'fn_settle_tournament_obligation' by the settle
--     function, with the login role and application_name that wrote it.
--   * One INFO drift incident per category per hour (dedupe key
--     r3:<category>:<hour>) keeps it visible on the incident board without
--     paging anyone.
--   * The trigger NEVER refuses: every statement in it is wrapped so that a
--     failure inside the logger cannot roll back the credit it is watching.
--
-- Expected volume while the old engine path is still live: several hundred
-- 'prize' rows an hour. That is the measurement, not a defect - the log
-- empties as each payer moves onto the settle path. Turning this trigger
-- into a refusal is a separate, Dan-gated step (docs/changelog/
-- 2026-09-02-chip-std-db-payers.md).
--
-- Own migration because it takes a lock on wallet_transactions, a hot table:
-- SET LOCAL lock_timeout so a busy moment fails this apply, never a payout.
-- ===========================================================================
BEGIN;
SET LOCAL lock_timeout = '4s';

CREATE TABLE IF NOT EXISTS public.ca_money_path_violations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at                timestamptz NOT NULL DEFAULT now(),
  table_name        text NOT NULL,
  user_id           uuid,
  amount            numeric(15,2),
  category          text,
  description       text,
  related_entity_id uuid,
  money_path        text,
  app_name          text,
  db_role           text
);

COMMENT ON TABLE public.ca_money_path_violations IS
  'R3 log-only (Lane A3, 2026-09-02): tournament-category wallet credits that did not come through fn_settle_tournament_obligation. Written by trg_ca_money_path_log on wallet_transactions. Never refuses. db_role is the login role (session_user): authenticator = PostgREST, postgres = psql/migration.';

CREATE INDEX IF NOT EXISTS ca_money_path_violations_at_idx
  ON public.ca_money_path_violations (at DESC);
CREATE INDEX IF NOT EXISTS ca_money_path_violations_entity_idx
  ON public.ca_money_path_violations (related_entity_id, at DESC);

ALTER TABLE public.ca_money_path_violations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_money_path_violations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ca_money_path_violations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path = 'fn_settle_tournament_obligation' THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_money_path_log() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_money_path_log ON public.wallet_transactions;
CREATE TRIGGER trg_ca_money_path_log
  AFTER INSERT ON public.wallet_transactions
  FOR EACH ROW
  WHEN (NEW.type = 'credit'
        AND (lower(COALESCE(NEW.category, '')) IN ('prize','bounty','refund','tournament_prize','tournament_refund')
             OR lower(COALESCE(NEW.category, '')) LIKE 'tourney%'))
  EXECUTE FUNCTION public.fn_ca_money_path_log();

COMMENT ON TRIGGER trg_ca_money_path_log ON public.wallet_transactions IS
  'R3 LOG-ONLY (Lane A3, 2026-09-02): records tournament-category credits made outside fn_settle_tournament_obligation in ca_money_path_violations. Never refuses. Enforcement is a separate, Dan-gated step.';

DO $chk$
DECLARE v_en "char"; v_rls boolean;
BEGIN
  SELECT tgenabled INTO v_en FROM pg_trigger
   WHERE tgrelid = 'public.wallet_transactions'::regclass AND tgname = 'trg_ca_money_path_log';
  IF v_en IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'ASSERT: trg_ca_money_path_log must exist and be enabled, tgenabled=%', v_en;
  END IF;
  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.ca_money_path_violations'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'ASSERT: ca_money_path_violations must have RLS enabled';
  END IF;
  IF has_table_privilege('authenticated', 'public.ca_money_path_violations', 'SELECT') THEN
    RAISE EXCEPTION 'ASSERT: authenticated must not read ca_money_path_violations';
  END IF;
  IF position('RAISE EXCEPTION' IN (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_money_path_log')) > 0 THEN
    RAISE EXCEPTION 'ASSERT: the R3 logger must never refuse';
  END IF;
  RAISE NOTICE 'chip-std lane A3: R3 logger present, enabled, log-only';
END $chk$;

COMMIT;
