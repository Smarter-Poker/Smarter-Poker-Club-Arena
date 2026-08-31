-- 2026-08-31 — MTT Phase 3: every prize writes its own evidence.
--
-- WHY THIS IS IN fn_credit_and_log AND NOT IN THE ENGINE
--
-- Nineteen separate places move tournament prize money — twelve in the engine
-- (elimination places, the winner, the bounty pool, the mystery-bounty chest,
-- the late-registration adjustment, the final-table deal settlement, the
-- stuck-COMPLETING recovery watchdog, the satellite cash paths) and seven in
-- SQL. Every one of them funnels through this single function.
--
-- Writing the record at each call site would be nineteen chances for the
-- twentieth path to forget. This file's own comment history is a list of
-- exactly that failure: the seat release that was moved and silently killed
-- every bounty on the platform; the idempotency key that deduped a USER
-- instead of a PLACE and paid 120% of a pool. So the record is written where
-- the money is, once.
--
-- FAIL-OPEN ON THE RECORD, LOUDLY.
--
-- If the record cannot be written the credit still commits: a player unpaid
-- because bookkeeping failed is strictly worse than a payment with a missing
-- row, and the money is recoverable from wallet_credit_idempotency either way.
-- But it is NOT swallowed — it raises a financial_alerts row, because "a row
-- of zeroes is indistinguishable from perfect health" is the defect shape this
-- codebase keeps re-learning, and a payout record that quietly stopped filling
-- would look exactly like a platform with no payouts.
--
-- CASH IS UNTOUCHED. The record is written only when the category is a prize
-- AND the related entity is a real tournament row. Every cash settlement
-- caller keeps its existing behaviour and its existing signature.
--
-- THE OVERLOAD TRAP (read before editing this file).
--
-- CREATE OR REPLACE cannot add a parameter: a different argument list is a
-- different function, so replacing in place would leave TWO fn_credit_and_log
-- overloads standing. PostgREST resolves an RPC by ARGUMENT NAMES, and every
-- existing six-argument named call matches both — "function is not unique", on
-- every credit on the platform. So the nine-argument form is dropped and the
-- eleven-argument form created in the same transaction.
--
-- DROP also discards the ACL, which CREATE OR REPLACE would have preserved. A
-- freshly created function is EXECUTE-to-PUBLIC by default, and this one mints
-- money. The grants below restore exactly what proacl held beforehand:
-- postgres=X, service_role=X, and nothing else. Verified after applying.
--
-- (Superseded by 20260831133650, which reads the place and source from the key
-- through fn_tournament_payout_shape. Kept because it is what was applied.)
--
-- TIER: 3 (money path). ROLLBACK: drop the eleven-argument form and re-apply
-- the nine-argument body preserved in the migration that last defined it.

BEGIN;

SET LOCAL lock_timeout = '8s';

DROP FUNCTION IF EXISTS public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.fn_credit_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_category text,
  p_description text,
  p_related_entity_id uuid DEFAULT NULL::uuid,
  p_wallet_type text DEFAULT 'PLAYER'::text,
  p_table_id uuid DEFAULT NULL::uuid,
  p_hand_id uuid DEFAULT NULL::uuid,
  p_payout_position integer DEFAULT NULL::integer,
  p_payout_source text DEFAULT NULL::text
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_credited boolean;
  v_ledger_cat text;
  v_t record;
  v_field integer;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key';
  END IF;

  v_ledger_cat := CASE lower(COALESCE(p_category, ''))
                    WHEN 'prize'  THEN 'tournament_prize'
                    WHEN 'buyin'  THEN 'tournament_buyin'
                    WHEN ''       THEN 'adjustment'
                    ELSE lower(p_category)
                  END;

  PERFORM set_config('app.ledger_category', v_ledger_cat, true);
  IF p_related_entity_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_tournament', p_related_entity_id::text, true);
  END IF;

  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_tournament', '', true);

  IF NOT v_credited THEN
    RETURN false;
  END IF;

  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);

  IF lower(COALESCE(p_category, '')) = 'prize' AND p_related_entity_id IS NOT NULL THEN
    BEGIN
      SELECT t.id, t.tournament_type, t.prize_pool, t.payout_structure
        INTO v_t
        FROM public.tournaments t
       WHERE t.id = p_related_entity_id;

      IF FOUND THEN
        SELECT count(*) INTO v_field
          FROM public.tournament_players tp
         WHERE tp.tournament_id = v_t.id;

        INSERT INTO public.tournament_payouts
          (tournament_id, user_id, "position", amount, source, idempotency_key,
           paid_at, tournament_type, field_size, prize_pool, payout_structure,
           recorded_by)
        VALUES
          (v_t.id, p_user_id, p_payout_position, p_amount,
           COALESCE(p_payout_source, 'structure'), p_idempotency_key,
           now(), v_t.tournament_type, v_field, v_t.prize_pool,
           CASE WHEN v_t.payout_structure IS NULL THEN NULL
                ELSE jsonb_build_object('payout_structure', v_t.payout_structure) END,
           'credit_and_log')
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('critical', 'tournament_payout_record',
              'A tournament prize was paid but its payout record could not be written',
              jsonb_build_object(
                'tournament_id', p_related_entity_id,
                'user_id', p_user_id,
                'amount', p_amount,
                'position', p_payout_position,
                'idempotency_key', p_idempotency_key,
                'sqlstate', SQLSTATE,
                'sqlerrm', SQLERRM));
    END;
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_credit_and_log(
  uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(
  uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text)
  TO service_role;

/* PostgREST caches the function signature it resolves an RPC against. A DROP
   plus CREATE changes it, so tell PostgREST to reload rather than leave a
   window where every credit resolves against a function that no longer
   exists. */
NOTIFY pgrst, 'reload schema';

COMMIT;
