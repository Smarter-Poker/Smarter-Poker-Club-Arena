-- 2026-08-31 — MTT Phase 3: the record reads the place from the key.
--
-- 20260831133423 recorded every prize but left `position` NULL unless a caller
-- passed one, and no caller did. Rather than edit twelve engine call sites —
-- which would still have missed the seven SQL payout paths that cannot be
-- passed a parameter — the record now derives the finishing place and the kind
-- of payment from the idempotency key, through fn_tournament_payout_shape.
--
-- That is the SAME function the historical backfill uses, so a row written
-- today and a row reconstructed from March cannot describe the same kind of
-- payment differently. Explicit parameters still override it, for any future
-- path whose key does not encode a place.
--
-- PROVEN, NOT ASSERTED (probe inside a rolled-back transaction, four credits
-- through the engine's own six-named-argument call shape):
--   structure/pos=3/amt=42.50   place read from ':prize:place:3'
--   hu_shortfall/pos=-/amt=9.00 correctly no place
--   bounty/pos=-/amt=5.00       correctly no place
--   a CASH credit wrote NO payout record
--   the same key twice: first call true, second false, ONE record
--
-- TIER: 3 (money path). ROLLBACK: re-apply 20260831133423.

BEGIN;

SET LOCAL lock_timeout = '8s';

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
  v_shape_source text;
  v_shape_place integer;
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

  /* THE PAYOUT RECORD.

     v_credited is true here, so this runs exactly once per movement of money —
     a retry of a credit that already happened returned false above and never
     reaches this point. */
  IF lower(COALESCE(p_category, '')) = 'prize' AND p_related_entity_id IS NOT NULL THEN
    BEGIN
      SELECT t.id, t.tournament_type, t.prize_pool, t.payout_structure
        INTO v_t
        FROM public.tournaments t
       WHERE t.id = p_related_entity_id;

      IF FOUND THEN
        SELECT s.source, s.place INTO v_shape_source, v_shape_place
          FROM public.fn_tournament_payout_shape(p_idempotency_key) s;

        SELECT count(*) INTO v_field
          FROM public.tournament_players tp
         WHERE tp.tournament_id = v_t.id;

        INSERT INTO public.tournament_payouts
          (tournament_id, user_id, "position", amount, source, idempotency_key,
           paid_at, tournament_type, field_size, prize_pool, payout_structure,
           recorded_by)
        VALUES
          (v_t.id, p_user_id,
           COALESCE(p_payout_position, v_shape_place),
           p_amount,
           COALESCE(p_payout_source, v_shape_source, 'unclassified'),
           p_idempotency_key,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
