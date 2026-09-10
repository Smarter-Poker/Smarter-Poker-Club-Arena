-- Exact installed reservation definitions captured 2026-09-10. Not a production migration.
-- Scope: seed, reserve, reveal. No payout implementation or payment stub is installed.
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.actor',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('test.role',true),''),'service_role') $$;
CREATE TABLE public.tournaments(
 id uuid PRIMARY KEY, is_mystery_bounty boolean, prize_pool_finalized boolean,
 bounty_pool numeric, bounty_pool_paid numeric, mystery_bounty_stage text,
 mystery_bounty_pool_percent numeric, mystery_bounty_regular_pool_percent numeric,
 mystery_bounty_pool_cents bigint, mystery_bounty_activated_at timestamptz,
 mystery_bounty_activated_players integer);
CREATE TABLE public.tournament_bounty_award_recipients (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  award_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  is_designated_revealer boolean DEFAULT false NOT NULL,
  paid_at timestamp with time zone,
  terminal_closed_at timestamp with time zone,
  CONSTRAINT tournament_bounty_award_recipients_amount_cents_check CHECK ((amount_cents >= 0)),
  CONSTRAINT tournament_bounty_award_recipients_award_id_user_id_key UNIQUE (award_id, user_id),
  CONSTRAINT tournament_bounty_award_recipients_pkey PRIMARY KEY (id)
);
CREATE TABLE public.tournament_bounty_awards (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tournament_id uuid NOT NULL,
  chest_id uuid NOT NULL,
  table_id uuid,
  hand_id text,
  eliminated_user_id uuid NOT NULL,
  amount_cents bigint NOT NULL,
  tier text NOT NULL,
  status text DEFAULT 'reserved'::text NOT NULL,
  op_id uuid NOT NULL,
  reserved_at timestamp with time zone DEFAULT now() NOT NULL,
  revealed_at timestamp with time zone,
  paid_at timestamp with time zone,
  reveal_deadline_at timestamp with time zone,
  bounty_obligation_id uuid,
  activation_generation bigint,
  terminal_closed_at timestamp with time zone,
  CONSTRAINT tournament_bounty_awards_amount_cents_check CHECK ((amount_cents > 0)),
  CONSTRAINT tournament_bounty_awards_bound_generation_present CHECK (((bounty_obligation_id IS NULL) OR (activation_generation IS NOT NULL))),
  CONSTRAINT tournament_bounty_awards_op_id_key UNIQUE (op_id),
  CONSTRAINT tournament_bounty_awards_pkey PRIMARY KEY (id),
  CONSTRAINT tournament_bounty_awards_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'revealed'::text, 'paid'::text, 'completed'::text, 'void'::text])))
);
CREATE UNIQUE INDEX uq_tournament_bounty_award_legacy ON public.tournament_bounty_awards USING btree (tournament_id, eliminated_user_id) WHERE (bounty_obligation_id IS NULL);
CREATE UNIQUE INDEX uq_tournament_bounty_award_generation ON public.tournament_bounty_awards USING btree (bounty_obligation_id) WHERE (bounty_obligation_id IS NOT NULL);
CREATE TABLE public.tournament_bounty_chests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tournament_id uuid NOT NULL,
  seq integer NOT NULL,
  tier text NOT NULL,
  amount_cents bigint NOT NULL,
  status text DEFAULT 'available'::text NOT NULL,
  award_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  terminal_closed_at timestamp with time zone,
  CONSTRAINT tournament_bounty_chests_amount_cents_check CHECK ((amount_cents > 0)),
  CONSTRAINT tournament_bounty_chests_pkey PRIMARY KEY (id),
  CONSTRAINT tournament_bounty_chests_status_check CHECK ((status = ANY (ARRAY['available'::text, 'reserved'::text, 'revealed'::text, 'paid'::text, 'void'::text]))),
  CONSTRAINT tournament_bounty_chests_tier_check CHECK ((tier = ANY (ARRAY['jackpot'::text, 'mega'::text, 'major'::text, 'large'::text, 'medium'::text, 'small'::text, 'base_plus'::text, 'base'::text]))),
  CONSTRAINT tournament_bounty_chests_tournament_id_seq_key UNIQUE (tournament_id, seq)
);
CREATE TABLE public.tournament_bounty_obligations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  tournament_id uuid NOT NULL,
  eliminated_user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  settlement_completed_at timestamp with time zone NOT NULL,
  seat_joined_at timestamp with time zone NOT NULL,
  "position" integer NOT NULL,
  prize numeric(20,2) NOT NULL,
  bubble_refund numeric(20,2) DEFAULT 0 NOT NULL,
  mode text NOT NULL,
  activation_generation bigint DEFAULT 0 NOT NULL,
  head_amount numeric(20,2) NOT NULL,
  knocker_user_id uuid NOT NULL,
  claimants jsonb NOT NULL,
  state text DEFAULT 'pending'::text NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  last_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  settled_at timestamp with time zone,
  CONSTRAINT tournament_bounty_obligations_activation_generation_check CHECK ((activation_generation >= 0)),
  CONSTRAINT tournament_bounty_obligations_attempt_count_check CHECK ((attempt_count >= 0)),
  CONSTRAINT tournament_bounty_obligations_bubble_refund_check CHECK ((bubble_refund >= (0)::numeric)),
  CONSTRAINT tournament_bounty_obligations_check CHECK ((((mode = 'mystery_chest'::text) AND (activation_generation > 0)) OR ((mode <> 'mystery_chest'::text) AND (activation_generation = 0)))),
  CONSTRAINT tournament_bounty_obligations_claimants_check CHECK ((jsonb_typeof(claimants) = 'array'::text)),
  CONSTRAINT tournament_bounty_obligations_hand_number_check CHECK ((hand_number >= 1000000)),
  CONSTRAINT tournament_bounty_obligations_head_amount_check CHECK ((head_amount > (0)::numeric)),
  CONSTRAINT tournament_bounty_obligations_mode_check CHECK ((mode = ANY (ARRAY['regular'::text, 'pko'::text, 'mystery_pre'::text, 'mystery_chest'::text]))),
  CONSTRAINT tournament_bounty_obligations_pkey PRIMARY KEY (id),
  CONSTRAINT tournament_bounty_obligations_position_check CHECK (("position" >= 2)),
  CONSTRAINT tournament_bounty_obligations_prize_check CHECK ((prize >= (0)::numeric)),
  CONSTRAINT tournament_bounty_obligations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'settled'::text]))),
  CONSTRAINT tournament_bounty_obligations_tournament_id_eliminated_user_key UNIQUE (tournament_id, eliminated_user_id, seat_joined_at),
  CONSTRAINT tournament_bounty_obligations_tournament_id_hand_number_eli_key UNIQUE (tournament_id, hand_number, eliminated_user_id)
);

-- Body MD5 c25cddea0d2f1ec56f7255823ed88a7e
CREATE OR REPLACE FUNCTION public.fn_attach_bounty_award_obligation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_context text := current_setting('app.bounty_obligation_id',true);
  v_obligation_id uuid;
  v_activation_generation bigint;
BEGIN
  IF NEW.bounty_obligation_id IS NULL THEN
    IF COALESCE(v_context,'')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      v_obligation_id := v_context::uuid;
      SELECT o.id,o.activation_generation
        INTO NEW.bounty_obligation_id,v_activation_generation
        FROM public.tournament_bounty_obligations o
       WHERE o.id=v_obligation_id AND o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_user_id
         AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id;
      IF NEW.bounty_obligation_id IS NULL THEN
        RAISE EXCEPTION 'mystery award context does not match its exact generation'
          USING ERRCODE='check_violation';
      END IF;
      NEW.activation_generation := v_activation_generation;
    ELSIF EXISTS (
      SELECT 1 FROM public.tournament_bounty_obligations o
       WHERE o.tournament_id=NEW.tournament_id
         AND o.eliminated_user_id=NEW.eliminated_user_id
         AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id
    ) THEN
      RAISE EXCEPTION 'generation-bound mystery award has no exact obligation context'
        USING ERRCODE='check_violation';
    END IF;
  ELSE
    SELECT o.activation_generation INTO v_activation_generation
      FROM public.tournament_bounty_obligations o
     WHERE o.id=NEW.bounty_obligation_id AND o.tournament_id=NEW.tournament_id
       AND o.eliminated_user_id=NEW.eliminated_user_id
       AND o.mode='mystery_chest' AND o.hand_id::text=NEW.hand_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'mystery award names a mismatched obligation generation'
        USING ERRCODE='check_violation';
    END IF;
    NEW.activation_generation := v_activation_generation;
  END IF;
  RETURN NEW;
END;
$function$;

-- Body MD5 5578ec53c8a531eeba47d448ae9af1b1
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reveal(p_award_id uuid, p_actor_user_id uuid, p_auto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_a record;
  v_revealer uuid;
  v_payload jsonb;
  v_is_engine boolean;
  v_auto boolean;
  v_actor uuid;
BEGIN
  -- Who is REALLY calling. Not current_user: SECURITY DEFINER rewrites that to
  -- the owner, so it reports 'postgres' for a browser too.
  v_is_engine := COALESCE(auth.role(), 'service_role') = 'service_role';

  -- A caller-supplied flag can no longer skip the check, and a caller-supplied
  -- id can no longer impersonate the revealer.
  v_auto  := v_is_engine AND COALESCE(p_auto, false);
  v_actor := CASE WHEN v_is_engine THEN p_actor_user_id ELSE auth.uid() END;

  SELECT * INTO v_a FROM public.tournament_bounty_awards WHERE id = p_award_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'award_not_found'); END IF;

  SELECT user_id INTO v_revealer FROM public.tournament_bounty_award_recipients
   WHERE award_id = p_award_id AND is_designated_revealer LIMIT 1;

  -- AUTHORISATION. Anyone can call an RPC, so this is the line that stops a
  -- spectator opening someone else's chest.
  IF NOT v_auto AND (v_actor IS NULL OR v_actor IS DISTINCT FROM v_revealer) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_the_revealer');
  END IF;

  IF v_a.status = 'reserved' THEN
    UPDATE public.tournament_bounty_awards
       SET status = 'revealed', revealed_at = now() WHERE id = p_award_id;
    UPDATE public.tournament_bounty_chests SET status = 'revealed' WHERE id = v_a.chest_id;
  END IF;
  -- Already revealed / paid / completed falls through and returns the same
  -- payload: a double tap, a reconnect replaying the tap, and the deadline
  -- firing just after a real tap must all show the player the same number.

  v_payload := jsonb_build_object(
    'ok', true,
    'award_id', v_a.id,
    'tournament_id', v_a.tournament_id,
    'table_id', v_a.table_id,
    'hand_id', v_a.hand_id,
    'amount_cents', v_a.amount_cents,
    'tier', v_a.tier,
    'is_jackpot', v_a.tier = 'jackpot',
    'eliminated_user_id', v_a.eliminated_user_id,
    'designated_revealer', v_revealer,
    'recipients', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'amount_cents', amount_cents)
                       ORDER BY amount_cents DESC, user_id)
        FROM public.tournament_bounty_award_recipients WHERE award_id = p_award_id), '[]'::jsonb)
  );
  RETURN v_payload;
END;
$function$;

-- Body MD5 f78272f535468f7399c78d5c4ec87e35
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_seed(p_tournament_id uuid, p_players_remaining integer, p_chests jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t record;
  v_pool_cents bigint;
  v_bounty_cents bigint;
  v_m numeric; v_r numeric;
  v_sum bigint; v_count int;
BEGIN
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
         bounty_pool_paid, mystery_bounty_stage,
         mystery_bounty_pool_percent, mystery_bounty_regular_pool_percent,
         mystery_bounty_pool_cents
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;
  IF NOT COALESCE(v_t.is_mystery_bounty, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_mystery_bounty');
  END IF;

  -- IDEMPOTENT. The engine's activation check runs on a five-second sweep and
  -- a restart re-runs it; seeding twice would double the inventory and the
  -- event could never reconcile.
  IF v_t.mystery_bounty_stage <> 'pending' THEN
    SELECT count(*), COALESCE(sum(amount_cents), 0) INTO v_count, v_sum
      FROM public.tournament_bounty_chests WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_seeded', true,
      'stage', v_t.mystery_bounty_stage, 'chests', v_count,
      'pool_cents', COALESCE(v_t.mystery_bounty_pool_cents, v_sum));
  END IF;

  -- ENTRY MUST BE CLOSED. bounty_pool still grows with every late entry,
  -- rebuy and add-on; an inventory built before the close is built from a pool
  -- smaller than the one the event ends up holding.
  IF NOT COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'entry_still_open');
  END IF;

  IF p_chests IS NULL OR jsonb_typeof(p_chests) <> 'array' OR jsonb_array_length(p_chests) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chests_required');
  END IF;
  IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining - 1, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chest_count_mismatch',
      'chests', jsonb_array_length(p_chests), 'players_remaining', p_players_remaining);
  END IF;

  v_bounty_cents := round(COALESCE(v_t.bounty_pool, 0) * 100)::bigint;
  v_m := GREATEST(0, COALESCE(v_t.mystery_bounty_pool_percent, 50));
  v_r := GREATEST(0, COALESCE(v_t.mystery_bounty_regular_pool_percent, 50));
  IF v_m + v_r <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pool_split_misconfigured');
  END IF;
  v_pool_cents := floor(v_bounty_cents * v_m / (v_m + v_r))::bigint;

  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  IF v_pool_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_pool');
  END IF;

  SELECT COALESCE(sum((c->>'amount_cents')::bigint), 0) INTO v_sum
    FROM jsonb_array_elements(p_chests) c;

  IF v_sum <> v_pool_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents);
  END IF;

  INSERT INTO public.tournament_bounty_chests (tournament_id, seq, tier, amount_cents)
  SELECT p_tournament_id,
         COALESCE((c->>'seq')::int, ord::int),
         c->>'tier',
         (c->>'amount_cents')::bigint
    FROM jsonb_array_elements(p_chests) WITH ORDINALITY AS t(c, ord)
  ON CONFLICT (tournament_id, seq) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> jsonb_array_length(p_chests) THEN
    RAISE EXCEPTION 'mystery bounty seed inserted % of % chests', v_count, jsonb_array_length(p_chests);
  END IF;

  UPDATE public.tournaments
     SET mystery_bounty_stage = 'active',
         mystery_bounty_activated_at = now(),
         mystery_bounty_activated_players = p_players_remaining,
         mystery_bounty_pool_cents = v_pool_cents
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'already_seeded', false,
    'pool_cents', v_pool_cents, 'chests', v_count, 'stage', 'active');
END;
$function$;

-- Body MD5 42bd9247e220db40fb41c4fc6ef1b7f2
CREATE OR REPLACE FUNCTION public.fn_ack_bounty_obligation_from_award()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'completed' THEN
    UPDATE public.tournament_bounty_obligations
       SET state = 'settled', settled_at = COALESCE(settled_at, now()), last_error = NULL
     WHERE id=NEW.bounty_obligation_id
       AND mode = 'mystery_chest' AND state = 'pending'
       AND public.fn_bounty_obligation_has_complete_marker(id);
  END IF;
  RETURN NEW;
END;
$function$;

-- Body MD5 aa905f63527272e7aded4ac7fdbc9d15
CREATE OR REPLACE FUNCTION public.fn_assert_bounty_award_has_recipients()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipients int;
  v_sum        bigint;
BEGIN
  SELECT count(*), COALESCE(sum(amount_cents), 0)
    INTO v_recipients, v_sum
    FROM public.tournament_bounty_award_recipients
   WHERE award_id = NEW.id;

  IF v_recipients = 0 THEN
    RAISE EXCEPTION
      'bounty award % consumed chest % on tournament % with NO recipients - refusing to commit a chest nobody can be paid from',
      NEW.id, NEW.chest_id, NEW.tournament_id;
  END IF;

  -- The split must also hand out the whole chest. The function has its own
  -- check for this, but it only covers its own arithmetic; this covers the
  -- row as committed, whoever wrote it.
  IF v_sum <> NEW.amount_cents THEN
    RAISE EXCEPTION
      'bounty award % splits % cents across its recipients but the chest holds % - refusing to commit a split that loses or invents money',
      NEW.id, v_sum, NEW.amount_cents;
  END IF;

  RETURN NULL;
END;
$function$;

-- Body MD5 789f33328d2641870eeaf23bba2f582a
CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reserve(p_tournament_id uuid, p_eliminated_user_id uuid, p_recipients jsonb, p_table_id uuid, p_hand_id text, p_op_id uuid, p_reveal_ms integer DEFAULT 20000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  v_recipients jsonb;
  v_result jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_prior_context text;
  v_stage text;
  v_existing record;
  v_chest record;
  v_award_id uuid;
  v_revealer uuid;
  v_idx integer;
  v_total integer;
  v_n integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  PERFORM 1 FROM public.tournaments t WHERE t.id=p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','tournament_not_found'); END IF;
  SELECT * INTO o FROM public.tournament_bounty_obligations bo
   WHERE bo.tournament_id=p_tournament_id
     AND bo.eliminated_user_id=p_eliminated_user_id
     AND bo.mode='mystery_chest'
     AND bo.table_id=p_table_id AND bo.hand_id::text=p_hand_id
   ORDER BY bo.hand_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'reason','bounty_obligation_not_ready');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'user_id',e->>'user_id','weight',1,
           'is_designated_revealer',(e->>'user_id')::uuid=o.knocker_user_id)
           ORDER BY e->>'user_id')
    INTO v_recipients FROM jsonb_array_elements(o.claimants) e;
  v_op_hex := md5('mb:'||o.id::text);
  v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
    ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
  v_prior_context := current_setting('app.bounty_obligation_id',true);
  PERFORM set_config('app.bounty_obligation_id',o.id::text,true);

  -- Inline the CSPRNG inventory reservation and exact-cent split. The
  -- generation-bound obligation remains the only source of recipient truth,
  -- while the rolling helper can be retired without breaking this root.
  <<mystery_reserve_core>>
  BEGIN
    IF p_eliminated_user_id IS NULL OR v_op_id IS NULL THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'missing_party');
      EXIT mystery_reserve_core;
    END IF;

    SELECT id, status, table_id
      INTO v_existing
      FROM public.tournament_bounty_awards
     WHERE op_id = v_op_id
        OR (
          tournament_id = p_tournament_id
          AND eliminated_user_id = p_eliminated_user_id
          AND (
            bounty_obligation_id = (
              SELECT pending.id
                FROM tournament_bounty_obligations pending
               WHERE pending.tournament_id=p_tournament_id
                 AND pending.eliminated_user_id=p_eliminated_user_id
                 AND pending.mode='mystery_chest'
                 AND pending.hand_id::text=p_hand_id
               ORDER BY pending.created_at DESC
               LIMIT 1)
            OR (bounty_obligation_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM tournament_bounty_obligations pending
               WHERE pending.tournament_id=p_tournament_id
                 AND pending.eliminated_user_id=p_eliminated_user_id
                 AND pending.mode='mystery_chest'
                 AND pending.hand_id::text=p_hand_id))))
     LIMIT 1;

    IF FOUND THEN
      SELECT count(*) INTO v_total
        FROM public.tournament_bounty_awards a
       WHERE a.tournament_id = p_tournament_id
         AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
         AND a.status IN ('reserved','revealed');
      SELECT count(*) INTO v_idx
        FROM public.tournament_bounty_awards a
       WHERE a.tournament_id = p_tournament_id
         AND a.table_id IS NOT DISTINCT FROM v_existing.table_id
         AND a.status IN ('reserved','revealed')
         AND a.reserved_at <= (
           SELECT reserved_at FROM public.tournament_bounty_awards
            WHERE id = v_existing.id);
      SELECT user_id INTO v_revealer
        FROM public.tournament_bounty_award_recipients
       WHERE award_id = v_existing.id
         AND is_designated_revealer
       LIMIT 1;
      v_result := jsonb_build_object(
        'ok', true, 'already', true, 'award_id', v_existing.id,
        'status', v_existing.status,
        'queue_index', GREATEST(v_idx, 1),
        'queue_total', GREATEST(v_total, 1),
        'designated_revealer', v_revealer,
        'recipient_user_ids', COALESCE((
          SELECT jsonb_agg(user_id)
            FROM public.tournament_bounty_award_recipients
           WHERE award_id = v_existing.id), '[]'::jsonb));
      EXIT mystery_reserve_core;
    END IF;

    SELECT mystery_bounty_stage INTO v_stage
      FROM public.tournaments
     WHERE id = p_tournament_id;
    IF v_stage IS DISTINCT FROM 'active' THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'mystery_phase_not_active', 'stage', v_stage);
      EXIT mystery_reserve_core;
    END IF;

    IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array'
       OR jsonb_array_length(v_recipients) = 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_recipients');
      EXIT mystery_reserve_core;
    END IF;

    UPDATE public.tournament_bounty_chests
       SET status = 'reserved'
     WHERE id = (
       SELECT id FROM public.tournament_bounty_chests
        WHERE tournament_id = p_tournament_id
          AND status = 'available'
        ORDER BY seq
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING id, tier, amount_cents INTO v_chest;

    IF NOT FOUND THEN
      v_result := jsonb_build_object(
        'ok', false, 'reason', 'inventory_exhausted');
      EXIT mystery_reserve_core;
    END IF;

    INSERT INTO public.tournament_bounty_awards
      (tournament_id, chest_id, table_id, hand_id, eliminated_user_id,
       amount_cents, tier, status, op_id, reveal_deadline_at)
    VALUES
      (p_tournament_id, v_chest.id, p_table_id, p_hand_id,
       p_eliminated_user_id, v_chest.amount_cents, v_chest.tier,
       'reserved', v_op_id,
       now() + make_interval(
         secs => GREATEST(1, COALESCE(p_reveal_ms, 20000)) / 1000.0))
    RETURNING id INTO v_award_id;

    UPDATE public.tournament_bounty_chests
       SET award_id = v_award_id
     WHERE id = v_chest.id;

    WITH raw AS (
      SELECT (r->>'user_id')::uuid AS user_id,
             GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
             COALESCE(
               (r->>'is_designated_revealer')::boolean, false) AS flagged
        FROM jsonb_array_elements(v_recipients) r
       WHERE (r->>'user_id') IS NOT NULL
    ),
    dedup AS (
      SELECT user_id, sum(weight) AS weight, bool_or(flagged) AS flagged
        FROM raw
       GROUP BY user_id
    ),
    norm AS (
      SELECT user_id,
             CASE WHEN (SELECT sum(weight) FROM dedup) > 0
                  THEN weight ELSE 1 END AS weight,
             flagged
        FROM dedup
    ),
    alloc AS (
      SELECT n.user_id, n.weight,
             floor(v_chest.amount_cents * n.weight / t.w)::bigint AS fl,
             (v_chest.amount_cents * n.weight / t.w)
               - floor(v_chest.amount_cents * n.weight / t.w) AS frac
        FROM norm n
        CROSS JOIN (SELECT sum(weight) AS w FROM norm) t
    ),
    ranked AS (
      SELECT a.*,
             row_number() OVER (
               ORDER BY a.frac DESC, a.weight DESC, a.user_id) AS rn,
             (SELECT v_chest.amount_cents - COALESCE(sum(fl), 0)
                FROM alloc) AS leftover
        FROM alloc a
    )
    INSERT INTO public.tournament_bounty_award_recipients
      (award_id, user_id, amount_cents, is_designated_revealer)
    SELECT v_award_id, user_id,
           fl + CASE WHEN rn <= leftover THEN 1 ELSE 0 END,
           false
      FROM ranked
    ON CONFLICT (award_id, user_id) DO NOTHING;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'no_recipients');
      EXIT mystery_reserve_core;
    END IF;

    SELECT user_id INTO v_revealer
      FROM (
        SELECT (r->>'user_id')::uuid AS user_id,
               GREATEST(0, COALESCE((r->>'weight')::numeric, 0)) AS weight,
               COALESCE(
                 (r->>'is_designated_revealer')::boolean, false) AS flagged
          FROM jsonb_array_elements(v_recipients) r
         WHERE (r->>'user_id') IS NOT NULL
      ) q
     ORDER BY q.flagged DESC, q.weight DESC, q.user_id
     LIMIT 1;

    UPDATE public.tournament_bounty_award_recipients
       SET is_designated_revealer = (user_id = v_revealer)
     WHERE award_id = v_award_id;

    PERFORM 1 FROM public.tournament_bounty_award_recipients
     WHERE award_id = v_award_id
    HAVING sum(amount_cents) = v_chest.amount_cents;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'mystery bounty split lost money on award %', v_award_id;
    END IF;

    SELECT count(*) INTO v_total
      FROM public.tournament_bounty_awards a
     WHERE a.tournament_id = p_tournament_id
       AND a.table_id IS NOT DISTINCT FROM p_table_id
       AND a.status IN ('reserved','revealed');
    v_idx := v_total;

    v_result := jsonb_build_object(
      'ok', true, 'already', false, 'award_id', v_award_id,
      'queue_index', GREATEST(v_idx, 1),
      'queue_total', GREATEST(v_total, 1),
      'designated_revealer', v_revealer,
      'reveal_deadline_ms', GREATEST(1, COALESCE(p_reveal_ms, 20000)),
      'recipient_user_ids', COALESCE((
        SELECT jsonb_agg(user_id)
          FROM public.tournament_bounty_award_recipients
         WHERE award_id = v_award_id), '[]'::jsonb));
  END mystery_reserve_core;

  PERFORM set_config('app.bounty_obligation_id',COALESCE(v_prior_context,''),true);
  IF NOT COALESCE((v_result->>'ok')::boolean,false) THEN RETURN v_result; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_bounty_awards a
     WHERE a.id=(v_result->>'award_id')::uuid AND a.bounty_obligation_id=o.id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(o.claimants) c
          WHERE NOT EXISTS (SELECT 1 FROM public.tournament_bounty_award_recipients r
                             WHERE r.award_id=a.id
                               AND r.user_id=(c->>'user_id')::uuid)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_award_recipients r
          WHERE r.award_id=a.id
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(o.claimants) c
                             WHERE (c->>'user_id')::uuid=r.user_id)
       )
  ) THEN
    RAISE EXCEPTION 'mystery award recipients do not match obligation %',o.id;
  END IF;
  RETURN v_result || jsonb_build_object('obligation_id',o.id,'recipients_verified',true);
END;
$function$;
CREATE TRIGGER trg_ack_bounty_obligation_from_award AFTER INSERT OR UPDATE OF status ON public.tournament_bounty_awards FOR EACH ROW EXECUTE FUNCTION fn_ack_bounty_obligation_from_award();
CREATE TRIGGER trg_attach_bounty_award_obligation BEFORE INSERT ON public.tournament_bounty_awards FOR EACH ROW EXECUTE FUNCTION fn_attach_bounty_award_obligation();
CREATE CONSTRAINT TRIGGER trg_bounty_award_has_recipients AFTER INSERT ON public.tournament_bounty_awards DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_assert_bounty_award_has_recipients();
