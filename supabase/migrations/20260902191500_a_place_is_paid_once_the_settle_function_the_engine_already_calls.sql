-- ═══════════════════════════════════════════════════════════════════════════════
--  A PLACE IS PAID ONCE: THE SETTLE FUNCTION THE ENGINE ALREADY CALLS
--  Chip Accounting Standard, Lane A bridge (docs/CHIP-ACCOUNTING-STANDARD.md
--  section 3.2 MTT step 5, rule R2). 2026-09-02, one transaction, applied once.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS TODAY AND NOT NEXT WEEK. PR #2671 (Lane A2) repointed every
-- engine tournament credit at `fn_settle_tournament_obligation` and was merged
-- at 17:46 UTC with its do-not-merge label still on; the 18:41 Hetzner build
-- carried it and the 18:55 maintenance break cut it over. The function did not
-- exist. From that moment the next MTT finish would raise `prize_credit_failed`
-- and pay nobody until the hourly reconciler noticed. This file is the
-- function, built on the primitives production already trusts, so the engine
-- pays again within one apply.
--
-- WHAT IT IS. The obligation ledger and the ONE settle function from the
-- standard, without the escrow account (that is the full Lane A migration,
-- 4,189 lines rewriting twenty money functions, which Dan's ruling on risk
-- keeps out of production until it has been reviewed piece by piece). Every
-- rule that stops a double payment is here:
--
--   R2  UNIQUE (tournament_id, kind, place) - a place is paid once whoever
--       holds it and whichever arm asks. `late_reg_adjustment` shares the
--       place row, so a top-up passes the NEW total and pays the difference.
--   R2b A finisher holds one place: a second `place` obligation paid to a user
--       who already collected another place in the same event is refused
--       (the 2026-09-01 guard in fn_credit_and_log, kept in the new shape).
--   R1-lite  The prize-pool kinds cannot, in total, exceed tournaments.prize_pool
--       (the counter the supply snapshot already trusts) plus 0.05 rounding.
--       A payout that would breach it is REFUSED with refused_reason
--       'escrow_short' and a critical alert - never minted. The reconciler
--       and the four-eyes path settle what is genuinely owed.
--   Legacy seeding  The first time an obligation row is created for a place,
--       amount_paid starts at what tournament_payouts already shows for that
--       place under the old `tourney:<t>:prize:place:<N>` keys, so an event
--       that straddles the deploy is not paid twice by the new key shape.
--   Kill switch  If Lane E's ca_payout_freeze holds an open row for scope
--       'tournament_payouts', the function refuses with 'payout_frozen'.
--
-- WHAT IT IS NOT. It does not move chips into or out of an escrow balance;
-- the credit still lands through fn_credit_and_log (wallet_credit_idempotency
-- key, wallet_transactions row, tournament_payouts record, autoledger). When
-- the full Lane A migration lands it REPLACES this function body with the
-- escrow-debiting one; the table, the indexes and the signature are the
-- shared interface in docs/SWARM-BRIEF-CHIP-STANDARD.md and do not change.
--
-- Probe (rolled back, transcript in the PR): settle place 3 twice under two
-- sources -> second call ok:true paid:0 already_paid:<first>; settle a place
-- that would exceed prize_pool -> ok:false refused_reason:'escrow_short',
-- wallet unchanged; late_reg_adjustment with a larger total -> pays only the
-- difference; replay of the same call -> paid 0.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.tournament_obligations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'place','bounty','bounty_residual','mystery_bounty','refund','seat',
                   'satellite_remainder','bubble_protection','final_table_deal',
                   'late_reg_adjustment')),
  place          integer,
  user_id        uuid,
  amount_owed    numeric(15,2) NOT NULL DEFAULT 0 CHECK (amount_owed >= 0),
  amount_paid    numeric(15,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0 AND amount_paid <= amount_owed),
  source         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  CHECK (place IS NOT NULL OR user_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tournament_obligations_place
  ON public.tournament_obligations (tournament_id, kind, place) WHERE place IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tournament_obligations_user
  ON public.tournament_obligations (tournament_id, kind, user_id) WHERE place IS NULL;
CREATE INDEX IF NOT EXISTS ix_tournament_obligations_tournament
  ON public.tournament_obligations (tournament_id);

ALTER TABLE public.tournament_obligations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_obligations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tournament_obligations TO service_role;

COMMENT ON TABLE public.tournament_obligations IS
  'What a tournament owes and what it has paid, one row per (tournament, kind, place|user). '
  'Written only by fn_settle_tournament_obligation. Chip Accounting Standard R2.';

-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind          text,
  p_place         integer,
  p_user_id       uuid,
  p_amount        numeric,
  p_source        text,
  p_description   text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind        text := lower(btrim(COALESCE(p_kind, '')));
  v_row_kind    text;
  v_place       integer;
  v_amount      numeric := round(COALESCE(p_amount, 0), 2);
  v_t           record;
  v_ob          public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_owed        numeric;
  v_pay         numeric;
  v_key         text;
  v_category    text;
  v_desc        text;
  v_pool_kinds  text[] := ARRAY['place','late_reg_adjustment','bubble_protection','final_table_deal','satellite_remainder','seat'];
  v_paid_pool   numeric := 0;
  v_credited    boolean;
  v_alert_ctx   jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'missing_ids', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_kind NOT IN ('place','bounty','bounty_residual','mystery_bounty','refund','seat',
                    'satellite_remainder','bubble_protection','final_table_deal','late_reg_adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'unknown_kind', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF v_amount < 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'negative_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- A late-registration top-up is the SAME obligation as the place it corrects:
  -- it carries the new total and the difference is what moves.
  v_row_kind := CASE WHEN v_kind = 'late_reg_adjustment' THEN 'place' ELSE v_kind END;
  v_place    := CASE WHEN v_row_kind IN ('place') THEN p_place ELSE NULL END;
  IF v_row_kind = 'place' AND v_place IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'place_required', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Kill switch (Lane E): an open freeze on tournament payouts refuses everything.
  IF to_regclass('public.ca_payout_freeze') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'payout_frozen', 'obligation_id', NULL, 'idempotency_key', NULL);
    END IF;
  END IF;

  SELECT t.id, t.name, t.club_id, t.prize_pool, t.bounty_pool, t.bounty_pool_paid, t.status
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'tournament_not_found', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Upsert the obligation. amount_owed only ever rises.
  IF v_place IS NOT NULL THEN
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place = v_place
     FOR UPDATE;
  ELSE
    SELECT * INTO v_ob FROM public.tournament_obligations
     WHERE tournament_id = p_tournament_id AND kind = v_row_kind AND place IS NULL AND user_id = p_user_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    -- Legacy seeding: what did the old key shapes already pay for this obligation?
    IF v_place IS NOT NULL THEN
      SELECT COALESCE(sum(tp.amount), 0) INTO v_seeded_paid
        FROM public.tournament_payouts tp
       WHERE tp.tournament_id = p_tournament_id AND tp."position" = v_place
         AND COALESCE(tp.source, '') NOT IN ('satellite_seat');
    ELSIF v_row_kind = 'refund' THEN
      SELECT COALESCE(sum(w.amount), 0) INTO v_seeded_paid
        FROM public.wallet_transactions w
       WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
         AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    END IF;
    v_seeded_paid := round(v_seeded_paid, 2);
    v_owed := GREATEST(v_amount, v_seeded_paid);

    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES (p_tournament_id, v_row_kind, v_place, p_user_id, v_owed, v_seeded_paid, p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_amount > v_ob.amount_owed THEN
      UPDATE public.tournament_obligations
         SET amount_owed = v_amount, updated_at = now(), user_id = COALESCE(user_id, p_user_id)
       WHERE id = v_ob.id
       RETURNING * INTO v_ob;
    END IF;
  END IF;

  -- The player on record for a place is whoever was first paid for it; a
  -- different user asking for an already-paid place gets a refusal, not chips.
  IF v_place IS NOT NULL AND v_ob.user_id IS NOT NULL AND v_ob.user_id <> p_user_id AND v_ob.amount_paid > 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'place_paid_to_another_user', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  v_pay := round(LEAST(v_amount, v_ob.amount_owed) - v_ob.amount_paid, 2);
  IF v_pay <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R2b: one finisher, one place.
  IF v_row_kind = 'place' THEN
    IF EXISTS (SELECT 1 FROM public.tournament_obligations o
                WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
                  AND o.user_id = p_user_id AND o.place <> v_place AND o.amount_paid > 0) THEN
      v_alert_ctx := jsonb_build_object('kind','second_place_prize_refused','tournament_id',p_tournament_id,
        'user_id',p_user_id,'place',v_place,'amount',v_pay,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused a second structure place: this player already holds a paid place in tournament %s', p_tournament_id),
        v_alert_ctx, 'obl:second_place:' || p_tournament_id::text || ':' || p_user_id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'player_already_holds_a_place', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  -- R1-lite: the prize-pool kinds cannot exceed the pool in total.
  IF v_row_kind = ANY (v_pool_kinds) THEN
    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid_pool
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id
       AND COALESCE(tp.source, '') NOT IN ('satellite_seat','bounty','mystery_bounty','bounty_residual');
    IF v_paid_pool + v_pay > COALESCE(v_t.prize_pool, 0) + 0.05 THEN
      v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
        'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
        'paid_from_pool_so_far',v_paid_pool,'prize_pool',v_t.prize_pool,'source',p_source);
      PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
        format('Refused %s to %s for %s: the prize pool of %s has already paid %s (%s)',
               v_pay, p_user_id, v_kind, round(COALESCE(v_t.prize_pool,0),2), v_paid_pool, v_t.name),
        v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
        'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
    END IF;
  END IF;

  v_key := 'obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;
  v_category := CASE
                  WHEN v_row_kind IN ('bounty','bounty_residual','mystery_bounty') THEN 'bounty'
                  WHEN v_row_kind = 'refund' THEN 'refund'
                  ELSE 'prize'
                END;
  v_desc := COALESCE(NULLIF(btrim(p_description), ''),
              CASE
                WHEN v_row_kind = 'place' THEN format('Tournament prize: position %s', v_place)
                WHEN v_row_kind = 'refund' THEN 'Tournament refund'
                ELSE format('Tournament %s', replace(v_row_kind, '_', ' '))
              END);

  PERFORM set_config('app.money_path', 'fn_settle_tournament_obligation', true);

  -- Guard against a key that was already spent while the obligation says otherwise:
  -- that means the obligation row was rebuilt without its payments, and paying
  -- again would be exactly the bug this function exists to end.
  IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key) THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation: key % already spent while obligation % shows paid %; refusing',
      v_key, v_ob.id, v_ob.amount_paid;
  END IF;

  v_credited := public.fn_credit_and_log(
    p_user_id, v_pay, v_key, v_category, v_desc, p_tournament_id,
    'PLAYER', NULL, NULL,
    CASE WHEN v_category = 'prize' THEN v_place ELSE NULL END,
    CASE WHEN v_category = 'prize' THEN COALESCE(NULLIF(p_source,''), 'obligation') ELSE NULL END);

  PERFORM set_config('app.money_path', '', true);

  IF NOT v_credited THEN
    -- fn_credit_and_log returns false only when the key was already spent or a
    -- guard inside it refused; either way no chips moved for THIS call.
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'credit_refused', 'obligation_id', v_ob.id, 'idempotency_key', v_key);
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         user_id     = COALESCE(user_id, p_user_id),
         source      = COALESCE(p_source, source),
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;

  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid)
  TO service_role, postgres;

COMMENT ON FUNCTION public.fn_settle_tournament_obligation(uuid, text, integer, uuid, numeric, text, text, uuid) IS
  'The one function that credits a player from a tournament. Upserts tournament_obligations, pays only what is still owed, '
  'refuses a second place for the same finisher and any total beyond the prize pool. Chip Accounting Standard R1-lite/R2.';

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_settle_tournament_obligation', 'approved',
        'Chip Accounting Standard: the single tournament settle path (obligations ledger). Engine callers since PR #2671.')
ON CONFLICT (proname) DO NOTHING;

-- Post-apply assertions.
DO $$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.tournament_obligations') IS NULL THEN
    RAISE EXCEPTION 'tournament_obligations missing';
  END IF;
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE tablename = 'tournament_obligations'
     AND indexname IN ('ux_tournament_obligations_place','ux_tournament_obligations_user');
  IF v_n <> 2 THEN RAISE EXCEPTION 'obligation unique indexes missing (%)', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_settle_tournament_obligation') THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation missing';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_routine_grants
              WHERE routine_name = 'fn_settle_tournament_obligation'
                AND grantee IN ('anon','authenticated','PUBLIC')) THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation is browser-reachable';
  END IF;
END $$;

COMMIT;
