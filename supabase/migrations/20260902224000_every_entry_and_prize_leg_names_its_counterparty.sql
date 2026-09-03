-- ===============================================================================
--  EVERY ENTRY AND PRIZE LEG NAMES ITS COUNTERPARTY
--  Chip Accounting Roadmap Phase 1.2 + 1.3 (docs/CHIP-ACCOUNTING-ROADMAP.md), R9
-- ===============================================================================
--
-- DECLARATION ONLY. No balance write moves, no amount changes, no recipient
-- changes, no new refusal. The body below is the live fn_credit_and_log
-- (pg_get_functiondef, 2026-09-02 22:30 UTC, prosrc md5 320090dd647b849719b960ab8d025f5f,
-- 5,904 bytes) with lines ADDED around the one wallet credit; `diff live new`
-- shows additions only. Grants are untouched (CREATE OR REPLACE keeps the ACL:
-- postgres and service_role EXECUTE only).
--
-- Where this sits: 20260902220500_the_undeclared_legs_name_their_counterparty and
-- 20260902221500_the_horse_door_declares_the_same_way (applied 22:05 and 22:08 UTC)
-- declared the ENTRY legs (both registration doors, the rebuy core, the spin prize
-- draw, the BBJ promo sweeps). Measured after them, 22:09-22:29 UTC: 0 rows to or
-- from settlement_suspense, 0 undeclared `adjustment` rows, entries journaled as
-- `tournament_buyin player_wallet -> prize_liability` with the tournament stamped.
-- What was still landing on a phantom counterparty was the PAYOUT side:
--
--   tournament_prize  table_stack -> player_wallet   8,419 rows / 423,911.80 per 24h
--   bounty            table_stack -> player_wallet      85 rows /     728.74
--   refund            table_stack -> player_wallet     381 rows /   8,732.00
--
-- All three come through fn_credit_and_log, the one credit funnel the obligation
-- settle (fn_settle_tournament_obligation) and its Phase 1.1 adopters use. The
-- funnel already declares app.ledger_category and app.ledger_tournament; it did
-- not declare app.ledger_counterparty, so fn_club_members_ledger_writer used its
-- `table_stack` default. Declared here, in the funnel, because it is the ONLY
-- place every tournament credit passes and because fn_settle_tournament_obligation
-- itself is Phase 1.1's function (PR #2721) and is not touched.
--
-- Counterparty: `prize_liability`, entity = the tournament. The entry legs book the
-- whole charge (prize + bounty + fee) into prize_liability because one wallet write
-- is one ledger row (there is no `fee_liability` word and no second write to hang
-- it on); paying places, bounties and refunds against the same account keeps
-- prize_liability at zero per tournament over its life. `bounty_liability` and
-- `refund_payable` exist in the vocabulary and sit in the same trial-balance group
-- (tournament_liability); using them here would leave prize_liability permanently
-- over-credited by the bounty and refund amounts. When Phase 5 makes the escrow a
-- real three-column balance the words split with it.
--
-- Only a tournament credit is declared: an entity AND a category in
-- (tournament_prize, bounty, refund, tournament_refund). fn_payout_leaderboard,
-- the other caller, keeps whatever it declares. set_config, never the raising
-- primitive: a payout must never be refused by a ledger word (SWARM-BRIEF-R2 rule
-- 13); the writer trigger falls back to its default on its own. The caller's
-- counterparty settings are saved before and restored after the credit.

BEGIN;

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
  v_prev_cp text;
  v_prev_cp_entity text;
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

  /* ---------------------------------------------------------------------
     EVERY PRIZE LEG NAMES ITS COUNTERPARTY (2026-09-02, roadmap 1.2 + 1.3)

     This is the one funnel every tournament credit passes through (the
     obligation settle for places, bounties and refunds). The category and
     the tournament were already declared here; the counterparty was not,
     so the wallet-side auto-ledger fell back to its `table_stack` default
     and 8,419 rows / 423,911.80 a day of tournament prizes read as chips
     coming off a felt that never held them.

     The money comes out of the tournament's escrow, which the entry legs
     book as `prize_liability` (the whole charge: prize + bounty + fee, one
     wallet write, one row). Paying places, bounties and refunds against the
     SAME account keeps prize_liability at zero per tournament over its
     life, which is the property an auditor can sum. Only a tournament
     credit (an entity and one of the tournament categories) is declared;
     any other caller keeps whatever it declared itself. set_config, never
     the raising primitive: a payout must never be refused by a ledger word,
     and the writer trigger falls back on its own. The caller's own settings
     are saved and restored so nothing later in the transaction inherits
     them.
     --------------------------------------------------------------------- */
  v_prev_cp        := current_setting('app.ledger_counterparty', true);
  v_prev_cp_entity := current_setting('app.ledger_counterparty_entity', true);
  IF p_related_entity_id IS NOT NULL
     AND v_ledger_cat IN ('tournament_prize', 'bounty', 'refund', 'tournament_refund') THEN
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_related_entity_id::text, true);
  END IF;

  v_credited := public.fn_credit_player_wallet_once(p_user_id, p_amount, p_idempotency_key);

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_tournament', '', true);
  PERFORM set_config('app.ledger_counterparty', COALESCE(v_prev_cp, ''), true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_prev_cp_entity, ''), true);

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

-- Post-apply assertions: the declaration is live, nothing else changed.
DO $$
DECLARE
  v_src text;
  v_raises int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_credit_and_log' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_credit_and_log is missing after apply';
  END IF;
  IF v_src NOT LIKE '%set_config(''app.ledger_counterparty'', ''prize_liability'', true)%' THEN
    RAISE EXCEPTION 'fn_credit_and_log does not declare prize_liability';
  END IF;
  IF v_src NOT LIKE '%set_config(''app.ledger_counterparty_entity'', p_related_entity_id::text, true)%' THEN
    RAISE EXCEPTION 'fn_credit_and_log does not name the tournament as the entity';
  END IF;
  IF v_src NOT LIKE '%set_config(''app.ledger_counterparty'', COALESCE(v_prev_cp, ''''), true)%' THEN
    RAISE EXCEPTION 'fn_credit_and_log does not restore the caller''s counterparty';
  END IF;
  IF v_src LIKE '%fn_ca_declare_ledger(%' THEN
    RAISE EXCEPTION 'fn_credit_and_log must not use the raising primitive';
  END IF;
  SELECT count(*) INTO v_raises FROM regexp_matches(v_src, 'RAISE EXCEPTION', 'g');
  IF v_raises <> 1 THEN
    RAISE EXCEPTION 'fn_credit_and_log RAISE EXCEPTION count changed: % (expected 1)', v_raises;
  END IF;
  -- the vocabulary word exists on both sides of the ledger CHECKs
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chip_ledger'::regclass
                    AND conname = 'chip_ledger_from_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%''prize_liability''%') THEN
    RAISE EXCEPTION 'prize_liability is not in chip_ledger_from_type_check';
  END IF;
  -- grants exactly as before: postgres and service_role only
  IF has_function_privilege('anon', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_and_log grant widened';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_credit_and_log lost its service_role grant';
  END IF;
END $$;

COMMIT;
