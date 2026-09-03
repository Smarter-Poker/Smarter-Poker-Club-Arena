-- One finisher, one structure place.
--
-- fn_ca_duplicate_structure_payout_check flagged 30 finishers holding more
-- than one structure payout row. Chased to the money rather than the record:
-- 23 of them had wallet credits matching BOTH rows, so they really were paid
-- twice. Every one is the same shape - the WINNER paid first place and one
-- other place, seconds apart, from the two payout paths in
-- TournamentManagerEliminations.ts:
--
--   19:25:10  "Tournament prize: position 6"      60.00
--   19:25:26  "Tournament winner prize: 1st place" 300.00
--
-- Incidence by month, measured from the wallet credits: June 1, July 2,
-- August 20, September 0. All 23 are horses; no human was overpaid. Total
-- 394.30, newest 2026-08-20.
--
-- NO MONEY IS MOVED BY THIS CHANGE, and none is owed: every one of those
-- credits landed in the legacy public.wallets pool, not a club wallet -
-- balance_after on each transaction matches that row and not one has a
-- chip_ledger entry - and CLAUDE.md 11.5 records that pool as frozen since
-- 2026-08-21 with nothing reading it. Clawing 394.30 out of live club wallets
-- to settle a debt denominated in dead currency would have taken real chips
-- from players who never received spendable ones.
--
-- Two engine fixes already narrowed this. On 2026-07-28 the winner path and
-- the stuck-COMPLETING watchdog were made to share one key. On 2026-08-28 both
-- paths moved from a USER-scoped key (tourney:{id}:prize:{user}:{position}) to
-- a PLACE-scoped one (tourney:{id}:prize:place:{position}), so a place cannot
-- be paid twice to two different people.
--
-- But place-scoping does not close the case above. Place 6 and place 1 are
-- different places, so they are different keys, and the same player collects
-- both. The engine cannot dedupe its way out of it because at the moment it
-- paid place 6 it genuinely believed that was the finish.
--
-- So the invariant belongs here, in the one funnel both paths call: a player
-- may hold ONE structure place prize per tournament. A second one is refused
-- and alerted rather than paid.
--
-- SCOPE, measured before writing it. The predicate matches only keys of the
-- form tourney:<id>:prize:place:<n>:
--
--   * 13,080 such keys exist and NOT ONE user holds two in the same
--     tournament, so this refuses nothing that happens today;
--   * the tempting broader predicate (tourney:<id>:prize:%) would have
--     refused 9,453 legitimate second credits - heads-up shortfall top-ups
--     keyed ...:prize:<user>:hu_shortfall are a real second prize payment to
--     the same player. That predicate was rejected on the evidence.
--
-- Refusing returns false, which is the same answer this function already
-- gives when a credit was already made, so both callers treat it as the
-- no-op it is. Nothing raises and no tournament stalls. The alert is what
-- makes it loud.
--
-- Probed first in a rolled-back DO block: the same key returns true (the
-- existing idempotency store handles that case one layer down) and a
-- different place for the same player in the same tournament returns false.

CREATE OR REPLACE FUNCTION public.fn_credit_and_log(p_user_id uuid, p_amount numeric, p_idempotency_key text, p_category text, p_description text, p_related_entity_id uuid DEFAULT NULL::uuid, p_wallet_type text DEFAULT 'PLAYER'::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_payout_position integer DEFAULT NULL::integer, p_payout_source text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_credited boolean;
  v_ledger_cat text;
  v_t record;
  v_field integer;
  v_shape_source text;
  v_shape_place integer;
  v_tid text;
BEGIN
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key';
  END IF;

  /* ---------------------------------------------------------------------
     ONE FINISHER, ONE STRUCTURE PLACE (2026-09-01)

     A place cannot be paid twice - the place-scoped key settled that on
     2026-08-28. This settles the other half: a PLAYER cannot be paid two
     places in one tournament. Twenty-three winners were paid first place
     and one other place seconds apart between June and August, because the
     elimination path had already priced them for the finish it believed at
     the time and the winner path then paid them again under a different,
     equally valid key.

     Scoped to structure-place keys only. Heads-up shortfall top-ups and
     bounty credits use other key shapes and are untouched.
     --------------------------------------------------------------------- */
  IF lower(COALESCE(p_category, '')) = 'prize'
     AND p_idempotency_key LIKE 'tourney:%:prize:place:%' THEN
    v_tid := split_part(p_idempotency_key, ':', 2);
    IF EXISTS (
      SELECT 1 FROM public.wallet_credit_idempotency k
       WHERE k.user_id = p_user_id
         AND k.key LIKE 'tourney:' || v_tid || ':prize:place:%'
         AND k.key <> p_idempotency_key
    ) THEN
      BEGIN
        INSERT INTO public.financial_alerts (severity, source, message, context)
        VALUES ('critical', 'fn_credit_and_log',
          format('Refused a second structure place prize: this player already holds a place prize in tournament %s, and %s chips were about to be paid for another place',
                 v_tid, round(p_amount, 2)),
          jsonb_build_object('kind','second_place_prize_refused',
            'user_id', p_user_id, 'tournament_id', v_tid,
            'amount', round(p_amount, 2), 'refused_key', p_idempotency_key,
            'detail','a place cannot be paid twice and a finisher cannot place twice; no money was moved'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
      RETURN false;
    END IF;
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

  /* ---------------------------------------------------------------------
     THE PAYOUT RECORD (2026-08-31, MTT Phase 3)

     v_credited is true here, so this runs exactly once per movement of
     money - a retry of a credit that already happened returned false above
     and never reaches this point.

     The kind of payment and the finishing place are read from the key by
     fn_tournament_payout_shape, the SAME function the historical backfill
     uses, so a row written today and a row reconstructed from March cannot
     describe the same kind of payment differently. Explicit parameters
     override it, for any future path whose key does not encode a place.
     --------------------------------------------------------------------- */
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

-- Prove the guard is in and that it refuses nothing that exists today.
DO $$
DECLARE v_bad int; v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_credit_and_log';
  IF v_src NOT LIKE '%second_place_prize_refused%' THEN
    RAISE EXCEPTION 'the one-place-per-finisher guard is not in fn_credit_and_log';
  END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT split_part(key,':',2) tid, user_id
      FROM public.wallet_credit_idempotency
     WHERE key LIKE 'tourney:%:prize:place:%'
     GROUP BY 1,2 HAVING count(DISTINCT key) > 1) x;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'the guard would refuse % existing payment(s) - stop and re-measure', v_bad;
  END IF;
END $$;

-- Who may call the credit funnel, stated rather than left to be looked up.
-- Checked against production before writing it: anon, authenticated and PUBLIC
-- already have no execute here and service_role has it, and CREATE OR REPLACE
-- does not touch grants - so this is a no-op that makes the migration say what
-- is true. Also applied on its own as
-- 20260901135512_state_the_credit_funnel_is_service_role_only.
REVOKE ALL ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_and_log(uuid, numeric, text, text, text, uuid, text, uuid, uuid, integer, text) TO service_role;
