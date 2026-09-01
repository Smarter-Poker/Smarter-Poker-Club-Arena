-- ═══════════════════════════════════════════════════════════════════════════
-- THE RECONCILE LOG ADMITS A VIP-BASIS AND A ROLLUP-PARITY FINDING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. This session was read-only against production (SELECTs only),
-- so every file in this set ships unapplied and the New-Migration CI gate will
-- be red until somebody with write authority applies them. That is stated in
-- the pull request rather than hidden here.
--
-- The vocabulary change comes first and alone, for the reason
-- 20260831141042 wrote down after learning it the hard way: entity_type
-- carries a CHECK listing every finding type the log knows about, and that
-- closed list is a feature -- it is what stops a typo inventing a silent
-- category nobody greps for. So it is widened once, deliberately, ahead of the
-- two migrations that write the new kinds, and never dropped.
--
-- THREE NEW KINDS.
--
--   vip_points_basis            VIP credit awarded from rake, over a window,
--                               does not equal the rake taken in that window.
--                               This is the alarm for the defect fixed in
--                               20260901090200: the DEALT_EQUAL branch of
--                               fn_award_vip_points_from_rake awarded each
--                               player's CONTRIBUTION TO THE POT instead of
--                               their share of the RAKE, so the ratio of
--                               credit to rake ran at 31.95 where the correct
--                               branch runs at 1.00.
--
--   vip_award_failed            One VIP credit could not be written. The old
--                               trigger caught every error and said CONTINUE,
--                               so this class of failure has never once been
--                               visible. It is filed rather than raised
--                               because the trigger hangs off the rake write
--                               and a VIP point may not cost a club its rake
--                               row.
--
--   club_tournament_fee_parity  ca_club_tournament_daily.fee disagrees with
--                               what the published attribution rule says it
--                               should be. Measured 2026-09-01 across the
--                               whole table: 144 of 108,507 (club, tournament,
--                               day) rows drift, +193.21 chips net.
--
-- SEVERITY VOCABULARY IS ('ok','warn','critical'). Written down again here
-- because it is the mistake 20260831141042 made and the one an author reaching
-- for 'warning' will make next.
--
-- The incident router is extended in the same transaction so these three
-- arrive as a classified incident rather than as 'unknown'. Its body below is
-- production's current definition read back with pg_get_functiondef on
-- 2026-09-01 (md5 0467d0708ef681cba83b8ee278c4c78e), with three CASE arms and
-- one dedupe key added and nothing else touched -- the repo's copy in
-- 20260831142753 is older than the database and must not be used as the base.
--
-- NOT VALID then VALIDATE so the catalogue change takes ACCESS EXCLUSIVE only
-- briefly and the existing rows are re-checked under a lock that does not
-- block readers.

BEGIN;

SET LOCAL lock_timeout = '4s';

ALTER TABLE public.ledger_reconcile_log
  DROP CONSTRAINT ledger_reconcile_log_entity_type_check;

ALTER TABLE public.ledger_reconcile_log
  ADD CONSTRAINT ledger_reconcile_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'player_wallet','club_treasury','agent_wallet','frozen_wallets_pool',
    'chip_circulation','seat_stack_exit','cashout_escrow_stuck',
    'negative_balance','over_claimed_send','insurance_bank',
    'insurance_offer_unresolved','bomb_award_ledger_gap',
    'rake_law',
    'vip_points_basis','vip_award_failed','club_tournament_fee_parity'
  ])) NOT VALID;

ALTER TABLE public.ledger_reconcile_log
  VALIDATE CONSTRAINT ledger_reconcile_log_entity_type_check;

CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_log_to_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_class text;
  v_layer text;
  v_club uuid;
BEGIN
  IF NEW.severity NOT IN ('warn','critical') THEN RETURN NEW; END IF;

  v_class := CASE NEW.entity_type
    WHEN 'club_treasury'          THEN 'treasury_error'
    WHEN 'frozen_wallets_pool'    THEN 'unauthorized_adjustment'
    WHEN 'seat_stack_exit'        THEN 'missing_payment'
    WHEN 'negative_balance'       THEN 'ledger_imbalance'
    WHEN 'insurance_bank'         THEN 'settlement_error'
    WHEN 'insurance_offer_unresolved' THEN 'settlement_error'
    WHEN 'cashout_escrow_stuck'   THEN 'settlement_error'
    WHEN 'over_claimed_send'      THEN 'duplicate_payment'
    WHEN 'bomb_award_ledger_gap'  THEN 'reporting_mismatch'
    WHEN 'rake_law'               THEN 'reporting_mismatch'
    WHEN 'vip_points_basis'       THEN 'incorrect_rake'
    WHEN 'vip_award_failed'       THEN 'missing_payment'
    WHEN 'club_tournament_fee_parity' THEN 'reporting_mismatch'
    ELSE 'unknown' END;
  v_layer := CASE NEW.entity_type
    WHEN 'bomb_award_ledger_gap' THEN 'reporting'
    WHEN 'rake_law'              THEN 'reporting'
    WHEN 'vip_points_basis'      THEN 'projection'
    WHEN 'vip_award_failed'      THEN 'projection'
    WHEN 'club_tournament_fee_parity' THEN 'reporting'
    ELSE 'ledger' END;
  BEGIN
    v_club := NULLIF(NEW.metadata->>'club_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_club := NULL; END;
  IF v_club IS NULL AND NEW.entity_type = 'club_treasury' THEN
    v_club := NEW.entity_id;
  END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source          => 'ledger_reconcile_log:' || COALESCE(NEW.metadata->>'source',
                                                             NEW.metadata->>'kind', '?'),
    p_classification  => v_class,
    p_severity        => CASE NEW.severity WHEN 'critical' THEN 'critical' ELSE 'warning' END,
    p_dedupe_key      => 'lrl:' || NEW.entity_type || ':' || COALESCE(NEW.entity_id::text,'-')
                          || ':' || COALESCE(NEW.metadata->>'exit_id',
                                             NEW.metadata->>'hand_history_id',
                                             NEW.metadata->>'hand_id',
                                             NEW.metadata->>'escrow_id',
                                             NEW.metadata->>'parity_key', ''),
    p_discrepancy     => COALESCE(NEW.stored_balance,0) - COALESCE(NEW.ledger_balance,0),
    p_expected        => NEW.ledger_balance,
    p_actual          => NEW.stored_balance,
    p_layer           => v_layer,
    p_entity_type     => NEW.entity_type,
    p_entity_id       => NEW.entity_id,
    p_club_id         => v_club,
    p_suspected_cause => COALESCE(NEW.metadata->>'rule', NEW.metadata->>'kind'),
    p_metadata        => COALESCE(NEW.metadata,'{}'::jsonb));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_reconcile_log_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $function$;

COMMIT;
