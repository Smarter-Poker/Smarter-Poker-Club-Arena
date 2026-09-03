-- ===========================================================================
-- DB PAYERS: EVERY REPAIR ARM SETTLES THROUGH fn_settle_tournament_obligation
-- Chip Accounting Standard, Lane A3 (obligations), 2026-09-02.
-- docs/CHIP-ACCOUNTING-STANDARD.md sections 2.2 (the eleven payers), 3.2
-- (MTT step 5) and 3.3 (R2, R3).
--
-- WHY. `tournament_obligations` and `fn_settle_tournament_obligation` have
-- been live since 19:16 UTC, and at 19:41 UTC none of the six DB-side payers
-- called it: the reconciler, the two guarantee sweeps, the spin and heads-up
-- back-pay arms and the final-table deal each still credited wallets on their
-- own key through fn_credit_and_log (or wrote tournament_payouts rows for the
-- engine to pay). That is the mechanism behind the 5,330 chips of MTT
-- overpayment measured in 2.2: arms that do not share a ledger of what is
-- OWED pay each other's obligations twice.
--
-- WHAT CHANGES (money movement only; every detector, filter, report shape
-- and alert each function carries is kept):
--   1. fn_tournament_obligation_paid_so_far - a read-only helper that returns
--      exactly the figure the settle function will treat as "already paid"
--      for an obligation (the obligation row if one exists, else its legacy
--      seed), so a caller that knows a SHORTFALL can hand the settle function
--      the TOTAL it expects.
--   2. fn_tournament_payout_reconcile - a place's top-up is settled as
--      kind 'place' with the FULL entitlement (p_amount = expected), source
--      'reconcile'. The settle function pays the difference, refuses replays,
--      refuses a second user on a paid place and refuses over-pool payments.
--      Rows written by the settle path (idempotency_key 'tourney:<id>:obl:%') count as
--      prize-pool money whatever their source label. A place that shows
--      wallet prizes but NO tournament_payouts record is reported, not
--      settled: the obligation ledger seeds from tournament_payouts, so
--      settling it would pay the wallet a second time.
--   3. fn_pay_backed_payout_shortfalls / fn_ca_backpay_guarantee_shortfalls -
--      already delegate distribution to the reconciler (verified against the
--      live body); they now report what the settle path actually PAID
--      (`total_settled`) rather than what the reconciler wanted.
--   4. fn_backpay_spin_unpaid_winners - kind 'place', place 1, p_amount =
--      paid-so-far + chips_short, source 'spin_backpay'.
--   5. fn_backpay_hu_winner_shortfalls - kind 'place', place 1, p_amount =
--      paid-so-far + delta, source 'hu_shortfall'. The prize_pool raise that
--      used to follow the credit now precedes the settle call (the settle
--      function caps against prize_pool) and is undone when nothing was paid.
--   6. fn_final_table_deal - kind 'final_table_deal', user-keyed. The function
--      no longer writes tournament_payouts rows for the engine to pay; the
--      settle function writes tournament_payouts + wallet_transactions itself
--      and the engine's settleFinalTableDeal, which settles the same
--      (tournament, kind, user, amount), lands on paid 0.
--
--   0. fn_settle_tournament_obligation - ONE line: the idempotency key becomes
--      'tourney:<tournament_id>:obl:<obligation_id>:<paid_cents>' so the club
--      wallet resolver credits the club the player bought in from. Found by
--      the rolled-back probe of this file (3 of 4 places went to the wrong
--      club under 'obl:%'); no 'obl:' key had been spent in production.
--
-- NOTHING here moves money by migration. No back-pay, no clawback. Every
-- probe was run inside a transaction that was rolled back (changelog
-- docs/changelog/2026-09-02-chip-std-db-payers.md).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What the settle function will treat as already paid for an obligation.
--    Mirrors the seeding rule inside fn_settle_tournament_obligation exactly:
--    an existing obligation row wins; otherwise a place seeds from
--    tournament_payouts by position (satellite seats excluded), a refund from
--    wallet_transactions refund credits, everything else from zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_obligation_paid_so_far(
  p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_kind text := lower(btrim(COALESCE(p_kind, '')));
  v_row_kind text;
  v_paid numeric;
BEGIN
  v_row_kind := CASE WHEN v_kind = 'late_reg_adjustment' THEN 'place' ELSE v_kind END;

  IF v_row_kind = 'place' THEN
    SELECT o.amount_paid INTO v_paid
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place' AND o.place = p_place;
    IF FOUND THEN RETURN round(COALESCE(v_paid, 0), 2); END IF;

    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id AND tp."position" = p_place
       AND COALESCE(tp.source, '') NOT IN ('satellite_seat');
    RETURN round(COALESCE(v_paid, 0), 2);
  END IF;

  SELECT o.amount_paid INTO v_paid
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id AND o.kind = v_row_kind
     AND o.place IS NULL AND o.user_id = p_user_id;
  IF FOUND THEN RETURN round(COALESCE(v_paid, 0), 2); END IF;

  IF v_row_kind = 'refund' THEN
    SELECT COALESCE(sum(w.amount), 0) INTO v_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id AND w.user_id = p_user_id
       AND w.type = 'credit' AND lower(w.category) IN ('refund','tournament_refund');
    RETURN round(COALESCE(v_paid, 0), 2);
  END IF;

  RETURN 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_obligation_paid_so_far(uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_obligation_paid_so_far(uuid, text, integer, uuid) TO service_role;
COMMENT ON FUNCTION public.fn_tournament_obligation_paid_so_far(uuid, text, integer, uuid) IS
  'Read-only. The amount fn_settle_tournament_obligation will treat as already paid for this obligation (the obligation row, else its legacy seed). A caller that knows a shortfall passes paid_so_far + shortfall as the TOTAL. Lane A3, 2026-09-02.';

-- ---------------------------------------------------------------------------
-- 1b. The settle function itself, one line changed: its idempotency key now
--     starts with 'tourney:<tournament_id>:' so fn_credit_player_wallet_once
--     credits the club wallet the player entered FROM (tournament_players.
--     club_id) instead of the player's first-joined club. Everything else is
--     the live body of 19:47 UTC, byte for byte.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Rows paid from the BOUNTY pool (or recorded on the target by a satellite),
  -- never from the prize pool. Everything else counts against the pool.
  v_not_pool    text[] := ARRAY['satellite_seat','bounty','mystery_bounty','bounty_residual','own_bounty','mystery_bounty_residual'];
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
  -- Only rows paid FROM the prize pool count; bounty-pool rows (see v_not_pool)
  -- are a different liability and are capped by their own pool.
  IF v_row_kind = ANY (v_pool_kinds) THEN
    SELECT COALESCE(sum(tp.amount), 0) INTO v_paid_pool
      FROM public.tournament_payouts tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (COALESCE(tp.source, '') = ANY (v_not_pool));
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

  /* THE KEY NAMES THE TOURNAMENT (Lane A3, 2026-09-02). fn_credit_player_wallet_once
     resolves WHICH club wallet to credit from a 'tourney:<id>:...' key
     (tournament_players.club_id for that entry); any other shape falls back to
     fn_player_home_club, which is the club the player joined FIRST, not the
     club they bought in from. Measured in the rolled-back probe: 3 of 4 places
     landed in the wrong club under the old 'obl:<id>:<n>' shape. No 'obl:' key
     was ever spent in production, so the rename costs nothing. */
  v_key := 'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':' || (round(v_ob.amount_paid * 100))::bigint::text;
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
$function$;

-- ---------------------------------------------------------------------------
-- 2. The reconciler. Detection unchanged; the top-up settles through the
--    obligation ledger with the full entitlement of the place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(p_tournament_id uuid, p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  t                record;
  v_struct         jsonb;
  v_trimmed        jsonb;
  v_field          int;
  v_pool           numeric;
  v_last_place     int;
  v_total_bp       numeric;
  v_pool_cents     numeric;
  v_remaining      numeric;
  v_cents          numeric;
  v_expected       numeric;
  v_paid           numeric;
  v_paid_place     numeric;
  v_paid_eff       numeric;
  v_place_others   uuid[];
  v_delta          numeric;
  v_holder         uuid;
  v_holders        int;
  v_credited       boolean;
  v_settle         jsonb;
  v_settle_paid    numeric;
  v_actions        jsonb := '[]'::jsonb;
  v_issues         jsonb := '[]'::jsonb;
  v_total_expected numeric := 0;
  v_total_paid     numeric := 0;
  v_total_topup    numeric := 0;
  v_total_settled  numeric := 0;
  v_only_accepted  boolean;
  v_was_accepted   boolean;
  v_has_record     boolean;
  r                record;
BEGIN
  SELECT id, prize_pool, payout_structure, status, variant, tournament_type, name
    INTO t
    FROM tournaments WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;

  IF COALESCE(t.variant, '') = 'satellite'
     OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'satellite_awards_seats');
  END IF;

  IF COALESCE(t.status, '') <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'not_completed', 'status', t.status);
  END IF;

  v_pool := round(COALESCE(t.prize_pool, 0), 2);

  BEGIN
    v_struct := CASE WHEN jsonb_typeof(t.payout_structure::jsonb) = 'array'
                     THEN t.payout_structure::jsonb ELSE '[]'::jsonb END;
  EXCEPTION WHEN OTHERS THEN
    v_struct := '[]'::jsonb;
  END;

  IF v_pool <= 0 OR jsonb_array_length(v_struct) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'no_pool_or_structure',
                              'prize_pool', v_pool);
  END IF;

  /* Is there an authoritative record for this event at all? */
  SELECT EXISTS (SELECT 1 FROM public.tournament_payouts tpo
                  WHERE tpo.tournament_id = p_tournament_id)
    INTO v_has_record;

  SELECT count(*) INTO v_field
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id;

  IF COALESCE(v_field, 0) >= 1 THEN
    SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::int), '[]'::jsonb)
      INTO v_trimmed
      FROM jsonb_array_elements(v_struct) e
     WHERE (e->>'place')::int <= v_field;

    IF jsonb_array_length(v_trimmed) > 0
       AND jsonb_array_length(v_trimmed) < jsonb_array_length(v_struct) THEN
      v_struct := v_trimmed;
    END IF;
  END IF;

  SELECT max((e->>'place')::int) INTO v_last_place
    FROM jsonb_array_elements(v_struct) e;

  SELECT COALESCE(SUM(round((e->>'percentage')::numeric * 100)), 0)
    INTO v_total_bp
    FROM jsonb_array_elements(v_struct) e;

  IF v_total_bp <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'tournament_id', p_tournament_id,
                              'skipped', 'structure_has_no_percentages');
  END IF;

  v_pool_cents := round(v_pool * 100);
  v_remaining  := v_pool_cents;

  FOR r IN
    SELECT (e->>'place')::int                      AS place,
           round((e->>'percentage')::numeric * 100) AS bp
      FROM jsonb_array_elements(v_struct) e
     ORDER BY (e->>'place')::int
  LOOP
    IF r.place = v_last_place THEN
      v_cents := GREATEST(v_remaining, 0);
    ELSE
      v_cents := LEAST(v_remaining, round(v_pool_cents * r.bp / v_total_bp));
      v_cents := GREATEST(v_cents, 0);
    END IF;
    v_remaining := v_remaining - v_cents;

    v_expected := v_cents / 100.0;
    v_total_expected := v_total_expected + v_expected;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_holders, v_holder
      FROM tournament_players tp
     WHERE tp.tournament_id = p_tournament_id AND tp.position = r.place;

    v_paid_place   := 0;
    v_place_others := ARRAY[]::uuid[];

    IF v_holders = 1 THEN
      IF v_has_record THEN
        /* THE AUTHORITATIVE ANSWER. One row per movement of money, keyed
           uniquely, written only after the credit returned true. Bounty and
           mystery-bounty money is excluded: it is funded from the bounty pool,
           not from prize_pool, and counting it here used to make a player look
           square when the structure still owed them.
           2026-09-02: 'overlay_backpay' added. A guarantee overlay top-up IS
           prize_pool money. While it was missing from this list the reconciler
           could not see 1,703.00 chips of back-payment and paid 1,007.80 of it
           a second time.
           2026-09-02 (Lane A3): a row written by fn_settle_tournament_obligation
           (idempotency_key 'obl:%') is prize-pool money whatever source label
           the caller passed - the engine settles under 'engine.*' names. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2) INTO v_paid
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.user_id = v_holder
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');

        /* A PLACE IS PAID ONCE, NO MATTER WHO HOLDS IT (2026-09-02).
           What this place has already cost, to ANYBODY. The obligation is per
           place; reading only the current holder let a place that changed hands
           after settlement be paid in full a second time -- 81 places, 49
           events, 21,206.93 chips. */
        SELECT round(COALESCE(SUM(tpo.amount), 0), 2),
               COALESCE(array_agg(DISTINCT tpo.user_id)
                        FILTER (WHERE tpo.user_id <> v_holder), ARRAY[]::uuid[])
          INTO v_paid_place, v_place_others
          FROM public.tournament_payouts tpo
         WHERE tpo.tournament_id = p_tournament_id
           AND tpo.position = r.place
           AND (tpo.source IN ('structure', 'reconcile', 'hu_shortfall',
                               'late_reg_adjustment', 'clawback',
                               'final_table_deal', 'spin_backpay',
                               'overlay_backpay')
                OR tpo.idempotency_key LIKE 'tourney:%:obl:%');
      ELSE
        /* No record for this event. Fall back to the ledger exactly as before
           rather than reading "no record" as "nothing was paid". */
        SELECT round(COALESCE(SUM(
                 CASE WHEN lower(wt.type) = 'debit' THEN -abs(wt.amount)
                      ELSE wt.amount END
               ), 0), 2) INTO v_paid
          FROM wallet_transactions wt
         WHERE wt.related_entity_id = p_tournament_id
           AND wt.category = 'prize'
           AND wt.user_id = v_holder;
      END IF;
    ELSE
      v_paid := NULL;
    END IF;

    IF v_holders = 0 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'no_finisher_recorded',
        'expected', v_expected,
        'detail', 'prize is owed to nobody identifiable; needs a human decision');
      CONTINUE;
    END IF;

    IF v_holders > 1 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'duplicate_finishers',
        'holders', v_holders, 'expected', v_expected,
        'detail', 'more than one player recorded in this place (double-pay defect)');
      CONTINUE;
    END IF;

    /* The cap. A top-up settles what the PLACE still owes, not what this
       particular player has yet to receive from it. */
    v_paid_eff := GREATEST(COALESCE(v_paid, 0), COALESCE(v_paid_place, 0));

    IF COALESCE(v_paid_place, 0) > COALESCE(v_paid, 0) + 0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'place_paid_to_a_different_player',
        'user_id', v_holder,
        'paid_to_current_holder', COALESCE(v_paid, 0),
        'paid_at_this_place', v_paid_place,
        'other_recipients', to_jsonb(v_place_others),
        'expected', v_expected,
        'detail', 'this place was settled before the finishing order changed. '
               || 'No automatic top-up: the place is already paid. Paying the '
               || 'current holder as well is a deliberate decision (CLAUDE.md 10.9), '
               || 'made with the earlier payment in view.');
    END IF;

    v_total_paid := v_total_paid + v_paid_eff;
    v_delta := round(v_expected - v_paid_eff, 2);
    v_credited := NULL;
    v_settle := NULL;
    v_settle_paid := 0;

    IF v_delta > 0.005 THEN
      v_total_topup := v_total_topup + v_delta;

      IF p_apply THEN
        IF NOT v_has_record AND COALESCE(v_paid, 0) > 0.005 THEN
          /* THE OBLIGATION LEDGER SEEDS FROM tournament_payouts. This event
             has no payout record at all, yet the holder's wallet shows prize
             credits. Settling from the entitlement would pay the wallet a
             second time - the exact defect this lane exists to end. Report;
             a human writes the record. */
          v_credited := false;
          v_issues := v_issues || jsonb_build_object(
            'place', r.place, 'issue', 'paid_without_payout_record',
            'user_id', v_holder, 'expected', v_expected,
            'wallet_prizes', COALESCE(v_paid, 0), 'wanted', v_delta,
            'detail', 'the wallet was credited but no tournament_payouts row records it; '
                   || 'the obligation ledger cannot see that payment, so nothing was settled. '
                   || 'Backfill the payout record, then re-run.');
        ELSE
          /* ONE SETTLE PATH (Lane A3, 2026-09-02). The place is settled with its
             FULL entitlement; fn_settle_tournament_obligation pays the difference
             against what it already holds as paid, refuses a replay, a second
             user on a paid place, and a payment the prize pool cannot cover
             (escrow_short raises its own critical alert; nothing else may pay). */
          v_settle := public.fn_settle_tournament_obligation(
            p_tournament_id, 'place', r.place, v_holder, v_expected, 'reconcile',
            'Tournament payout reconciliation place ' || r.place::text
              || ' (' || COALESCE(t.name, 'tournament') || ')');
          v_credited    := COALESCE((v_settle->>'ok')::boolean, false);
          v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);
          v_total_settled := v_total_settled + v_settle_paid;

          IF NOT v_credited THEN
            v_issues := v_issues || jsonb_build_object(
              'place', r.place, 'issue', 'top_up_refused_by_obligation',
              'user_id', v_holder, 'expected', v_expected,
              'already_paid', v_paid_eff, 'wanted', v_delta,
              'refused_reason', v_settle->>'refused_reason',
              'obligation_id', v_settle->>'obligation_id',
              'detail', 'fn_settle_tournament_obligation refused this top-up; '
                     || 'the remaining shortfall needs a human decision');
          END IF;
        END IF;
      END IF;

      v_actions := v_actions || jsonb_build_object(
        'place', r.place, 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'top_up', v_delta,
        'applied', p_apply,
        'settled', CASE WHEN p_apply THEN v_settle_paid ELSE NULL END,
        'obligation_id', v_settle->>'obligation_id');

    ELSIF v_delta < -0.005 THEN
      v_issues := v_issues || jsonb_build_object(
        'place', r.place, 'issue', 'overpaid', 'user_id', v_holder,
        'expected', v_expected, 'already_paid', v_paid_eff, 'excess', -v_delta,
        'detail', 'reported only; automatic clawback is deliberately not done');
    END IF;

    IF p_apply AND v_expected > 0
       AND COALESCE(v_credited, true)
       AND (v_paid_eff + CASE WHEN v_delta > 0.005 THEN v_delta ELSE 0 END)
           >= v_expected - 0.005 THEN
      UPDATE tournament_players tp
         SET prize = v_expected
       WHERE tp.tournament_id = p_tournament_id
         AND tp.user_id = v_holder
         AND tp.position = r.place
         AND COALESCE(tp.prize, 0) = 0;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_issues) > 0 THEN
    v_only_accepted := NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_issues) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded',
                                 'place_paid_to_a_different_player')
    );
    v_was_accepted := EXISTS (
      SELECT 1 FROM financial_alerts
       WHERE source = 'fn_tournament_payout_reconcile'
         AND resolved IS TRUE
         AND context->>'tournament_id' = p_tournament_id::text
         AND context ? 'resolution'
    );

    INSERT INTO financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_tournament_payout_reconcile',
           'Tournament payout could not be fully reconciled: '
             || COALESCE(t.name, p_tournament_id::text),
           jsonb_build_object('tournament_id', p_tournament_id,
                              'prize_pool', v_pool, 'issues', v_issues)
     WHERE NOT EXISTS (
       SELECT 1 FROM financial_alerts
        WHERE source = 'fn_tournament_payout_reconcile'
          AND resolved IS NOT TRUE
          AND context->>'tournament_id' = p_tournament_id::text)
       AND NOT (round(v_total_topup, 2) = 0 AND v_only_accepted AND v_was_accepted);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'tournament_id', p_tournament_id,
    'name', t.name,
    'prize_pool', v_pool,
    'field_size', v_field,
    'paid_places', jsonb_array_length(v_struct),
    'total_expected', round(v_total_expected, 2),
    'total_paid_to_known_holders', round(v_total_paid, 2),
    'total_top_up', round(v_total_topup, 2),
    'total_settled', round(v_total_settled, 2),
    'applied', p_apply,
    'paid_from', CASE WHEN v_has_record THEN 'payout_record' ELSE 'ledger_fallback' END,
    'money_path', 'fn_settle_tournament_obligation',
    'actions', v_actions,
    'issues', v_issues,
    'clean', (jsonb_array_length(v_actions) = 0 AND jsonb_array_length(v_issues) = 0));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3a. The backed-shortfall sweep. Live body kept verbatim except: what it
--     books and reports as paid is what the settle path PAID (total_settled),
--     not what the reconciler wanted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(p_apply boolean DEFAULT false, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_res jsonb;
  v_paid numeric := 0; v_events integer := 0;
  v_withheld numeric := 0; v_withheld_events integer := 0;
  v_refused integer := 0; v_refused_chips numeric := 0;
  v_alerts integer := 0;
  v_delta_after numeric;
BEGIN
  FOR r IN
    SELECT t.id, t.name, t.club_id, t.prize_pool,
           COALESCE((public.fn_tournament_payout_reconcile(t.id, false)->>'total_top_up')::numeric, 0) AS topup,
           public.fn_tournament_conservation_delta(t.id) AS delta,
           COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                      WHERE w.related_entity_id = t.id AND w.type = 'credit'
                        AND w.category = 'prize'), 0) AS wallet_prizes
      FROM public.tournaments t
     WHERE t.status = 'COMPLETED'
       -- Satellites award seats, not cash. Reconciling them against a cash
       -- pool would invent prizes that do not exist.
       AND COALESCE(t.variant, '') <> 'satellite'
       -- A Spin's pool is funded by the reserve, not by this game's own
       -- collections, so its delta does not mean what it means elsewhere.
       AND COALESCE(t.variant, '') <> 'spin'
       /* THE LOG IS A RECEIPT, NOT A TOMBSTONE (2026-09-01).
          This clause used to be `NOT EXISTS (... backfill_log ...)`, so one
          pass over an event excluded it from every future pass, for good. That
          is wrong in principle rather than in practice today: an event can
          become payable AFTER its pass - a guarantee gets funded, a
          conservation baseline is acknowledged - and nothing would ever look
          at it again. Measured before this change, no logged event is payable
          right now (all 57 fail the conservation filter below on their own
          merits), so removing the clause unlocks no payment today and closes
          the door on a shortfall that outlives its one and only inspection.
          "Nothing is owed" is the only correct exclusion, and it is computed
          below as `topup <= 0.005`. The log stays, as the audit trail it
          should always have been. */
       AND public.fn_tournament_conservation_delta(t.id) > 0.01
     ORDER BY t.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    CONTINUE WHEN r.topup <= 0.005;

    /* CONSERVATION REFUSES BEFORE THE POOL DOES (2026-09-01).
       The reconciler computes "already paid" from tournament_payouts, on
       purpose - counting ledger rows instead caused two real double-pays. The
       cost of that choice is that an event whose record is incomplete reports
       a debt it does not have, and 61 events on this platform hold 5,515.91
       chips of prizes that reached wallets and were never recorded. If such a
       pool is ever funded, this sweep would pay them a second time.

       An event that has already disbursed its whole pool to wallets owes
       nobody, whatever the paperwork says. Refuse, and say so, so the record
       gets fixed rather than paid twice. */
    IF r.wallet_prizes + 0.01 >= COALESCE(r.prize_pool, 0) AND COALESCE(r.prize_pool, 0) > 0 THEN
      v_refused := v_refused + 1;
      v_refused_chips := v_refused_chips + r.topup;
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_pay_backed_payout_shortfalls',
             format('%s already paid %s of its %s pool to wallets, so the %s the reconciler reports as owed is a missing tournament_payouts record, not a debt. Paying nothing.',
                    COALESCE(r.name, r.id::text), round(r.wallet_prizes,2),
                    round(COALESCE(r.prize_pool,0),2), round(r.topup,2))
           , jsonb_build_object('kind','refused_already_disbursed','tournament_id',r.id,
               'club_id',r.club_id,'wallet_prizes',round(r.wallet_prizes,2),
               'prize_pool',round(COALESCE(r.prize_pool,0),2),'reported_top_up',round(r.topup,2))
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='refused_already_disbursed'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    -- The event must be holding at least what it is about to pay out. Not
    -- `delta >= 0` - that would let an event with 3 chips spare pay out 300.
    IF r.delta < r.topup THEN
      v_withheld := v_withheld + r.topup;
      v_withheld_events := v_withheld_events + 1;
      /* WITHHOLDING IS NEVER SILENT (2026-09-01).
         This branch used to increment a counter that reached a console line
         and nothing else. Money owed to a player and not paid produced no
         durable record anywhere, so nobody could find it later, and nobody
         did. It is a deduped alert now, per event, naming the gap. */
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'critical', 'fn_pay_backed_payout_shortfalls',
             format('%s owes players %s and its pool holds %s, so nothing was paid. The shortfall needs funding before anyone can be paid.',
                    COALESCE(r.name, r.id::text), round(r.topup,2), round(r.delta,2))
           , jsonb_build_object('kind','withheld_unfunded_pool','tournament_id',r.id,
               'club_id',r.club_id,'owed',round(r.topup,2),'pool_holds',round(r.delta,2),
               'funding_gap',round(r.topup - r.delta,2),
               'detail','no money was moved; funding an advertised guarantee is a human decision')
       WHERE NOT EXISTS (SELECT 1 FROM public.financial_alerts fa
                          WHERE fa.source='fn_pay_backed_payout_shortfalls'
                            AND fa.resolved IS NOT TRUE
                            AND fa.context->>'kind'='withheld_unfunded_pool'
                            AND fa.context->>'tournament_id' = r.id::text);
      IF FOUND THEN v_alerts := v_alerts + 1; END IF;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02): the reconciler settles every
         place through fn_settle_tournament_obligation. `total_settled` is what
         that path actually paid; `total_top_up` is what was wanted. */
      v_res := public.fn_tournament_payout_reconcile(r.id, true);
      v_delta_after := public.fn_tournament_conservation_delta(r.id);

      IF v_delta_after < -0.01 THEN
        RAISE EXCEPTION 'paying % would leave conservation at %; refusing', r.id, v_delta_after;
      END IF;

      INSERT INTO public.tournament_payout_backfill_log
        (tournament_id, top_up, delta_before, delta_after)
      VALUES (r.id, COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, r.topup), r.delta, v_delta_after)
      ON CONFLICT (tournament_id) DO UPDATE
        SET top_up = EXCLUDED.top_up,
            delta_before = EXCLUDED.delta_before,
            delta_after = EXCLUDED.delta_after;

      v_paid := v_paid + COALESCE((v_res->>'total_settled')::numeric, (v_res->>'total_top_up')::numeric, 0);
    ELSE
      v_paid := v_paid + r.topup;
    END IF;
    v_events := v_events + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events_paid', v_events, 'chips_paid', round(v_paid, 2),
    'events_withheld_unfunded_pool', v_withheld_events,
    'chips_withheld_unfunded_pool', round(v_withheld, 2),
    'events_refused_already_disbursed', v_refused,
    'chips_refused_already_disbursed', round(v_refused_chips, 2),
    'alerts_raised', v_alerts,
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3b. The guarantee back-pay sweep. Live body kept verbatim (it had no repo
--     mirror until now) except that `distributed` reports what the settle
--     path paid. Funding the overlay by raising prize_pool is Lane B's to
--     replace with a real escrow debit; it is not changed here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_backpay_guarantee_shortfalls(p_apply boolean DEFAULT false, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t record;
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_actor uuid;
  v_events int := 0; v_chips numeric := 0; v_distributed numeric := 0;
  v_skipped jsonb := '[]'::jsonb; v_rec jsonb;
BEGIN
  SELECT performed_by INTO v_actor
    FROM public.chip_ledger
   WHERE category = 'overlay' AND performed_by IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  IF v_actor IS NULL THEN
    SELECT id INTO v_actor FROM public.profiles WHERE role = 'god' ORDER BY created_at LIMIT 1;
  END IF;
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no operator account to attribute the back-payment to');
  END IF;

  FOR t IN
    WITH candidates AS (
      SELECT tt.id, tt.name, tt.club_id, tt.guaranteed_prize, tt.prize_pool, tt.ended_at,
             COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
                        WHERE w.related_entity_id = tt.id AND w.type='credit'
                          AND w.category IN ('prize','bounty')),0) AS paid_all,
             (SELECT count(*) FROM public.tournament_players tp
               WHERE tp.tournament_id = tt.id) AS players
        FROM public.tournaments tt
       WHERE tt.status = 'COMPLETED'
         AND COALESCE(tt.tournament_type,'') = 'MTT'
         AND COALESCE(tt.variant,'') NOT IN ('satellite','spin')
         AND COALESCE(tt.guaranteed_prize,0) > 0
    )
    SELECT * FROM candidates
     WHERE paid_all < guaranteed_prize - 0.01
     ORDER BY ended_at
     LIMIT GREATEST(p_limit,1)
  LOOP
    v_short := round(t.guaranteed_prize - t.paid_all, 2);

    IF t.players = 0 THEN
      v_skipped := v_skipped || jsonb_build_object('tournament', t.name, 'why', 'no finishers recorded');
      CONTINUE;
    END IF;

    v_events := v_events + 1;
    v_chips  := v_chips + v_short;

    IF NOT p_apply THEN CONTINUE; END IF;

    SELECT union_id INTO v_union FROM public.clubs WHERE id = t.club_id;
    v_from := 'union_bank'; v_bank := NULL;
    IF v_union IS NOT NULL THEN
      SELECT chip_balance INTO v_bank FROM public.union_wallets
       WHERE union_id = v_union FOR UPDATE;
    END IF;
    IF v_union IS NULL OR COALESCE(v_bank,0) < v_short THEN
      SELECT chip_treasury INTO v_bank FROM public.clubs WHERE id = t.club_id FOR UPDATE;
      v_from := 'club_treasury';
    END IF;
    IF COALESCE(v_bank,0) < v_short THEN
      v_skipped := v_skipped || jsonb_build_object('tournament', t.name,
                     'why', 'bank short', 'needed', v_short, 'bank', COALESCE(v_bank,0));
      v_events := v_events - 1; v_chips := v_chips - v_short;
      CONTINUE;
    END IF;

    IF v_from = 'union_bank' THEN
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets SET chip_balance = chip_balance - v_short
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    ELSE
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
      UPDATE public.clubs SET chip_treasury = chip_treasury - v_short WHERE id = t.club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
    END IF;

    -- The pool must show the overlay before the reconciler reads it: expected
    -- is pool x structure, so raising the pool IS what makes each place's
    -- entitlement come out at the guaranteed level.
    UPDATE public.tournaments
       SET prize_pool = round(GREATEST(COALESCE(prize_pool,0), t.guaranteed_prize), 2)
     WHERE id = t.id;

    INSERT INTO public.chip_ledger
      (amount, category, from_type, from_entity_id, to_type, to_entity_id,
       club_id, status, performed_by, description, idempotency_key, metadata)
    VALUES (v_short, 'overlay',
            CASE WHEN v_from='union_bank' THEN 'union_bank' ELSE 'club_treasury' END,
            CASE WHEN v_from='union_bank' THEN v_union ELSE t.club_id END,
            'prize_liability', t.id, t.club_id, 'posted', v_actor,
            format('Guarantee shortfall back-payment from the main bank: %s was %s short of its %s guarantee - players had been paid %s',
                   t.name, v_short, round(t.guaranteed_prize,2), round(t.paid_all,2)),
            'guarantee-backpay:' || t.id::text,
            jsonb_build_object('tournament_id', t.id, 'shortfall', v_short,
                               'guarantee', t.guaranteed_prize, 'already_paid', t.paid_all,
                               'distributed_by', 'fn_tournament_payout_reconcile',
                               'money_path', 'fn_settle_tournament_obligation'))
    ON CONFLICT DO NOTHING;

    -- DISTRIBUTION IS NOT THIS FUNCTION'S JOB. The reconciler owns the
    -- structure, tops up each place to its entitlement through
    -- fn_settle_tournament_obligation (Lane A3, 2026-09-02), which writes the
    -- tournament_payouts rows and never claws back.
    v_rec := public.fn_tournament_payout_reconcile(t.id, true);
    v_distributed := v_distributed + COALESCE((v_rec->>'total_settled')::numeric, (v_rec->>'total_top_up')::numeric, 0);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
                            'events', v_events, 'funded', round(v_chips,2),
                            'distributed', round(v_distributed,2), 'skipped', v_skipped,
                            'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Spin winner back-pay: kind 'place', place 1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_backpay_spin_unpaid_winners(p_apply boolean DEFAULT false, p_limit integer DEFAULT 200, p_since_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_ok boolean;
  v_settle jsonb; v_settle_paid numeric; v_paid_so_far numeric;
  v_paid integer := 0; v_chips numeric := 0; v_skipped integer := 0;
  v_refused integer := 0;
  v_owed_before numeric; v_owed_after numeric;
BEGIN
  create temp table if not exists _spin_unpaid_snapshot (
    tournament_id uuid,
    chips_short numeric,
    verdict text,
    seats_at_first bigint,
    ended_at timestamptz
  ) on commit drop;
  /* TRUNCATE, not DELETE: the safeupdate library preloaded on the
     authenticator role rejects a DELETE with no WHERE clause outright. */
  truncate _spin_unpaid_snapshot;

  insert into _spin_unpaid_snapshot
  select s.tournament_id, s.chips_short, s.verdict, s.seats_at_first, s.ended_at
    from public.fn_spin_unpaid_settlements(p_since_hours) s
   where s.chips_short > 0.01;

  select coalesce(sum(chips_short), 0) into v_owed_before
    from _spin_unpaid_snapshot;

  FOR r IN
    SELECT s.tournament_id, s.chips_short, s.verdict,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = s.tournament_id AND tp.position = 1
             LIMIT 1) AS winner
      FROM _spin_unpaid_snapshot s
     WHERE NOT EXISTS (SELECT 1 FROM public.spin_unpaid_backpay_log l
                        WHERE l.tournament_id = s.tournament_id)
     ORDER BY s.ended_at ASC NULLS LAST
     LIMIT GREATEST(p_limit, 1)
  LOOP
    IF r.winner IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF p_apply THEN
      /* ONE SETTLE PATH (Lane A3, 2026-09-02). The winner's place-1 obligation
         is worth what the settle function already holds as paid plus the
         shortfall the detector measured; the settle function pays exactly
         that difference once, and a replay pays 0. A refusal (escrow_short,
         place paid to another user, payout frozen) is reported and NOT paid
         through any other path. */
      v_paid_so_far := public.fn_tournament_obligation_paid_so_far(r.tournament_id, 'place', 1, r.winner);
      v_settle := public.fn_settle_tournament_obligation(
        r.tournament_id, 'place', 1, r.winner,
        round(v_paid_so_far + r.chips_short, 2), 'spin_backpay',
        'Spin winner back-pay (prize drawn from the reserve but never credited)');
      v_ok := COALESCE((v_settle->>'ok')::boolean, false);
      v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);

      IF v_ok AND v_settle_paid > 0 THEN
        UPDATE public.tournament_players
           SET prize = round(COALESCE(prize, 0) + v_settle_paid, 2)
         WHERE tournament_id = r.tournament_id AND user_id = r.winner;

        INSERT INTO public.spin_unpaid_backpay_log
          (tournament_id, user_id, amount, verdict)
        VALUES (r.tournament_id, r.winner, v_settle_paid, r.verdict)
        ON CONFLICT (tournament_id) DO NOTHING;

        v_paid := v_paid + 1;
        v_chips := v_chips + v_settle_paid;
      ELSIF NOT v_ok THEN
        v_refused := v_refused + 1;
      END IF;
    ELSE
      v_paid := v_paid + 1;
      v_chips := v_chips + r.chips_short;
    END IF;
  END LOOP;

  /* Second measurement, over the SAME window and genuinely re-read. The
     backlog itself must shrink; a count of rows processed proves nothing. */
  SELECT COALESCE(sum(chips_short), 0) INTO v_owed_after
    FROM public.fn_spin_unpaid_settlements(p_since_hours)
   WHERE chips_short > 0.01;

  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'window_hours', p_since_hours,
    'winners_paid', v_paid, 'chips', round(v_chips, 2),
    'skipped_no_winner', v_skipped,
    'refused_by_obligation', v_refused,
    'owed_before', round(v_owed_before, 2), 'owed_after', round(v_owed_after, 2),
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Heads-Up winner shortfall: kind 'place', place 1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row record;
  v_paid integer := 0; v_chips numeric := 0; v_scanned integer := 0;
  v_ranked integer := 0; v_unpayable integer := 0; v_ok boolean;
  v_refused integer := 0;
  v_winner uuid; v_winners integer;
  v_settle jsonb; v_settle_paid numeric; v_paid_so_far numeric; v_pool_before numeric;
BEGIN
  FOR v_row IN
    SELECT c.tournament_id AS id
      FROM public.fn_hu_shortfall_candidates(p_limit) c
     WHERE EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_id = c.tournament_id
                      AND tp.position IS NULL)
  LOOP
    v_ranked := v_ranked + COALESCE(public.fn_rank_survivors(v_row.id), 0);
  END LOOP;

  FOR v_row IN
    SELECT c.tournament_id AS id, c.name, c.delta
      FROM public.fn_hu_shortfall_candidates(p_limit) c
  LOOP
    v_scanned := v_scanned + 1;

    SELECT count(*), (array_agg(tp.user_id ORDER BY tp.user_id))[1]
      INTO v_winners, v_winner
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_row.id
       AND (tp.status = 'winner' OR tp.position = 1);

    IF v_winners <> 1 OR v_winner IS NULL THEN
      CONTINUE;
    END IF;

    /* ONE SETTLE PATH (Lane A3, 2026-09-02). The shortfall is money the event
       collected and never paid, so the pool is raised by it FIRST (the settle
       function caps a place against prize_pool) and the winner's place-1
       obligation is settled at paid-so-far + delta. If nothing was paid the
       pool raise is undone in the same transaction. */
    SELECT prize_pool INTO v_pool_before FROM public.tournaments WHERE id = v_row.id FOR UPDATE;
    UPDATE public.tournaments
       SET prize_pool = round(COALESCE(prize_pool, 0) + v_row.delta, 2)
     WHERE id = v_row.id;

    v_paid_so_far := public.fn_tournament_obligation_paid_so_far(v_row.id, 'place', 1, v_winner);
    v_settle := public.fn_settle_tournament_obligation(
      v_row.id, 'place', 1, v_winner,
      round(v_paid_so_far + v_row.delta, 2), 'hu_shortfall',
      'Heads-Up winner shortfall back-pay (' || COALESCE(v_row.name, 'sng') || ')');
    v_ok := COALESCE((v_settle->>'ok')::boolean, false);
    v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);

    IF v_ok AND v_settle_paid > 0 THEN
      v_paid := v_paid + 1;
      v_chips := v_chips + v_settle_paid;
      UPDATE public.tournament_players
         SET prize = round(COALESCE(prize, 0) + v_settle_paid, 2)
       WHERE tournament_id = v_row.id AND user_id = v_winner;
      IF v_settle_paid < v_row.delta THEN
        UPDATE public.tournaments
           SET prize_pool = round(COALESCE(v_pool_before, 0) + v_settle_paid, 2)
         WHERE id = v_row.id;
      END IF;

      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE source = 'fn_backpay_hu_winner_shortfalls'
         AND resolved IS NOT TRUE
         AND (context->>'tournament_id')::uuid = v_row.id;
    ELSE
      UPDATE public.tournaments SET prize_pool = v_pool_before WHERE id = v_row.id;
      IF NOT v_ok THEN v_refused := v_refused + 1; END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_unpayable
    FROM public.fn_hu_shortfall_candidates(10000) c
   WHERE (SELECT count(*) FROM public.tournament_players tp
           WHERE tp.tournament_id = c.tournament_id
             AND (tp.status = 'winner' OR tp.position = 1)) <> 1;

  IF v_unpayable > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'warning', 'fn_backpay_hu_winner_shortfalls',
           v_unpayable || ' Heads-Up event(s) owe a shortfall but have no single '
             || 'identifiable winner - needs a human decision',
           jsonb_build_object('unpayable_events', v_unpayable)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_backpay_hu_winner_shortfalls'
          AND resolved IS NOT TRUE
          AND context ? 'unpayable_events');
  ELSE
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'fn_backpay_hu_winner_shortfalls'
       AND resolved IS NOT TRUE
       AND context ? 'unpayable_events';
  END IF;

  RETURN jsonb_build_object('ok', true, 'scanned', v_scanned, 'ranked', v_ranked,
    'paid', v_paid, 'chips', round(v_chips, 2), 'unpayable', v_unpayable,
    'refused_by_obligation', v_refused,
    'money_path', 'fn_settle_tournament_obligation');
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The final-table deal: kind 'final_table_deal', user-keyed. The function
--    used to write tournament_payouts rows and leave the wallets to the
--    engine. Those pre-written rows count against prize_pool inside the
--    settle function, so the engine's settle would have been refused as
--    escrow_short on every deal. Now the deal settles here; the engine's
--    settleFinalTableDeal reads the rows the settle path wrote (source
--    'final_table_deal') and its own settle of the same obligation pays 0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_final_table_deal(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t             record;
  v_remaining     integer;
  v_total_chips   numeric;
  v_awarded       numeric;
  v_undistributed numeric;
  v_paid_out      numeric := 0;
  v_share         numeric;
  v_leader        uuid;
  v_remainder     numeric;
  v_p             record;
  v_payouts       jsonb := '[]'::jsonb;
  v_shares        jsonb := '[]'::jsonb;
  v_rank          integer := 0;
  v_amount        numeric;
  v_settle        jsonb;
  v_settle_paid   numeric;
  v_settled_total numeric := 0;
  v_refusals      jsonb := '[]'::jsonb;
BEGIN
  SELECT id, status, prize_pool, final_table_deal_enabled, COALESCE(table_size, 9) AS table_size
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found');
  END IF;
  IF NOT COALESCE(v_t.final_table_deal_enabled, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_not_enabled');
  END IF;
  IF v_t.status <> 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts
              WHERE tournament_id = p_tournament_id AND source = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations
                 WHERE tournament_id = p_tournament_id AND kind = 'final_table_deal') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deal_already_executed');
  END IF;

  SELECT count(*), COALESCE(sum(GREATEST(chips, 0)), 0)
    INTO v_remaining, v_total_chips
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL;

  IF v_remaining < 2 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_enough_players');
  END IF;
  IF v_remaining > v_t.table_size THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_at_final_table',
                              'detail', v_remaining);
  END IF;
  IF v_total_chips <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_chips_in_play');
  END IF;

  SELECT COALESCE(sum(prize), 0) INTO v_awarded
    FROM public.tournament_players WHERE tournament_id = p_tournament_id;
  SELECT v_awarded + COALESCE(sum(amount), 0) INTO v_awarded
    FROM public.tournament_payouts WHERE tournament_id = p_tournament_id;

  v_undistributed := GREATEST(COALESCE(v_t.prize_pool, 0) - v_awarded, 0);
  IF v_undistributed <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_undistributed_prize');
  END IF;

  SELECT user_id INTO v_leader
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id
     AND status IN ('registered', 'playing')
     AND eliminated_at IS NULL
   ORDER BY chips DESC, registered_at ASC, user_id ASC
   LIMIT 1;

  /* PASS 1 - price every seat, write nothing. */
  FOR v_p IN
    SELECT user_id, chips
      FROM public.tournament_players
     WHERE tournament_id = p_tournament_id
       AND status IN ('registered', 'playing')
       AND eliminated_at IS NULL
     ORDER BY chips DESC, registered_at ASC, user_id ASC
  LOOP
    v_rank  := v_rank + 1;
    v_share := floor(GREATEST(v_p.chips, 0) / v_total_chips * v_undistributed);
    v_paid_out := v_paid_out + v_share;
    v_shares := v_shares || jsonb_build_object(
      'user_id', v_p.user_id, 'share', v_share, 'rank', v_rank);
  END LOOP;

  /* The flooring shortfall, settled on the chip leader - as before, but
     decided before the first row is written instead of by an UPDATE after. */
  v_remainder := v_undistributed - v_paid_out;

  /* PASS 2 - ONE SETTLE PATH (Lane A3, 2026-09-02). One user-keyed
     'final_table_deal' obligation per player, settled here. The settle
     function writes tournament_payouts (source 'final_table_deal', position
     NULL) and wallet_transactions, refuses a replay and refuses a share the
     prize pool cannot cover (escrow_short raises its own critical alert). */
  FOR v_p IN SELECT * FROM jsonb_to_recordset(v_shares)
                        AS x(user_id uuid, share numeric, rank integer)
  LOOP
    v_amount := v_p.share
              + CASE WHEN v_remainder > 0 AND v_p.user_id = v_leader
                     THEN v_remainder ELSE 0 END;
    v_settle_paid := 0;

    IF v_amount > 0 THEN
      v_settle := public.fn_settle_tournament_obligation(
        p_tournament_id, 'final_table_deal', NULL, v_p.user_id, v_amount,
        'final_table_deal', 'Final table deal (even chip chop)');
      v_settle_paid := round(COALESCE((v_settle->>'paid')::numeric, 0), 2);
      IF NOT COALESCE((v_settle->>'ok')::boolean, false) THEN
        v_refusals := v_refusals || jsonb_build_object(
          'user_id', v_p.user_id, 'amount', v_amount,
          'refused_reason', v_settle->>'refused_reason',
          'obligation_id', v_settle->>'obligation_id');
      END IF;
    END IF;

    v_settled_total := v_settled_total + v_settle_paid;
    v_payouts := v_payouts || jsonb_build_object('user_id', v_p.user_id, 'amount', v_amount,
                                                 'settled', v_settle_paid,
                                                 'obligation_id', v_settle->>'obligation_id');

    IF v_settle_paid > 0 THEN
      UPDATE public.tournament_players
         SET prize = COALESCE(prize, 0) + v_settle_paid
       WHERE tournament_id = p_tournament_id AND user_id = v_p.user_id;
    END IF;
  END LOOP;

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = now()
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true,
    'undistributed', v_undistributed,
    'remainder_to_leader', v_remainder,
    'chip_leader', v_leader,
    'settled', round(v_settled_total, 2),
    'refusals', v_refusals,
    'money_path', 'fn_settle_tournament_obligation',
    'payouts', v_payouts);
END; $function$;

-- ---------------------------------------------------------------------------
-- 7. Post-apply assertions: the live bodies say what this file says.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  v_name text;
  v_src  text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['fn_tournament_payout_reconcile','fn_pay_backed_payout_shortfalls',
                                'fn_ca_backpay_guarantee_shortfalls','fn_backpay_spin_unpaid_winners',
                                'fn_backpay_hu_winner_shortfalls','fn_final_table_deal']
  LOOP
    SELECT p.prosrc INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'ASSERT: % is missing', v_name;
    END IF;
    IF position('fn_settle_tournament_obligation' IN v_src) = 0 THEN
      RAISE EXCEPTION 'ASSERT: % does not settle through fn_settle_tournament_obligation', v_name;
    END IF;
    IF position('fn_credit_and_log(' IN v_src) > 0 OR position('credit_player_wallet(' IN v_src) > 0 THEN
      RAISE EXCEPTION 'ASSERT: % still credits a wallet on its own', v_name;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'fn_tournament_obligation_paid_so_far'
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'ASSERT: fn_tournament_obligation_paid_so_far is callable by authenticated';
  END IF;

  RAISE NOTICE 'chip-std lane A3: six DB payers settle through fn_settle_tournament_obligation';
END $chk$;

COMMIT;
