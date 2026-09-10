-- Current installed guarantee funding functions. No production data.
ALTER TABLE public.clubs ADD COLUMN chip_treasury numeric DEFAULT 0, ADD COLUMN chip_pool numeric DEFAULT 0, ADD COLUMN promo_balance numeric DEFAULT 0, ADD COLUMN insurance_balance numeric DEFAULT 0, ADD COLUMN name text, ADD COLUMN updated_at timestamptz;
ALTER TABLE public.unions ADD COLUMN name text;

CREATE TABLE public.financial_alerts (
id uuid NOT NULL DEFAULT gen_random_uuid(),
severity text NOT NULL,
source text NOT NULL,
message text NOT NULL,
context jsonb DEFAULT '{}'::jsonb,
resolved boolean NOT NULL DEFAULT false,
resolved_at timestamp with time zone,
created_at timestamp with time zone NOT NULL DEFAULT now(),
resolved_by uuid,
resolution text,
CONSTRAINT financial_alerts_pkey PRIMARY KEY (id),
CONSTRAINT financial_alerts_severity_check CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])))
);

CREATE TABLE public.union_wallet_transactions (
id uuid NOT NULL DEFAULT gen_random_uuid(),
union_id uuid NOT NULL,
wallet text NOT NULL,
direction text NOT NULL,
amount numeric(20,4) NOT NULL,
balance_after numeric(20,4),
tx_type text NOT NULL,
club_id uuid,
period_id uuid,
notes text,
created_by uuid,
created_at timestamp with time zone NOT NULL DEFAULT now(),
CONSTRAINT chk_amount_is_two_decimal_places CHECK (((amount IS NULL) OR (amount = round(amount, 2)))),
CONSTRAINT ck_whole_cents CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID,
CONSTRAINT union_wallet_transactions_amount_check CHECK ((amount > (0)::numeric)),
CONSTRAINT union_wallet_transactions_direction_check CHECK ((direction = ANY (ARRAY['credit'::text, 'debit'::text]))),
CONSTRAINT union_wallet_transactions_pkey PRIMARY KEY (id),
CONSTRAINT union_wallet_transactions_wallet_check CHECK ((wallet = ANY (ARRAY['chip_balance'::text, 'rake_wallet'::text, 'bbj_wallet'::text, 'promo_wallet'::text, 'insurance_wallet'::text, 'spin_reserve_wallet'::text])))
);

CREATE TABLE public.union_wallets (
id uuid NOT NULL DEFAULT gen_random_uuid(),
union_id uuid NOT NULL,
chip_balance numeric(20,2) NOT NULL DEFAULT 0,
rake_wallet numeric(20,2) DEFAULT 0,
bbj_wallet numeric(20,2) DEFAULT 0,
promo_wallet numeric(20,2) DEFAULT 0,
insurance_wallet numeric(20,2) DEFAULT 0,
total_rake_collected numeric(20,2) DEFAULT 0,
total_settlements numeric DEFAULT 0,
updated_at timestamp with time zone DEFAULT now(),
created_at timestamp with time zone DEFAULT now(),
spin_reserve_wallet numeric(20,2) NOT NULL DEFAULT 0,
CONSTRAINT union_wallets_bbj_wallet_nonneg CHECK ((bbj_wallet >= (0)::numeric)),
CONSTRAINT union_wallets_chip_balance_nonneg CHECK ((chip_balance >= (0)::numeric)),
CONSTRAINT union_wallets_insurance_wallet_nonneg CHECK ((insurance_wallet >= (0)::numeric)),
CONSTRAINT union_wallets_pkey PRIMARY KEY (id),
CONSTRAINT union_wallets_promo_wallet_nonneg CHECK ((promo_wallet >= (0)::numeric)),
CONSTRAINT union_wallets_rake_wallet_nonneg CHECK ((rake_wallet >= (0)::numeric)),
CONSTRAINT union_wallets_spin_reserve_wallet_nonneg CHECK ((spin_reserve_wallet >= (0)::numeric)),
CONSTRAINT union_wallets_union_id_key UNIQUE (union_id)
);

CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid PRIMARY KEY);
CREATE TABLE public.tournament_terminal_settlements(tournament_id uuid PRIMARY KEY);
CREATE TABLE public.tournament_satellite_settlements(tournament_id uuid PRIMARY KEY);

-- Installed Body MD5: 4f921617438bfcfb0b9db32ff490b81d
CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_overlay numeric;
  v_ledger_count integer;
  v_escrow public.tournament_escrow%ROWTYPE;
BEGIN
  v_result:=public.fn_ca_apply_prize_guarantee_core(
    p_tournament_id,p_source);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;
  v_overlay:=COALESCE((v_result->>'overlay')::numeric,0);
  IF v_overlay::text IN ('NaN','Infinity','-Infinity')
     OR v_overlay<0 OR v_overlay IS DISTINCT FROM round(v_overlay,2) THEN
    RAISE EXCEPTION 'guarantee core returned invalid overlay %',v_overlay
      USING ERRCODE='P0404';
  END IF;
  IF v_overlay>0 THEN
    SELECT count(*) INTO v_ledger_count
      FROM public.chip_ledger l
     WHERE l.idempotency_key=
             'tourney:'||p_tournament_id::text||':guarantee_overlay'
       AND l.tournament_id=p_tournament_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=p_tournament_id
       AND l.category='overlay'
       AND l.amount=v_overlay
       AND l.from_entity_id=(v_result->>'bank_entity_id')::uuid
       AND l.from_type=CASE WHEN v_result->>'bank_type'='union'
                            THEN 'union_bank' ELSE 'club_treasury' END;
    SELECT * INTO v_escrow
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id
     FOR UPDATE;
    IF v_ledger_count<>1 OR NOT FOUND
       OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
       OR v_result->>'escrow_after' IS NULL
       OR v_escrow.prize_balance IS DISTINCT FROM
            (v_result->>'escrow_after')::numeric THEN
      RAISE EXCEPTION
        'guarantee overlay is not one exact journaled escrow credit'
        USING ERRCODE='P0404';
    END IF;
  END IF;
  RETURN v_result||jsonb_build_object('overlay_journaled',true);
END;
$function$;

-- Installed Body MD5: 94da16bc96c962220defa690338d75ec
CREATE OR REPLACE FUNCTION public.fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t                    record;
  v_after                record;
  v_overlay_row          public.tournament_guarantee_overlays%ROWTYPE;
  v_result               jsonb;
  v_pool_before          numeric := 0;
  v_guarantee            numeric := 0;
  v_final                numeric := 0;
  v_overlay              numeric := 0;
  v_escrow_before        numeric := 0;
  v_escrow_after         numeric := 0;
  v_escrow_before_found  boolean := false;
  v_escrow_after_found   boolean := false;
  v_escrow_enforced      boolean := false;
  v_union                uuid;
  v_expected_bank_type   text;
  v_expected_bank_entity uuid;
  v_club_bank_before     numeric := 0;
  v_bank_before          numeric := 0;
  v_bank_after           numeric := 0;
  v_bank_row_found       boolean := false;
  v_ledger_inserted      integer := 0;
  v_old_category         text;
  v_old_counterparty     text;
  v_old_entity           text;
  v_old_tournament       text;
  v_failure              text;
  v_failure_state        text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.id, t.club_id, t.name, t.status, t.union_id,
         COALESCE(t.is_private, false) AS is_private,
         round(COALESCE(t.prize_pool, 0), 2) AS pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
         COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
                              'retryable', false);
  END IF;

  v_pool_before := v_t.pool;
  v_guarantee := v_t.guarantee;
  v_final := GREATEST(v_pool_before, v_guarantee);
  v_overlay := round(v_final - v_pool_before, 2);

  /* Finalized is irreversible. A published pool that was finalized below its
     guarantee is evidence requiring an explicit, reviewed correction; the
     runtime must never reopen and silently reprice it. */
  IF v_t.finalized AND v_pool_before + 0.005 < v_guarantee THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'finalized_guarantee_is_below_published_floor',
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', false);
  END IF;

  SELECT round(COALESCE(e.prize_balance, 0), 2)
    INTO v_escrow_before
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  v_escrow_before_found := FOUND;

  BEGIN
    IF v_overlay > 0 THEN
      /* Lock and snapshot the real bank before calling the legacy debit core.
         Its overlay row describes the movement; only the live before/after
         balance proves that movement happened exactly once. */
      SELECT round(COALESCE(c.chip_treasury, 0), 2)
        INTO v_club_bank_before
        FROM public.clubs c
       WHERE c.id = v_t.club_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee host club does not exist',
                              ERRCODE = '23503';
      END IF;

      /* Funding ownership was captured on the event. A later club union move
         cannot redirect this liability, and a private event always belongs to
         its host club even when that club is currently union-affiliated. */
      v_union := CASE WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
      IF v_union IS NOT NULL THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_before
          FROM public.union_wallets uw
         WHERE uw.union_id = v_union
         FOR UPDATE;
        v_bank_row_found := FOUND;
      END IF;
      IF v_bank_row_found THEN
        v_expected_bank_type := 'union';
        v_expected_bank_entity := v_union;
      ELSE
        v_expected_bank_type := 'club';
        v_expected_bank_entity := v_t.club_id;
        v_bank_before := v_club_bank_before;
      END IF;
      IF v_bank_before + 0.005 < v_overlay THEN
        RAISE EXCEPTION USING
          MESSAGE = format(
            'guarantee bank holds %s but the advertised overlay requires %s',
            v_bank_before, v_overlay),
          ERRCODE = '23514';
      END IF;
    END IF;

    v_old_category := current_setting('app.ledger_category', true);
    v_old_counterparty := current_setting('app.ledger_counterparty', true);
    v_old_entity := current_setting('app.ledger_counterparty_entity', true);
    v_old_tournament := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);

    v_result := public.fn_apply_prize_guarantee_before_atomic_proof(
      p_tournament_id, COALESCE(NULLIF(btrim(p_source), ''), 'engine'));
    IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = COALESCE(v_result->>'reason', 'guarantee core refused'),
                            ERRCODE = '23514';
    END IF;
    IF v_overlay > 0 AND COALESCE((v_result->>'already_funded')::boolean, false) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'an existing overlay claim did not prove this short pool was funded',
        ERRCODE = '23514';
    END IF;

    IF v_overlay > 0 THEN
      SELECT * INTO v_overlay_row
        FROM public.tournament_guarantee_overlays o
       WHERE o.tournament_id = p_tournament_id
       FOR UPDATE;
      IF NOT FOUND
         OR v_overlay_row.club_id IS DISTINCT FROM v_t.club_id
         OR abs(round(v_overlay_row.amount, 2) - v_overlay) > 0.005
         OR abs(round(v_overlay_row.pool_before, 2) - v_pool_before) > 0.005
         OR abs(round(v_overlay_row.pool_after, 2) - v_final) > 0.005
         OR v_overlay_row.bank_type IS DISTINCT FROM v_expected_bank_type
         OR v_overlay_row.bank_entity_id IS DISTINCT FROM v_expected_bank_entity
         OR v_overlay_row.treasury_after IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay claim does not match its bank debit and pool',
                              ERRCODE = '23514';
      END IF;

      IF v_expected_bank_type = 'union' THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_after
          FROM public.union_wallets uw
         WHERE uw.union_id = v_expected_bank_entity
         FOR UPDATE;
      ELSE
        SELECT round(COALESCE(c.chip_treasury, 0), 2)
          INTO v_bank_after
          FROM public.clubs c
         WHERE c.id = v_expected_bank_entity
         FOR UPDATE;
      END IF;
      IF NOT FOUND
         OR abs(v_bank_after - (v_bank_before - v_overlay)) > 0.005
         OR abs(round(v_overlay_row.treasury_after, 2) - v_bank_after) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee bank did not debit the exact overlay',
                              ERRCODE = '23514';
      END IF;

      /* The legacy core's balance UPDATE produces an auto-ledger twin. Live
         escrow deliberately ignores auto-ledger overlay rows, so publish the
         one explicit, deterministic bank -> prize-liability leg it requires.
         This insert is in the same subtransaction as the bank debit. */
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, idempotency_key, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        CASE WHEN v_expected_bank_type = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
        v_expected_bank_entity, 'prize_liability', p_tournament_id,
        v_overlay, 'overlay', v_t.club_id, p_tournament_id,
        'tourney:' || p_tournament_id::text || ':guarantee_overlay',
        'Guarantee Overlay Funded For ' || COALESCE(v_t.name, p_tournament_id::text))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS v_ledger_inserted = ROW_COUNT;
      IF v_ledger_inserted <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay journal key already exists unexpectedly',
                              ERRCODE = '23505';
      END IF;
    END IF;

    SELECT t.status, round(COALESCE(t.prize_pool, 0), 2) AS pool,
           round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
           COALESCE(t.prize_pool_finalized, false) AS finalized
      INTO v_after
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND OR NOT v_after.finalized
       OR abs(v_after.pool - v_final) > 0.005
       OR v_after.pool + 0.005 < v_after.guarantee THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee core did not publish the exact funded final pool',
                            ERRCODE = '23514';
    END IF;

    SELECT COALESCE(e.enforced, false), round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_after_found := FOUND;
    IF v_overlay > 0 AND (
         NOT v_escrow_after_found OR NOT v_escrow_enforced
         OR abs((v_escrow_after - CASE WHEN v_escrow_before_found
                                      THEN v_escrow_before ELSE 0 END) - v_overlay) > 0.005
       ) THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee bank debit did not credit live escrow exactly',
                            ERRCODE = '23514';
    END IF;

    PERFORM set_config('app.ledger_category', COALESCE(v_old_category, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_old_counterparty, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_old_entity, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_old_tournament, ''), true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_guarantee_funding_aborted',
      'detail', v_failure, 'sqlstate', v_failure_state,
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'prize_pool', v_after.pool,
    'overlay', v_overlay, 'bank_type', v_expected_bank_type,
    'bank_entity_id', v_expected_bank_entity,
    'bank_before', CASE WHEN v_overlay > 0 THEN v_bank_before ELSE NULL END,
    'bank_after', CASE WHEN v_overlay > 0 THEN v_bank_after ELSE NULL END,
    'treasury_after', CASE WHEN v_overlay > 0 THEN v_bank_after ELSE NULL END,
    'escrow_before', CASE WHEN v_escrow_before_found THEN v_escrow_before ELSE NULL END,
    'escrow_after', CASE WHEN v_escrow_after_found THEN v_escrow_after ELSE NULL END,
    'already_finalized', v_t.finalized AND v_overlay = 0,
    'retryable', false);
END;
$function$;

-- Installed Body MD5: 6684789511427780f35e15b8bf1d9277
CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee_before_atomic_proof(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_t record; v_overlay numeric; v_final numeric; v_claimed integer;
  v_union uuid; v_bank_type text; v_bank_entity uuid;
  v_balance_after numeric; v_bank_name text; v_updated integer;
  v_note text := 'Guarantees are funded daily; union rake returns at the '
              || 'weekly rakeback close, so a mid-week dip is usually timing. '
              || 'Escalate if it survives a close.';
begin
  select t.id, t.club_id, t.name, t.union_id, coalesce(t.is_private, false) as is_private,
         coalesce(t.prize_pool, 0) as pool,
         coalesce(t.guaranteed_prize, 0) as gtd, coalesce(t.prize_pool_finalized, false) as finalized
    into v_t from public.tournaments t where t.id = p_tournament_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_t.finalized then
    return jsonb_build_object('ok', true, 'already_finalized', true, 'prize_pool', v_t.pool);
  end if;

  v_final := greatest(v_t.pool, v_t.gtd);
  v_overlay := round(v_final - v_t.pool, 2);

  if v_overlay > 0 then
    -- ZERO-DRIFT phase 2: overlay funding = 'overlay' vs the tournament.
    perform set_config('app.ledger_category', 'overlay', true);
    perform set_config('app.ledger_counterparty', 'prize_liability', true);
    perform set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    -- The event owns its funding scope, as in fn_ca_fund_overlay_on_lock.
    -- A club joining another union must not redirect this event's guarantee.
    v_union := CASE WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
    if v_union is not null then
      v_bank_type := 'union'; v_bank_entity := v_union;
    else
      v_bank_type := 'club'; v_bank_entity := v_t.club_id;
    end if;

    insert into public.tournament_guarantee_overlays
      (tournament_id, club_id, amount, pool_before, pool_after, source,
       bank_type, bank_entity_id, union_id)
    values (p_tournament_id, v_t.club_id, v_overlay, v_t.pool, v_final,
            coalesce(p_source, 'engine'), v_bank_type, v_bank_entity, v_union)
    on conflict (tournament_id) do nothing;
    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
      update public.tournaments set prize_pool_finalized = true where id = p_tournament_id;
      return jsonb_build_object('ok', true, 'already_funded', true, 'prize_pool', v_t.pool);
    end if;

    if v_bank_type = 'union' then
      update public.union_wallets
         set chip_balance = coalesce(chip_balance, 0) - v_overlay,
             updated_at = now()
       where union_id = v_union
       returning chip_balance into v_balance_after;

      if v_balance_after is null then
        update public.tournament_guarantee_overlays
           set bank_type = 'club', bank_entity_id = v_t.club_id
         where tournament_id = p_tournament_id;
        update public.clubs
           set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
         where id = v_t.club_id
         returning chip_treasury into v_balance_after;
        v_bank_type := 'club'; v_bank_entity := v_t.club_id;
      else
        insert into public.union_wallet_transactions
          (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
        values
          (v_union, 'chip_balance', 'debit', v_overlay, v_balance_after,
           'guarantee_overlay', v_t.club_id,
           'Overlay for tournament ' || coalesce(v_t.name, p_tournament_id::text)
             || ' (' || p_tournament_id || '), pool ' || v_t.pool || ' -> ' || v_final);
      end if;
    else
      update public.clubs
         set chip_treasury = coalesce(chip_treasury, 0) - v_overlay, updated_at = now()
       where id = v_t.club_id
       returning chip_treasury into v_balance_after;
    end if;

    -- A missing bank must not manufacture an overlay or finalize the pool.
    -- RETURNING yields a non-null numeric balance after any actual debit,
    -- including the existing union-to-club fallback.
    if v_balance_after is null then
      raise exception 'guarantee_funding_bank_missing: tournament %, bank %/%',
        p_tournament_id, v_bank_type, v_bank_entity;
    end if;

    update public.tournament_guarantee_overlays
       set treasury_after = v_balance_after
     where tournament_id = p_tournament_id;

    select case when v_bank_type = 'union'
                then (select u.name from public.unions u where u.id = v_union)
                else (select c.name from public.clubs c where c.id = v_t.club_id) end
      into v_bank_name;

    if v_balance_after is not null and v_balance_after < 0 then
      update public.financial_alerts
         set severity = 'critical',
             message = 'Bank is negative from funding advertised guarantees: '
                       || coalesce(v_bank_name, v_bank_entity::text),
             context = jsonb_build_object(
                         'bank_type', v_bank_type,
                         'bank_entity_id', v_bank_entity,
                         'club_id', v_t.club_id,
                         'balance_after', v_balance_after,
                         'shortfall', round(-v_balance_after, 2),
                         'latest_tournament_id', p_tournament_id,
                         'latest_overlay', v_overlay,
                         'note', v_note),
             created_at = now()
       where source = 'fn_apply_prize_guarantee'
         and resolved is not true
         and context->>'bank_entity_id' = v_bank_entity::text;
      get diagnostics v_updated = row_count;

      if v_updated = 0 then
        insert into public.financial_alerts (severity, source, message, context)
        values ('critical', 'fn_apply_prize_guarantee',
                'Bank is negative from funding advertised guarantees: '
                  || coalesce(v_bank_name, v_bank_entity::text),
                jsonb_build_object(
                  'bank_type', v_bank_type,
                  'bank_entity_id', v_bank_entity,
                  'club_id', v_t.club_id,
                  'balance_after', v_balance_after,
                  'shortfall', round(-v_balance_after, 2),
                  'latest_tournament_id', p_tournament_id,
                  'latest_overlay', v_overlay,
                  'note', v_note));
      end if;
    end if;
  end if;

  update public.tournaments
     set prize_pool = v_final, prize_pool_finalized = true
   where id = p_tournament_id;

  return jsonb_build_object('ok', true, 'prize_pool', v_final,
    'overlay', coalesce(v_overlay, 0),
    'bank_type', v_bank_type, 'bank_entity_id', v_bank_entity,
    'treasury_after', v_balance_after);
end;
$function$;

-- Installed Body MD5: 936fc64feb1ee48cd7d4ea0ac8d2c121
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid;
  v_club uuid; v_union uuid; v_entity uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE NULL END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;

-- Installed Body MD5: 9dc93e1a464e6694f588345f19640869
CREATE OR REPLACE FUNCTION public.fn_cancelled_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_tournament_id uuid;
  v_new_tournament_id uuid;
  v_tournament_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    v_old_tournament_id:=NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP<>'DELETE' THEN
    v_new_tournament_id:=NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  END IF;
  IF TG_OP='UPDATE' AND v_new_tournament_id IS DISTINCT FROM v_old_tournament_id THEN
    RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
      USING ERRCODE='55000';
  END IF;
  v_tournament_id:=COALESCE(v_new_tournament_id,v_old_tournament_id);
  IF v_tournament_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME='chip_ledger' AND TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM public.tournaments t
     WHERE t.id=v_tournament_id FOR KEY SHARE;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts h
              WHERE h.tournament_id=v_tournament_id) THEN
    RAISE EXCEPTION 'cancelled tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

-- Installed Body MD5: e6fbb738a0528aa0f32e33d004bf2045
CREATE OR REPLACE FUNCTION public.fn_terminal_tournament_evidence_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_status text;
  v_receipted boolean := false;
  v_old_marker timestamptz;
  v_new_marker timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_tournament_id := NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NULLIF(to_jsonb(NEW)->>'tournament_id','')::uuid IS DISTINCT FROM
       NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid THEN
      RAISE EXCEPTION '% rows cannot move between tournaments',TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  ELSE
    v_tournament_id := NULLIF(to_jsonb(OLD)->>'tournament_id','')::uuid;
  END IF;

  IF v_tournament_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND to_jsonb(OLD) ? 'terminal_closed_at' THEN
    v_old_marker := NULLIF(to_jsonb(OLD)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP <> 'DELETE' AND to_jsonb(NEW) ? 'terminal_closed_at' THEN
    v_new_marker := NULLIF(to_jsonb(NEW)->>'terminal_closed_at','')::timestamptz;
  END IF;
  IF TG_OP = 'INSERT' AND v_new_marker IS NOT NULL THEN
    RAISE EXCEPTION '% rows cannot supply a terminal marker',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP <> 'INSERT' AND v_old_marker IS NOT NULL THEN
    RAISE EXCEPTION 'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND v_new_marker IS DISTINCT FROM v_old_marker THEN
    IF public.fn_ca_terminal_marker_transition_is_exact(
         to_jsonb(OLD),to_jsonb(NEW),v_tournament_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% terminal marker transition is not canonical',TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  -- A journal row is durable testimony from the instant it names a
  -- tournament. Refuse its UPDATE/DELETE without taking a child-to-parent
  -- lock; a row trigger already owns the child tuple at this point. INSERT is
  -- the only operation that takes the root lock, which preserves the
  -- parent-to-child order used by both terminal authorities.
  IF TG_TABLE_NAME = 'chip_ledger' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tournament chip ledger evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id
     FOR SHARE;
  ELSE
    SELECT upper(COALESCE(t.status::text,'')) INTO v_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.tournament_terminal_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_satellite_settlements h
            WHERE h.tournament_id = v_tournament_id)
      OR EXISTS (
           SELECT 1 FROM public.tournament_cancellation_receipts h
            WHERE h.tournament_id = v_tournament_id)
    INTO v_receipted;
  IF v_status IN ('COMPLETED','CANCELLED','CANCELED')
     AND (TG_OP = 'INSERT' OR v_receipted) THEN
    RAISE EXCEPTION
      'terminal tournament % has immutable % evidence',
      v_tournament_id,TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

-- Installed Body MD5: d59358cb9ddfc8f84c48aa2469f68897
CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_overlay_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Explicit rows only: the autoledger twin (description 'auto-ledgered ...')
  -- of the same debit is not a second overlay. None has been written since
  -- the lock trigger was fixed on 09-03; the shadow still skips them.
  IF COALESCE(NEW.description, '') LIKE 'auto-ledgered%' THEN RETURN NULL; END IF;
  PERFORM public.fn_ca_escrow_apply(NEW.to_entity_id, 'overlay', p_overlay_in => round(NEW.amount, 2));
  RETURN NULL;
END;
$function$;

-- Installed Body MD5: 3c9ce32b45c11b7372654c6efa89f667
CREATE OR REPLACE FUNCTION public.fn_ca_terminal_marker_transition_is_exact(p_old jsonb, p_new jsonb, p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    p_old ? 'terminal_closed_at'
    AND p_new ? 'terminal_closed_at'
    AND NULLIF(p_old->>'terminal_closed_at','') IS NULL
    AND NULLIF(p_new->>'terminal_closed_at','') IS NOT NULL
    AND (p_new - 'terminal_closed_at') IS NOT DISTINCT FROM
        (p_old - 'terminal_closed_at')
    AND EXISTS (
      SELECT 1
        FROM public.tournaments t
       WHERE t.id = p_tournament_id
         AND upper(COALESCE(t.status::text,'')) IN
             ('COMPLETED','CANCELLED','CANCELED')
         AND t.ended_at IS NOT NULL
         AND isfinite(t.ended_at)
         AND NULLIF(p_new->>'terminal_closed_at','')::timestamptz
               IS NOT DISTINCT FROM t.ended_at
    ),false)
$function$;

CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
