CREATE TABLE public.ca_manual_adjustments (id uuid DEFAULT gen_random_uuid() NOT NULL,
actor uuid NOT NULL,
approver uuid,
reason text NOT NULL,
amount numeric(15,2) NOT NULL,
target_kind text NOT NULL,
target_id uuid,
tournament_id uuid,
status text DEFAULT 'proposed'::text NOT NULL,
created_at timestamp with time zone DEFAULT now() NOT NULL,
approved_at timestamp with time zone,
rejected_by uuid,
rejected_at timestamp with time zone,
decision_note text,
actor_label text,
approver_label text,
asset text DEFAULT 'chips'::text NOT NULL);

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_amount_check CHECK (((amount <> (0)::numeric) AND (amount = round(amount, 2))));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_approved_has_approver CHECK (((status <> ALL (ARRAY['approved'::text, 'settled'::text])) OR ((approver IS NOT NULL) AND (approved_at IS NOT NULL))));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_asset_check CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_asset_matches_target CHECK (((asset = 'diamonds'::text) = (target_kind = ANY (ARRAY['diamond_wallet'::text, 'diamond_house'::text]))));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_four_eyes CHECK (((approver IS NULL) OR (approver <> actor)));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_pkey PRIMARY KEY (id);

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_reason_check CHECK ((length(btrim(reason)) >= 20));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_rejected_has_rejecter CHECK (((status <> 'rejected'::text) OR ((rejected_by IS NOT NULL) AND (rejected_at IS NOT NULL))));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'settled'::text, 'rejected'::text])));

ALTER TABLE public.ca_manual_adjustments ADD CONSTRAINT ca_manual_adjustments_target_kind_check CHECK ((target_kind = ANY (ARRAY['player_wallet'::text, 'promo_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'union_wallet'::text, 'agent_wallet'::text, 'club_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'prize_liability'::text, 'bounty_liability'::text, 'diamond_wallet'::text, 'diamond_house'::text])));

CREATE INDEX ca_manual_adjustments_status_idx ON public.ca_manual_adjustments USING btree (status, created_at DESC);

CREATE TABLE public.ca_payout_freeze (id uuid DEFAULT gen_random_uuid() NOT NULL,
scope text NOT NULL,
reason text NOT NULL,
opened_by uuid,
opened_by_label text,
opened_at timestamp with time zone DEFAULT now() NOT NULL,
cleared_by uuid,
cleared_by_label text,
cleared_at timestamp with time zone);

ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_clear_after_open CHECK (((cleared_at IS NULL) OR (cleared_at >= opened_at)));

ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_pkey PRIMARY KEY (id);

ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_reason_check CHECK ((length(btrim(reason)) >= 10));

ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_scope_check CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text, 'wheel'::text, 'plinko'::text, 'crash'::text])));

CREATE UNIQUE INDEX ca_payout_freeze_one_open_per_scope ON public.ca_payout_freeze USING btree (scope) WHERE (cleared_at IS NULL);

CREATE TABLE public.financial_alerts (id uuid DEFAULT gen_random_uuid() NOT NULL,
severity text NOT NULL,
source text NOT NULL,
message text NOT NULL,
context jsonb DEFAULT '{}'::jsonb,
resolved boolean DEFAULT false NOT NULL,
resolved_at timestamp with time zone,
created_at timestamp with time zone DEFAULT now() NOT NULL,
resolved_by uuid,
resolution text);

ALTER TABLE public.financial_alerts ADD CONSTRAINT financial_alerts_pkey PRIMARY KEY (id);

ALTER TABLE public.financial_alerts ADD CONSTRAINT financial_alerts_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])));

CREATE INDEX financial_alerts_incident_id_idx ON public.financial_alerts USING btree (((context ->> 'incident_id'::text))) WHERE (context ? 'incident_id'::text);

CREATE INDEX financial_alerts_incident_uuid_idx ON public.financial_alerts USING btree ((((context ->> 'incident_id'::text))::uuid)) WHERE ((context ->> 'incident_id'::text) ~ '^[0-9a-fA-F-]{36}$'::text);

CREATE INDEX financial_alerts_unresolved_source_idx ON public.financial_alerts USING btree (source) WHERE (NOT resolved);

CREATE INDEX idx_financial_alerts_reported_by_created ON public.financial_alerts USING btree (((context ->> 'reported_by'::text)), created_at DESC);

CREATE INDEX idx_financial_alerts_resolved ON public.financial_alerts USING btree (resolved) WHERE (resolved = false);

CREATE INDEX idx_financial_alerts_resolved_by ON public.financial_alerts USING btree (resolved_by);

CREATE INDEX idx_financial_alerts_severity ON public.financial_alerts USING btree (severity);

CREATE INDEX idx_financial_alerts_source_created ON public.financial_alerts USING btree (source, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_can_pay(p_tournament_id uuid, p_kind text, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v public.tournament_escrow%ROWTYPE; v_have numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('known', false);
  END IF;
  v_have := CASE WHEN p_kind IN ('bounty', 'mystery_bounty', 'bounty_residual') THEN v.bounty_balance
                 WHEN p_kind = 'refund' THEN v.prize_balance + v.bounty_balance + v.fee_balance
                 ELSE v.prize_balance END;
  RETURN jsonb_build_object('known', true, 'enforced', v.enforced, 'available', v_have,
                            'ok', (NOT v.enforced) OR p_amount <= v_have + 0.005,
                            'prize_balance', v.prize_balance, 'bounty_balance', v.bounty_balance, 'fee_balance', v.fee_balance);
END;
$function$;

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
  v_payout_source text;
  v_payout_place integer;
  v_payout_id uuid;
  v_existing_key record;
  v_key_existed boolean := false;
  v_evidence_count integer;
  v_prev_cp text;
  v_prev_cp_entity text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_credit_and_log requires a user id' USING ERRCODE = '22004';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'fn_credit_and_log requires an idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0
     OR p_amount IS DISTINCT FROM round(p_amount, 2) THEN
    RAISE EXCEPTION
      'fn_credit_and_log requires a finite positive whole-cent amount (got %)',
      p_amount USING ERRCODE = '22003';
  END IF;

  SELECT k.user_id, k.amount INTO v_existing_key
    FROM public.wallet_credit_idempotency k
   WHERE k.key = p_idempotency_key;
  v_key_existed := FOUND;
  IF v_key_existed
     AND (v_existing_key.user_id IS DISTINCT FROM p_user_id
       OR v_existing_key.amount IS NULL
       OR v_existing_key.amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_existing_key.amount IS DISTINCT FROM p_amount) THEN
    RAISE EXCEPTION 'idempotency key % belongs to a different credit',
      p_idempotency_key USING ERRCODE = '23505';
  END IF;

  v_ledger_cat := CASE lower(COALESCE(p_category, ''))
                    WHEN 'prize' THEN 'tournament_prize'
                    WHEN 'buyin' THEN 'tournament_buyin'
                    WHEN '' THEN 'adjustment'
                    ELSE lower(p_category)
                  END;

  -- Resolve mandatory evidence before the wallet move. Explicit obligation
  -- metadata wins; legacy owner-only callers may still classify their key.
  IF lower(COALESCE(p_category, '')) = 'prize' THEN
    IF p_related_entity_id IS NULL THEN
      RAISE EXCEPTION 'a tournament prize requires a tournament id'
        USING ERRCODE = '23502';
    END IF;
    SELECT t.id, t.tournament_type, t.prize_pool, t.payout_structure
      INTO v_t FROM public.tournaments t
     WHERE t.id = p_related_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'tournament % does not exist for prize evidence',
        p_related_entity_id USING ERRCODE = '23503';
    END IF;
    SELECT s.source, s.place INTO v_shape_source, v_shape_place
      FROM public.fn_tournament_payout_shape(p_idempotency_key) s;
    v_payout_source := COALESCE(NULLIF(btrim(p_payout_source), ''),
                                v_shape_source);
    -- A payment whose kind is unknown is not allowed to move. This check is
    -- deliberately before fn_credit_player_wallet_once: the payout row and
    -- wallet credit are one transaction, but rejecting the unnamed path here
    -- also prevents an older catch-and-alert writer from ever treating a
    -- missing classification as non-fatal.
    IF v_payout_source IS NULL THEN
      RAISE EXCEPTION
        'tournament prize % has no recognized payout source',
        p_idempotency_key USING ERRCODE = '22023';
    END IF;
    IF v_payout_source NOT IN (
      'structure','reconcile','hu_shortfall','bounty','bounty_residual',
      'own_bounty','late_reg_adjustment','clawback','final_table_deal',
      'mystery_bounty','mystery_bounty_residual','spin_backpay',
      'overlay_backpay','bubble_protection','satellite_remainder',
      'satellite_seat','satellite_ticket','finish_position_correction'
    ) THEN
      RAISE EXCEPTION
        'tournament prize % supplied unknown payout source %',
        p_idempotency_key, v_payout_source USING ERRCODE = '22023';
    END IF;
    v_payout_place := COALESCE(p_payout_position, v_shape_place);
    IF v_payout_place IS NOT NULL AND v_payout_place <= 0 THEN
      RAISE EXCEPTION 'prize evidence has invalid finish position %', v_payout_place
        USING ERRCODE = '22023';
    END IF;
    IF v_payout_source = 'structure' AND v_payout_place IS NULL THEN
      RAISE EXCEPTION 'a structure prize requires a finish position'
        USING ERRCODE = '23502';
    END IF;
    SELECT count(*) INTO v_field FROM public.tournament_players
     WHERE tournament_id = v_t.id;
  END IF;

  PERFORM set_config('app.ledger_category', v_ledger_cat, true);
  IF p_related_entity_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_tournament', p_related_entity_id::text, true);
  END IF;
  v_prev_cp := current_setting('app.ledger_counterparty', true);
  v_prev_cp_entity := current_setting('app.ledger_counterparty_entity', true);
  IF p_related_entity_id IS NOT NULL
     AND v_ledger_cat IN ('tournament_prize','bounty','refund','tournament_refund') THEN
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_related_entity_id::text, true);
  END IF;

  v_credited := public.fn_credit_player_wallet_once(
    p_user_id, p_amount, p_idempotency_key);

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_tournament', '', true);
  PERFORM set_config('app.ledger_counterparty', COALESCE(v_prev_cp, ''), true);
  PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_prev_cp_entity, ''), true);

  IF NOT v_credited THEN
    -- The first snapshot is not authoritative here. Two same-key transactions
    -- can both see no row; the loser then waits on the unique index inside
    -- fn_credit_player_wallet_once and returns FALSE after the winner commits.
    -- Re-read in a new statement snapshot, after that wait, and accept only the
    -- exact committed key. A genuinely orphaned or mismatched claim still
    -- aborts the outer transaction.
    SELECT k.user_id, k.amount INTO v_existing_key
      FROM public.wallet_credit_idempotency k
     WHERE k.key = p_idempotency_key
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'wallet credit % claimed its key but did not credit a wallet',
        p_idempotency_key USING ERRCODE = 'P0404';
    END IF;
    IF v_existing_key.user_id IS DISTINCT FROM p_user_id
       OR v_existing_key.amount IS NULL
       OR v_existing_key.amount::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_existing_key.amount IS DISTINCT FROM p_amount THEN
      RAISE EXCEPTION 'idempotency key % belongs to a different credit',
        p_idempotency_key USING ERRCODE = '23505';
    END IF;
    IF lower(COALESCE(p_category, '')) = 'prize' THEN
      SELECT count(*) INTO v_evidence_count
        FROM public.tournament_payouts tp
       WHERE tp.idempotency_key = p_idempotency_key
         AND tp.tournament_id = p_related_entity_id
         AND tp.user_id = p_user_id
         AND tp.amount = p_amount
         AND tp."position" IS NOT DISTINCT FROM v_payout_place
         AND tp.source IS NOT DISTINCT FROM v_payout_source;
      IF v_evidence_count <> 1 THEN
        RAISE EXCEPTION
          'prize replay % has % exact payout rows, expected one',
          p_idempotency_key, v_evidence_count USING ERRCODE = 'P0404';
      END IF;
    END IF;
    RETURN false;
  END IF;

  PERFORM public.log_wallet_transaction(
    p_user_id, p_wallet_type, p_amount, 'credit', p_category, p_description,
    p_table_id, p_hand_id, p_related_entity_id);

  IF lower(COALESCE(p_category, '')) = 'prize' THEN
    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, payout_structure,
       recorded_by)
    VALUES
      (v_t.id, p_user_id, v_payout_place, p_amount, v_payout_source,
       p_idempotency_key, now(), v_t.tournament_type, v_field, v_t.prize_pool,
       CASE WHEN v_t.payout_structure IS NULL THEN NULL
            ELSE jsonb_build_object('payout_structure', v_t.payout_structure) END,
       'credit_and_log')
    RETURNING id INTO v_payout_id;

    IF v_payout_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.tournament_payouts tp
       WHERE tp.id = v_payout_id
         AND tp.idempotency_key = p_idempotency_key
         AND tp.tournament_id = p_related_entity_id
         AND tp.user_id = p_user_id
         AND tp.amount = p_amount
         AND tp."position" IS NOT DISTINCT FROM v_payout_place
         AND tp.source IS NOT DISTINCT FROM v_payout_source
    ) THEN
      RAISE EXCEPTION 'prize % could not verify its payout evidence',
        p_idempotency_key USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_credit_player_wallet_once(p_user_id uuid, p_amount numeric, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inserted integer; v_tourn uuid; v_club uuid; v_balance numeric;
  v_is_tournament boolean := false; v_has_any_club boolean;
  v_fallback uuid;
BEGIN
    IF p_idempotency_key IS NOT NULL THEN
        INSERT INTO wallet_credit_idempotency (key, user_id, amount)
        VALUES (p_idempotency_key, p_user_id, p_amount)
        ON CONFLICT (key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        -- FALSE, not void: the caller needs to know it must NOT write a
        -- ledger row for a credit somebody else already made.
        IF v_inserted = 0 THEN RETURN false; END IF;
    END IF;

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key LIKE 'tourney:%' THEN
      v_is_tournament := true;
      BEGIN
        v_tourn := (split_part(p_idempotency_key, ':', 2))::uuid;
      EXCEPTION WHEN OTHERS THEN v_tourn := NULL;
      END;
      IF v_tourn IS NOT NULL THEN
        SELECT tp.club_id INTO v_club FROM tournament_players tp
         WHERE tp.tournament_id = v_tourn AND tp.user_id = p_user_id LIMIT 1;
        IF v_club IS NULL THEN
          SELECT t.club_id INTO v_club FROM tournaments t WHERE t.id = v_tourn;
          v_club := COALESCE(public.fn_player_home_club(p_user_id, NULL), v_club);
        END IF;
      END IF;
    END IF;

    IF v_club IS NULL THEN
      v_club := public.fn_player_home_club(p_user_id, NULL);
    END IF;

    IF v_club IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(p_user_id, v_club);
      UPDATE club_members
         SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
       WHERE user_id = p_user_id AND club_id = v_club
       RETURNING chip_balance INTO v_balance;
      IF v_balance IS NOT NULL THEN RETURN true; END IF;
    END IF;

    /* ZERO-DRIFT (2026-08-31): cross-club tournament entry - the stamped club
       holds no wallet for this player. Follow the money home instead of
       refusing a prize the pool already owes. */
    IF v_is_tournament AND v_tourn IS NOT NULL THEN
      SELECT ct.club_id INTO v_fallback
        FROM chip_transactions ct
        JOIN tournaments t ON t.id = v_tourn
       WHERE ct.from_user_id = p_user_id
         AND ct.transaction_type = 'tournament_buyin'
         AND ct.notes = 'Tournament buy-in: ' || t.name
         AND ct.created_at > COALESCE(t.started_at, t.created_at, now()) - interval '7 days'
         AND EXISTS (SELECT 1 FROM club_members m
                      WHERE m.user_id = p_user_id AND m.club_id = ct.club_id)
       ORDER BY ct.created_at DESC LIMIT 1;
      IF v_fallback IS NULL THEN
        v_fallback := public.fn_player_home_club(p_user_id, NULL);
      END IF;
      IF v_fallback IS NULL THEN
        SELECT m.club_id INTO v_fallback
          FROM club_members m
         WHERE m.user_id = p_user_id
           AND COALESCE(m.status, 'active') IN ('active','approved')
         ORDER BY COALESCE(m.chip_balance, 0) DESC, m.club_id LIMIT 1;
      END IF;
      IF v_fallback IS NOT NULL AND v_fallback IS DISTINCT FROM v_club THEN
        PERFORM public.fn_ensure_club_wallet(p_user_id, v_fallback);
        UPDATE club_members
           SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
         WHERE user_id = p_user_id AND club_id = v_fallback
         RETURNING chip_balance INTO v_balance;
        IF v_balance IS NOT NULL THEN RETURN true; END IF;
      END IF;
    END IF;

    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id)
      INTO v_has_any_club;

    IF v_is_tournament OR v_has_any_club THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical','credit_player_wallet',
              'Club Arena credit could not resolve a club wallet - payment refused rather than pooled',
              jsonb_build_object('user_id',p_user_id,'amount',p_amount,
                                 'idempotency_key',p_idempotency_key,'tournament_id',v_tourn));
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;

    UPDATE wallets SET balance = balance + p_amount, updated_at = NOW()
      WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
    IF NOT FOUND THEN
        INSERT INTO wallets (user_id, wallet_type, balance, locked_balance, created_at, updated_at)
        VALUES (p_user_id, 'PLAYER', p_amount, 0, NOW(), NOW());
    END IF;

    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_raise_server_financial_alert(p_severity text, p_source text, p_message text, p_context jsonb DEFAULT '{}'::jsonb, p_dedupe_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id     uuid;
  v_sev    text;
  v_source text;
  v_key    text;
  v_recent integer;
BEGIN
  v_sev := lower(coalesce(p_severity, 'info'));
  IF v_sev NOT IN ('critical', 'warning', 'info') THEN
    v_sev := 'info';
  END IF;

  v_source := left(coalesce(nullif(p_source, ''), 'unknown'), 200);
  v_key    := left(nullif(btrim(coalesce(p_dedupe_key, '')), ''), 200);

  /* ONE OPEN ALERT PER THING THAT IS WRONG. Not per pass over it. */
  IF v_key IS NOT NULL THEN
    SELECT fa.id INTO v_id
      FROM public.financial_alerts fa
     WHERE fa.source = v_source
       AND fa.resolved IS NOT TRUE
       AND fa.context ->> 'dedupe_key' = v_key
     ORDER BY fa.created_at DESC
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_recent
    FROM public.financial_alerts
   WHERE created_at > now() - interval '1 minute'
     AND source = v_source
     AND context ->> 'channel' = 'server_rpc';

  IF v_recent >= 60 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved)
  VALUES (
    v_sev,
    v_source,
    left(coalesce(nullif(p_message, ''), '(no message)'), 4000),
    coalesce(p_context, '{}'::jsonb)
      || jsonb_build_object('channel', 'server_rpc')
      || CASE WHEN v_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedupe_key', v_key) END,
    false
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_shape(p_key text)
 RETURNS TABLE(source text, place integer)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT split_part(p_key, ':', 1) AS ns,
           split_part(p_key, ':', 3) AS kind,
           split_part(p_key, ':', 4) AS seg4,
           split_part(p_key, ':', 5) AS seg5,
           split_part(p_key, ':', 6) AS seg6
     WHERE p_key LIKE 'tourney:%'
        OR p_key LIKE 'mb:%'
        OR p_key LIKE 'mb-residual:%'
        OR p_key LIKE 'spin:%'
  )
  SELECT
    CASE
      WHEN s.ns = 'mb'                                  THEN 'mystery_bounty'
      WHEN s.ns = 'mb-residual'                         THEN 'mystery_bounty_residual'
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay' THEN 'spin_backpay'
      WHEN s.ns <> 'tourney'                            THEN NULL
      WHEN s.kind = 'prize' AND s.seg6 = 'reconcile'   THEN 'reconcile'
      WHEN s.kind = 'prize' AND s.seg5 = 'hu_shortfall' THEN 'hu_shortfall'
      WHEN s.kind = 'prize' AND s.seg4 = 'place'       THEN 'structure'
      WHEN s.kind = 'prize' AND s.seg5 ~ '^[0-9]+$'    THEN 'structure'
      WHEN s.kind = 'bounty'                            THEN 'bounty'
      WHEN s.kind = 'ownbounty'                         THEN 'own_bounty'
      WHEN s.kind = 'prizeadj'                          THEN 'late_reg_adjustment'
      WHEN s.kind = 'clawback'                          THEN 'clawback'
      WHEN s.kind = 'ftd'                               THEN 'final_table_deal'
      WHEN s.kind = 'vacantplace'
       AND s.seg5 ~ '^[1-9][0-9]*$'                    THEN 'finish_position_correction'
    END,
    CASE
      WHEN s.ns = 'spin' AND s.seg5 = 'unpaid_backpay' THEN 1
      WHEN s.ns <> 'tourney' THEN NULL
      WHEN s.kind IN ('prize','prizeadj','clawback') AND s.seg4 = 'place'
       AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
      WHEN s.kind IN ('prize','prizeadj','clawback')
       AND s.seg5 ~ '^[0-9]+$' THEN s.seg5::integer
      WHEN s.kind = 'vacantplace' AND s.seg5 ~ '^[1-9][0-9]*$'
        THEN s.seg5::integer
    END
  FROM s;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_payouts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_terminal_key bigint := hashtextextended(
    'ca:tournament-terminal-settlement:v1',0);
  v_owns_terminal_root boolean := false;
BEGIN
  IF session_user = 'postgres'
     AND COALESCE(current_setting('app.payout_record_correction', true), '') =
         'i_am_correcting_the_record' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND pg_trigger_depth() >= 2 THEN
    SELECT EXISTS(
      SELECT 1 FROM pg_catalog.pg_locks l
       WHERE l.pid = pg_backend_pid()
         AND l.locktype = 'advisory'
         AND l.database = (
           SELECT d.oid FROM pg_catalog.pg_database d
            WHERE d.datname = current_database())
         AND l.classid = (((v_terminal_key >> 32) & 4294967295)::oid)
         AND l.objid = ((v_terminal_key & 4294967295)::oid)
         AND l.objsubid = 1
         AND l.mode = 'ExclusiveLock'
         AND l.granted)
      INTO v_owns_terminal_root;

    IF v_owns_terminal_root
       AND public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),OLD.tournament_id) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'tournament_payouts is an append-only payout record; % is refused (tournament %, user %, position %)',
    TG_OP, OLD.tournament_id, OLD.user_id, OLD."position"
    USING ERRCODE = 'restrict_violation',
          HINT = 'A DBA correcting a bad row must SET LOCAL app.payout_record_correction = ''i_am_correcting_the_record'' in the same transaction, from a migration that says why.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.zz_a_payout_row_carries_its_key()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  /* It fills the blank, it never refuses. A guard that can refuse a payout row
     could leave a credited player with no record of the credit, and that is the
     worse failure (CLAUDE.md 11.5). With a key present,
     uq_tournament_payouts_idempotency_key - which is partial, WHERE
     idempotency_key IS NOT NULL - can finally do the job it was built for. */
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := 'tourney:' || COALESCE(NEW.tournament_id::text, 'none') || ':' ||
                           COALESCE(NEW.source, 'payout') || ':' ||
                           COALESCE(NEW.user_id::text, 'none') || ':' ||
                           to_char(COALESCE(NEW.amount, 0), 'FM9999999990.00') || ':' ||
                           COALESCE(NEW.position::text, 'x');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF lower(btrim(COALESCE(p_kind,'')))='refund' THEN
    RETURN jsonb_build_object(
      'ok',false,'paid',0,'already_paid',0,
      'refused_reason','exact_refund_authority_required',
      'obligation_id',NULL,'idempotency_key',NULL);
  END IF;
  RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    p_tournament_id,p_kind,p_place,p_user_id,p_amount,p_source,
    p_description,p_adjustment_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(p_tournament_id uuid, p_kind text, p_place integer, p_user_id uuid, p_amount numeric, p_source text, p_description text DEFAULT NULL::text, p_adjustment_id uuid DEFAULT NULL::uuid)
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
  v_payout_source text;
  v_adj         public.ca_manual_adjustments%ROWTYPE;
  v_src         text := lower(btrim(COALESCE(p_source, '')));
  v_can         jsonb;
  v_short       numeric;
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
  IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'invalid_amount', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;
  IF p_amount < 0 THEN
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

  IF v_row_kind = 'place' AND v_place <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
      'refused_reason', 'invalid_place', 'obligation_id', NULL, 'idempotency_key', NULL);
  END IF;

  -- Kill switch (Lane E): an open freeze on tournament payouts refuses everything.
  IF to_regclass('public.ca_payout_freeze') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
                WHERE f.scope = 'tournament_payouts' AND f.cleared_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'payout_frozen', 'obligation_id', NULL, 'idempotency_key', NULL);
    END IF;
  END IF;

  /* CHIP STANDARD PHASE 6.1 (2026-09-05): A SETTLEMENT FROM OUTSIDE THE
     PLATFORM NEEDS AN APPROVED ADJUSTMENT. The engine, the recovery and the
     registered doors settle under their own names (ca_settle_sources). Any
     other caller - a migration, an operator, an agent under CLAUDE.md 10.9 -
     must name a ca_manual_adjustments row that is approved, for this event,
     this player, at least this amount, in chips; the row is marked settled
     when the chips move and the obligation carries its id. p_adjustment_id
     was accepted and ignored until today. */
  IF NOT (v_src LIKE 'engine.%' OR EXISTS (SELECT 1 FROM public.ca_settle_sources s WHERE s.source = v_src)) THEN
    IF p_adjustment_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_required', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', format('source %s is not a platform settle source; name an approved ca_manual_adjustments row (fn_ca_adjustment_under_10_9 writes one)', COALESCE(NULLIF(v_src, ''), '<none>')));
    END IF;
    SELECT * INTO v_adj FROM public.ca_manual_adjustments WHERE id = p_adjustment_id FOR UPDATE;
    IF NOT FOUND OR v_adj.status <> 'approved' OR v_adj.asset <> 'chips'
       OR v_adj.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_adj.target_kind <> 'player_wallet' OR v_adj.target_id IS DISTINCT FROM p_user_id
       OR v_adj.amount < v_amount THEN
      RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', 0,
        'refused_reason', 'adjustment_mismatch', 'obligation_id', NULL, 'idempotency_key', NULL,
        'detail', 'the adjustment must be approved, in chips, for this tournament, this player wallet, and at least this amount');
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
  -- The player on record for a place is whoever was first paid for it; a
  -- different user asking for an already-paid place gets a refusal, not chips.
  IF v_place IS NOT NULL AND v_ob.user_id IS NOT NULL AND v_ob.user_id <> p_user_id AND v_ob.amount_paid > 0 THEN
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'place_paid_to_another_user', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

    IF v_amount > v_ob.amount_owed THEN
      UPDATE public.tournament_obligations
         SET amount_owed = v_amount, updated_at = now(), user_id = COALESCE(user_id, p_user_id)
       WHERE id = v_ob.id
       RETURNING * INTO v_ob;
    END IF;
  END IF;

  v_pay := round(LEAST(v_amount, v_ob.amount_owed) - v_ob.amount_paid, 2);
  IF v_pay <= 0 THEN
    -- A replay of an older, smaller request can still leave the recorded
    -- obligation unpaid. Report the durable total, not the caller's amount.
    RETURN jsonb_build_object('ok', true, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid,
      'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid),
      'fully_settled', v_ob.amount_paid >= v_ob.amount_owed,
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

  /* R1 (chip standard Phase 5.1, 2026-09-04): the ESCROW BALANCE decides.
     tournament_escrow holds what the event holds, per bank; a place is paid
     from the prize bank, a bounty from the bounty bank, a refund from all
     three. When the balance knows the event, the counter cap below is not
     consulted; the escrow trigger refuses again inside the credit if a race
     gets past this read. An event the balance has never seen (opened on its
     first row) keeps the old counter cap for this call. */
  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);

  /* A BANK THAT IS SHORT PAYS WHAT IT HOLDS (2026-09-07). This used to refuse
     the whole payment, so a bank 180.00 short of a 13,441.68 obligation paid
     the winner nothing and froze 13,261.68 - three events were sitting like
     that when this was written. Paying what is there takes nothing from
     anybody: amount_owed is untouched, so the remainder stays owed and
     payable, and the credit is still capped by the bank and refused again by
     the escrow trigger if a race gets past this read. */
  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean
     AND COALESCE((v_can->>'available')::numeric, 0) >= 0.01 THEN
    v_short := round(v_pay - (v_can->>'available')::numeric, 2);
    v_pay   := round((v_can->>'available')::numeric, 2);
    v_alert_ctx := jsonb_build_object('kind','escrow_short_paid_what_it_holds',
      'tournament_id',p_tournament_id,'tournament',v_t.name,'user_id',p_user_id,
      'obligation_kind',v_kind,'place',v_place,'paid',v_pay,'still_owed',v_short,
      'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,
      'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Paid %s of %s to %s for %s and %s is still owed: the escrow bank was short (%s)',
             v_pay, v_pay + v_short, p_user_id, v_kind, v_short, v_t.name),
      v_alert_ctx, 'obl:escrow_short_partial:' || v_ob.id::text);
    v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  END IF;

  IF (v_can->>'known')::boolean AND NOT (v_can->>'ok')::boolean THEN
    v_alert_ctx := jsonb_build_object('kind','escrow_short','tournament_id',p_tournament_id,'tournament',v_t.name,
      'user_id',p_user_id,'obligation_kind',v_kind,'place',v_place,'requested',v_pay,
      'escrow_available',(v_can->>'available')::numeric,'prize_balance',(v_can->>'prize_balance')::numeric,
      'bounty_balance',(v_can->>'bounty_balance')::numeric,'fee_balance',(v_can->>'fee_balance')::numeric,'source',p_source);
    PERFORM public.fn_raise_server_financial_alert('critical','fn_settle_tournament_obligation',
      format('Refused %s to %s for %s: the escrow holds %s for that bank (%s)',
             v_pay, p_user_id, v_kind, (v_can->>'available')::numeric, v_t.name),
      v_alert_ctx, 'obl:escrow_short:' || v_ob.id::text);
    RETURN jsonb_build_object('ok', false, 'paid', 0, 'already_paid', v_ob.amount_paid,
      'refused_reason', 'escrow_short', 'obligation_id', v_ob.id, 'idempotency_key', NULL);
  END IF;

  -- R1-lite (counter cap), only for an event the balance has never seen.
  IF v_row_kind = ANY (v_pool_kinds) AND NOT (v_can->>'known')::boolean THEN
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
  /* THE PAYOUT RECORD KEEPS ITS CLASS (2026-09-02). tournament_payouts.source is
     the CLASS of a payment ('structure', 'reconcile', 'late_reg_adjustment',
     'final_table_deal', ...) and every detector downstream filters on it:
     fn_tournament_guarantee_check and fn_tournament_double_paid_obligations
     whitelist it, fn_payout_guarantee_check blacklists the bounty classes. The
     engine calls this function with its own provenance ('engine.finishTournament'
     and friends), which the first build wrote straight into that column - so
     the moment the engine cut over, the guarantee check would have counted
     every engine-paid place as unpaid. Provenance stays on
     tournament_obligations.source; the payout row gets the class. */
  v_payout_source := CASE
    WHEN lower(COALESCE(p_source, '')) IN ('structure','reconcile','hu_shortfall','spin_backpay',
         'overlay_backpay','late_reg_adjustment','final_table_deal','bubble_protection',
         'satellite_remainder','clawback') THEN lower(p_source)
    WHEN v_kind = 'late_reg_adjustment' THEN 'late_reg_adjustment'
    WHEN v_row_kind IN ('final_table_deal','bubble_protection','satellite_remainder') THEN v_row_kind
    ELSE 'structure'
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
    CASE WHEN v_category = 'prize' THEN v_payout_source ELSE NULL END);

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
         adjustment_id = COALESCE(adjustment_id, p_adjustment_id),
         updated_at  = now(),
         settled_at  = CASE WHEN amount_paid + v_pay >= amount_owed THEN now() ELSE settled_at END
   WHERE id = v_ob.id;
  IF v_adj.id IS NOT NULL THEN
    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj.id;
  END IF;

  -- ok acknowledges this operation; it is not proof that the entire debt
  -- was paid. v_ob holds the pre-credit row, so include this call's v_pay.
  RETURN jsonb_build_object('ok', true, 'paid', v_pay, 'already_paid', v_ob.amount_paid,
    'amount_owed', v_ob.amount_owed, 'amount_paid', v_ob.amount_paid + v_pay,
    'remaining', GREATEST(0, v_ob.amount_owed - v_ob.amount_paid - v_pay),
    'fully_settled', v_ob.amount_paid + v_pay >= v_ob.amount_owed,
    'refused_reason', NULL, 'obligation_id', v_ob.id, 'idempotency_key', v_key);
END;
$function$;

CREATE UNIQUE INDEX ux_tournament_obligations_place ON public.tournament_obligations USING btree (tournament_id, kind, place) WHERE (place IS NOT NULL);

CREATE UNIQUE INDEX ux_tournament_obligations_user ON public.tournament_obligations USING btree (tournament_id, kind, user_id) WHERE (place IS NULL);

CREATE UNIQUE INDEX uq_tournament_payouts_idempotency_key ON public.tournament_payouts USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE TRIGGER zz_a_payout_row_carries_its_key BEFORE INSERT ON public.tournament_payouts FOR EACH ROW EXECUTE FUNCTION public.zz_a_payout_row_carries_its_key();

CREATE TRIGGER trg_tournament_payouts_append_only BEFORE DELETE OR UPDATE ON public.tournament_payouts FOR EACH ROW EXECUTE FUNCTION public.fn_tournament_payouts_are_append_only();
