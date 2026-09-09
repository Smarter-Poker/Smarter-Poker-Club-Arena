-- 20260909042455_tournament_cash_settlement_has_one_atomic_authority.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- PLACE-LADDER AUTHORITY
--
-- Price and settle every cash place under one locked database transaction.
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '120s';

-- The deployed guarantee authority debits the correct bank and records one
-- tournament_guarantee_overlays identity, but its auto-ledger leg is
-- deliberately ignored by the escrow trigger. That left the advertised
-- overlay outside tournament_escrow, so the very next cash payout could only
-- pay the entry-funded part of the pool. Harden the audited authority at the
-- first stage-one cash boundary: a newly claimed overlay, its bank debit, its
-- exact escrow credit and pool finalization are one transaction. A duplicate
-- overlay identity while the locked event is not finalized is impossible for
-- a committed invocation and therefore raises instead of becoming a repair.
DO $name_guarantee_core$
BEGIN
  IF to_regprocedure(
       'public.fn_ca_apply_prize_guarantee_core(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'canonical guarantee core name is already occupied';
  END IF;
  IF to_regprocedure(
       'public.fn_apply_prize_guarantee(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'atomic guarantee authority is missing';
  END IF;
  ALTER FUNCTION public.fn_apply_prize_guarantee(uuid,text)
    RENAME TO fn_ca_apply_prize_guarantee_core;
END;
$name_guarantee_core$;

REVOKE ALL ON FUNCTION public.fn_ca_apply_prize_guarantee_core(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(
  p_tournament_id uuid,
  p_source text DEFAULT 'engine'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $guarantee_receipt$
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
$guarantee_receipt$;

REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(uuid,text)
  TO service_role;

-- Take the strongest lock first. This migration adds a column and trigger as
-- well as indexes; starting weaker and upgrading after CREATE INDEX can
-- deadlock with a writer that arrived between those statements. Historical
-- collisions are a record-repair decision, so an unknown one aborts instead
-- of being rewritten.
LOCK TABLE public.tournament_players IN ACCESS EXCLUSIVE MODE;
DO $finish_position_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_players
     WHERE position IS NOT NULL
     GROUP BY tournament_id, position
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'finish-position preflight: duplicate (tournament_id, position) rows remain';
  END IF;
END;
$finish_position_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_players_one_finish_position
  ON public.tournament_players (tournament_id, position)
  WHERE position IS NOT NULL;

-- A mutable field size cannot be an elimination-order witness. Late entries
-- can make a perfectly valid early bust's recorded position non-contiguous,
-- while eliminated_at is a wall clock and has historically been backfilled in
-- batches. Stamp the transition itself with a database-owned monotonic value.
-- Settlement may then rebuild the final numeric tail from durable event order
-- without a watcher, a clock guess, or a client-provided sequence.
ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS elimination_sequence bigint;

CREATE SEQUENCE IF NOT EXISTS public.tournament_player_elimination_sequence
  AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1;
ALTER SEQUENCE public.tournament_player_elimination_sequence
  OWNED BY public.tournament_players.elimination_sequence;
REVOKE ALL ON SEQUENCE public.tournament_player_elimination_sequence
  FROM PUBLIC, anon, authenticated, service_role;

-- Bootstrap only active tails whose stored positions already prove their
-- complete order. A non-contiguous active history is ambiguous and remains
-- NULL so the atomic payer fails closed instead of ranking from timestamps.
WITH shape AS (
  SELECT tp.tournament_id,
         count(*)::bigint AS field_size,
         count(*) FILTER (WHERE tp.status::text = 'eliminated')::bigint AS eliminated_count,
         count(tp.position) FILTER (WHERE tp.status::text = 'eliminated')::bigint AS placed_count,
         min(tp.position) FILTER (WHERE tp.status::text = 'eliminated') AS min_position,
         max(tp.position) FILTER (WHERE tp.status::text = 'eliminated') AS max_position
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE upper(t.status::text) IN ('RUNNING','COMPLETING')
   GROUP BY tp.tournament_id
), exact_tail AS (
  SELECT *
    FROM shape
   WHERE eliminated_count > 0
     AND placed_count = eliminated_count
     AND min_position = field_size - eliminated_count + 1
     AND max_position = field_size
)
UPDATE public.tournament_players tp
   SET elimination_sequence = e.field_size - tp.position + 1
  FROM exact_tail e
 WHERE tp.tournament_id = e.tournament_id
   AND tp.status::text = 'eliminated'
   AND tp.elimination_sequence IS NULL;

SELECT setval(
  'public.tournament_player_elimination_sequence'::regclass,
  COALESCE(max(elimination_sequence), 1),
  max(elimination_sequence) IS NOT NULL
)
FROM public.tournament_players;

ALTER TABLE public.tournament_players
  DROP CONSTRAINT IF EXISTS tournament_players_elimination_sequence_positive;
ALTER TABLE public.tournament_players
  ADD CONSTRAINT tournament_players_elimination_sequence_positive
  CHECK (elimination_sequence IS NULL OR elimination_sequence > 0) NOT VALID;
ALTER TABLE public.tournament_players
  VALIDATE CONSTRAINT tournament_players_elimination_sequence_positive;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_players_one_elimination_sequence
  ON public.tournament_players (tournament_id, elimination_sequence)
  WHERE elimination_sequence IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_stamp_tournament_elimination_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $stamp_elimination_sequence$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text = 'eliminated' THEN
      NEW.elimination_sequence := nextval(
        'public.tournament_player_elimination_sequence'::regclass);
    ELSE
      NEW.elimination_sequence := NULL;
    END IF;
  ELSIF OLD.status::text IS DISTINCT FROM 'eliminated'
        AND NEW.status::text = 'eliminated' THEN
    NEW.elimination_sequence := nextval(
      'public.tournament_player_elimination_sequence'::regclass);
  ELSIF OLD.status::text = 'eliminated'
        AND NEW.status::text IS DISTINCT FROM 'eliminated' THEN
    -- Leaving the eliminated state is also database-owned. Atomic settlement
    -- may promote the final all-in casualty to winner, and no historical
    -- elimination witness may remain attached to that live row.
    NEW.elimination_sequence := NULL;
  ELSIF NEW.elimination_sequence IS DISTINCT FROM OLD.elimination_sequence THEN
    RAISE EXCEPTION 'elimination_sequence is database-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$stamp_elimination_sequence$;

REVOKE ALL ON FUNCTION public.fn_stamp_tournament_elimination_sequence()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS zz_stamp_tournament_elimination_sequence
  ON public.tournament_players;
CREATE TRIGGER zz_stamp_tournament_elimination_sequence
  BEFORE INSERT OR UPDATE OF status, elimination_sequence
  ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_stamp_tournament_elimination_sequence();

COMMENT ON COLUMN public.tournament_players.elimination_sequence IS
  'Database-owned order of committed eliminated transitions. Settlement derives final numeric places from this witness; wall-clock timestamps never rank a field.';

-- A tournament wallet credit and its payout row are one operation. There is
-- deliberately no catch around the evidence INSERT: failure rolls back money.
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
SET statement_timeout TO '30s'
AS $credit_and_log$
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
$credit_and_log$;

REVOKE ALL ON FUNCTION public.fn_credit_and_log(
  uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Owner-only deterministic arithmetic. The row is locked even when an owner
-- calls this helper directly; the service door already holds that same lock.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_place_amounts(
  p_tournament_id uuid
)
RETURNS TABLE(place integer, amount numeric(15,2))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $place_amounts$
DECLARE
  v_t record;
  v_pool numeric;
  v_ladder_pool numeric;
  v_bubble_amount numeric := 0;
  v_expected_pool numeric;
  v_pool_cents bigint;
  v_remaining bigint;
  v_share bigint;
  v_total_bp bigint := 0;
  v_bp bigint;
  v_field integer;
  v_struct jsonb;
  v_work jsonb := '[]'::jsonb;
  v_trimmed jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_place_numeric numeric;
  v_pct numeric;
  v_place integer;
  v_valid boolean := true;
  v_is_spin boolean;
  v_known_spin boolean := false;
  v_count integer;
  v_max_place integer;
  v_index integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'place amount derivation requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id, t.prize_pool, t.payout_structure, t.variant,
         t.tournament_type, t.is_premium_spin, t.spin_multiplier,
         t.buy_in_amount, t.satellite_target_id, t.satellite_target,
         t.bubble_protection
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not a cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  v_pool := v_t.prize_pool;
  IF v_pool IS NULL
     OR v_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_pool < 0
     OR v_pool IS DISTINCT FROM round(v_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_pool USING ERRCODE = '22003';
  END IF;
  SELECT count(*) INTO v_field FROM public.tournament_players
   WHERE tournament_id = p_tournament_id;
  IF v_field < 1 THEN
    RAISE EXCEPTION 'tournament % has no roster', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_is_spin := lower(COALESCE(v_t.variant, '')) = 'spin'
               OR COALESCE(v_t.is_premium_spin, false)
               OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN';
  IF v_is_spin THEN
    IF v_t.spin_multiplier IS NULL
       OR v_t.spin_multiplier::text IN ('NaN','Infinity','-Infinity')
       OR v_t.spin_multiplier <= 0
       OR v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount < 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'Spin % has invalid locked buy-in/multiplier evidence',
        p_tournament_id USING ERRCODE = '22003';
    END IF;
    v_expected_pool := round(v_t.buy_in_amount * v_t.spin_multiplier, 2);
    IF v_expected_pool::text IN ('NaN','Infinity','-Infinity')
       OR v_pool IS DISTINCT FROM v_expected_pool THEN
      RAISE EXCEPTION
        'Spin % pool % does not equal buy-in % x multiplier % (= %)',
        p_tournament_id, v_pool, v_t.buy_in_amount, v_t.spin_multiplier,
        v_expected_pool USING ERRCODE = '23514';
    END IF;

    IF v_t.spin_multiplier IN (2,3,4,5) THEN
      v_struct := '[{"place":1,"percentage":100}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier = 10 THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":20}]'::jsonb;
      v_known_spin := true;
    ELSIF v_t.spin_multiplier IN (25,50,100) THEN
      v_struct := '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb;
      v_known_spin := true;
    END IF;
  END IF;

  -- Unknown/retired Spin multipliers and non-Spins read the stored structure.
  IF NOT v_known_spin THEN
    BEGIN
      v_struct := NULLIF(btrim(COALESCE(v_t.payout_structure::text, '')), '')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      v_struct := NULL;
    END;
  END IF;
  IF v_struct IS NULL OR jsonb_typeof(v_struct) <> 'array'
     OR jsonb_array_length(v_struct) = 0 THEN
    v_valid := false;
  END IF;

  -- Fractional places and non-finite/non-positive shares fail this candidate.
  -- As in computePlacePrize, the first entry for a duplicate place wins.
  IF v_valid THEN
    FOR v_entry IN SELECT value FROM jsonb_array_elements(v_struct) LOOP
      IF jsonb_typeof(v_entry) <> 'object'
         OR v_entry->>'place' IS NULL
         OR v_entry->>'percentage' IS NULL THEN
        v_valid := false; EXIT;
      END IF;
      BEGIN
        v_place_numeric := (v_entry->>'place')::numeric;
        v_pct := (v_entry->>'percentage')::numeric;
      EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_place_numeric::text IN ('NaN','Infinity','-Infinity')
         OR v_pct::text IN ('NaN','Infinity','-Infinity')
         OR v_place_numeric < 1 OR v_place_numeric <> trunc(v_place_numeric)
         OR v_place_numeric > 2147483647 OR v_pct <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      v_place := v_place_numeric::integer;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_work) e
                  WHERE (e->>'place')::integer = v_place) THEN
        CONTINUE;
      END IF;
      BEGIN
        v_bp := round(v_pct * 100)::bigint;
      EXCEPTION WHEN numeric_value_out_of_range THEN
        v_valid := false; EXIT;
      END;
      IF v_bp <= 0 THEN
        v_valid := false; EXIT;
      END IF;
      v_work := v_work || jsonb_build_object('place',v_place,'bp',v_bp);
    END LOOP;
  END IF;
  IF v_valid AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_work) e
     WHERE (e->>'place')::integer = 1
  ) THEN
    v_valid := false;
  END IF;

  IF NOT v_valid THEN
    RAISE EXCEPTION
      'tournament % has no usable canonical payout ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'place')::integer),'[]'::jsonb)
    INTO v_trimmed FROM jsonb_array_elements(v_work) e
   WHERE (e->>'place')::integer <= v_field;
  IF jsonb_array_length(v_trimmed) = 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no place in final field %',
      p_tournament_id, v_field USING ERRCODE = '22023';
  END IF;
  SELECT count(*), COALESCE(sum((e->>'bp')::bigint),0)
    INTO v_count, v_total_bp FROM jsonb_array_elements(v_trimmed) e;
  IF v_total_bp <= 0 THEN
    RAISE EXCEPTION 'tournament % ladder has no positive percentage',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  SELECT max((e->>'place')::integer)
    INTO v_max_place
    FROM jsonb_array_elements(v_trimmed) e;

  -- Bubble protection is part of the tournament pool, not a house overlay.
  -- When the final field contains a stone bubble, reserve exactly one base
  -- buy-in before pricing the percentage ladder. The bubble and all places
  -- therefore spend the locked prize_pool exactly once between them.
  IF COALESCE(v_t.bubble_protection, false) AND v_field > v_max_place THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION
        'tournament % has bubble protection but invalid whole-cent buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_pool THEN
      RAISE EXCEPTION
        'tournament % bubble amount % exceeds locked prize pool %',
        p_tournament_id, v_bubble_amount, v_pool USING ERRCODE = '23514';
    END IF;
  END IF;

  v_ladder_pool := round(v_pool - v_bubble_amount, 2);
  v_pool_cents := round(v_ladder_pool * 100)::bigint;

  -- Mirror computePlacePrize: normalize to surviving basis points, spend down
  -- in place order, and give the exact remaining cents to the last place.
  v_remaining := v_pool_cents;
  FOR v_entry IN
    SELECT e FROM jsonb_array_elements(v_trimmed) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_index := v_index + 1;
    v_place := (v_entry->>'place')::integer;
    v_bp := (v_entry->>'bp')::bigint;
    IF v_index = v_count THEN
      v_share := v_remaining;
    ELSE
      v_share := LEAST(v_remaining,
        round((v_pool_cents::numeric * v_bp::numeric) / v_total_bp::numeric)::bigint);
    END IF;
    v_share := GREATEST(v_share,0);
    v_remaining := v_remaining - v_share;
    place := v_place;
    amount := (v_share::numeric / 100)::numeric(15,2);
    IF amount::text IN ('NaN','Infinity','-Infinity')
       OR amount < 0 OR amount IS DISTINCT FROM round(amount,2) THEN
      RAISE EXCEPTION 'derived invalid amount % for tournament %, place %',
        amount, p_tournament_id, place USING ERRCODE = '22003';
    END IF;
    RETURN NEXT;
  END LOOP;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'tournament % ladder left % cents undistributed',
      p_tournament_id, v_remaining USING ERRCODE = '23514';
  END IF;
END;
$place_amounts$;

REVOKE ALL ON FUNCTION public.fn_ca_tournament_place_amounts(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Owner-only raw payment. It accepts only already-derived values and turns a
-- short escrow/partial receipt into an exception, rolling the whole ladder back.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_tournament_place_raw(
  p_tournament_id uuid, p_place integer, p_user_id uuid, p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $place_raw$
DECLARE v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL OR p_place IS NULL OR p_place < 1
     OR p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0 OR p_amount IS DISTINCT FROM round(p_amount,2) THEN
    RAISE EXCEPTION 'raw place settlement received invalid derived inputs'
      USING ERRCODE = '22023';
  END IF;
  v_result := public.fn_settle_tournament_obligation(
    p_tournament_id, 'place', p_place, p_user_id, p_amount,
    'engine.fn_settle_tournament_places',
    format('Tournament prize: position %s',p_place), NULL);
  IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE
     OR COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE
     OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM p_amount
     OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM p_amount
     OR COALESCE((v_result->>'remaining')::numeric,p_amount) <> 0 THEN
    RAISE EXCEPTION 'tournament %, place % did not settle in full: %',
      p_tournament_id, p_place, v_result USING ERRCODE = 'P0404';
  END IF;
  RETURN v_result;
END;
$place_raw$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_tournament_place_raw(
  uuid,integer,uuid,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- Owner-only raw bubble payer. Eligibility and amount are database-derived by
-- the service door or a complete cash-finish authority before this primitive
-- is called. A partial generic settlement is an exception so no outer finish
-- can retain an earlier debt or credit.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_tournament_bubble_raw(
  p_tournament_id uuid,
  p_user_id uuid,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $bubble_raw$
DECLARE
  v_result jsonb;
  v_ob public.tournament_obligations%ROWTYPE;
  v_payout_count integer;
  v_paid numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount IS DISTINCT FROM round(p_amount, 2) THEN
    RAISE EXCEPTION 'raw bubble settlement received invalid derived inputs'
      USING ERRCODE = '22023';
  END IF;

  v_result := public.fn_settle_tournament_obligation(
    p_tournament_id,
    'bubble_protection',
    NULL,
    p_user_id,
    p_amount,
    'engine.fn_settle_tournament_bubble_protection',
    'Bubble Protection: Base Buy-In Returned',
    NULL
  );

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
     OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM p_amount
     OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM p_amount
     OR COALESCE((v_result->>'remaining')::numeric, p_amount) <> 0 THEN
    RAISE EXCEPTION 'tournament % bubble obligation for % did not settle in full: %',
      p_tournament_id, p_user_id, v_result USING ERRCODE = 'P0404';
  END IF;

  SELECT * INTO v_ob
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';
  IF NOT FOUND OR v_ob.place IS NOT NULL
     OR v_ob.user_id IS DISTINCT FROM p_user_id
     OR v_ob.amount_owed IS DISTINCT FROM p_amount
     OR v_ob.amount_paid IS DISTINCT FROM p_amount
     OR v_ob.settled_at IS NULL
     OR (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'bubble_protection') <> 1 THEN
    RAISE EXCEPTION 'tournament % has no exact settled bubble obligation',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_payout_count < 1 OR v_paid IS DISTINCT FROM p_amount
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'bubble_protection'
          AND (p.user_id IS DISTINCT FROM p_user_id
            OR p."position" IS NOT NULL
            OR p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0
            OR p.amount IS DISTINCT FROM round(p.amount, 2)
            OR p.idempotency_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id
                 AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % has malformed or incomplete bubble payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN v_result;
END;
$bubble_raw$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_tournament_bubble_raw(
  uuid,uuid,numeric)
  FROM PUBLIC, anon, authenticated, service_role;

-- Public service door for the exact elimination that crosses the stone
-- bubble. It accepts only identity as an observation; position and money are
-- derived from the locked field, structure and base buy-in. Normal/deal
-- finish authorities repeat this derivation inside their larger transaction,
-- so a lost response cannot strand the promise.
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_bubble_protection(
  p_tournament_id uuid,
  p_observed_bubble_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $settle_bubble$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_distinct_sequence_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric;
  v_candidate_count integer;
  v_ob public.tournament_obligations%ROWTYPE;
  v_ob_count integer;
  v_payout_count integer;
  v_paid numeric;
  v_result jsonb;
  v_rows integer;
BEGIN
  IF p_tournament_id IS NULL OR p_observed_bubble_user_id IS NULL THEN
    RAISE EXCEPTION 'bubble settlement requires tournament and observed user ids'
      USING ERRCODE = '22004';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type,
         t.satellite_target_id, t.satellite_target, t.bubble_protection,
         t.buy_in_amount,
         t.prize_pool, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN
       ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle a bubble from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  -- Before the pool is finalized, late registration can still enlarge the
  -- roster. An entrant who is the bubble in that transient field may acquire a
  -- different final place. Never move money until the database-owned close
  -- proves the field and its stone-bubble identity are immutable. If guarantee
  -- funding prevented finalization, terminal settlement funds it and settles
  -- the bubble atomically instead.
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'tournament % cannot settle its bubble before the prize pool is finalized',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION
      'tournament % is a satellite; its bubble receives the seat-pool remainder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_t.bubble_protection, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % has no bubble-protection promise',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF v_t.buy_in_amount IS NULL
     OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
     OR v_t.buy_in_amount <= 0
     OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
      p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
  END IF;
  v_bubble_amount := round(v_t.buy_in_amount, 2);
  IF v_t.prize_pool IS NULL OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < v_bubble_amount
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % pool % cannot fund bubble amount %',
      p_tournament_id, v_t.prize_pool, v_bubble_amount USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text NOT IN ('playing','winner','eliminated')
  ) THEN
    RAISE EXCEPTION 'tournament % still has an unresolved roster',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF v_bubble_place IS NULL OR v_bubble_place > v_field_size THEN
    RAISE EXCEPTION 'tournament % final field has no stone bubble',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*), count(tp.elimination_sequence),
         count(DISTINCT tp.elimination_sequence)
    INTO v_eliminated_count, v_sequenced_count, v_distinct_sequence_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'eliminated';
  IF v_sequenced_count <> v_eliminated_count
     OR v_distinct_sequence_count <> v_eliminated_count THEN
    RAISE EXCEPTION 'tournament % has no complete durable elimination order',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  WITH ranked AS (
    SELECT tp.user_id, tp.position,
           (v_field_size - row_number() OVER (
             ORDER BY tp.elimination_sequence ASC, tp.id ASC
           ) + 1)::integer AS expected_position
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
  )
  SELECT count(*), min(r.user_id::text)::uuid
    INTO v_candidate_count, v_bubble_user_id
    FROM ranked r
   WHERE r.expected_position = v_bubble_place
     AND r.position = v_bubble_place;
  IF v_candidate_count <> 1
     OR v_bubble_user_id IS DISTINCT FROM p_observed_bubble_user_id THEN
    RAISE EXCEPTION
      'observed bubble user % does not match durable place % in tournament %',
      p_observed_bubble_user_id, v_bubble_place, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;
  PERFORM 1 FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
   ORDER BY p.id FOR SHARE;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_payout_count, v_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  IF v_paid > v_bubble_amount
     OR EXISTS (
       SELECT 1 FROM public.tournament_payouts p
        WHERE p.tournament_id = p_tournament_id
          AND p.source = 'bubble_protection'
          AND (p.user_id IS DISTINCT FROM v_bubble_user_id
            OR p."position" IS NOT NULL
            OR p.amount IS NULL
            OR p.amount::text IN ('NaN','Infinity','-Infinity')
            OR p.amount <= 0
            OR p.amount IS DISTINCT FROM round(p.amount, 2)
            OR p.idempotency_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.wallet_credit_idempotency k
               WHERE k.key = p.idempotency_key
                 AND k.user_id = p.user_id
                 AND k.amount = p.amount))) THEN
    RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';
  SELECT * INTO v_ob
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection'
     AND o.user_id = v_bubble_user_id;
  IF v_ob_count = 0 THEN
    IF v_payout_count <> 0 OR v_paid <> 0 THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
    VALUES
      (p_tournament_id, 'bubble_protection', NULL, v_bubble_user_id,
       v_bubble_amount, 0, 'engine.fn_settle_tournament_bubble_protection')
    RETURNING * INTO v_ob;
  ELSIF v_ob_count <> 1 OR v_ob.id IS NULL
     OR v_ob.place IS NOT NULL
     OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
     OR v_ob.amount_paid IS DISTINCT FROM v_paid
     OR v_ob.amount_paid < 0 OR v_ob.amount_paid > v_ob.amount_owed
     OR (v_ob.amount_paid = v_ob.amount_owed) IS DISTINCT FROM
        (v_ob.settled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  v_result := public.fn_ca_settle_tournament_bubble_raw(
    p_tournament_id, v_bubble_user_id, v_bubble_amount);
  UPDATE public.tournament_players
     SET prize = v_bubble_amount
   WHERE tournament_id = p_tournament_id
     AND user_id = v_bubble_user_id
     AND position = v_bubble_place;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'could not stamp one bubble prize cache for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'user_id', v_bubble_user_id,
    'position', v_bubble_place,
    'amount', v_bubble_amount,
    'settlement', v_result);
END;
$settle_bubble$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_places(
  p_tournament_id uuid,
  p_observed_winner_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '30s'
AS $settle_places$
DECLARE
  v_t record;
  v_ladder jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_status text;
  v_live_count integer;
  v_field_size integer;
  v_eliminated_count integer;
  v_sequenced_count integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric := 0;
  v_bubble_payout_count integer := 0;
  v_bubble_paid numeric := 0;
  v_bubble_ob_count integer := 0;
  v_bubble_ob public.tournament_obligations%ROWTYPE;
  v_bubble_result jsonb;
  v_winner public.tournament_players%ROWTYPE;
  v_row record;
  v_place integer;
  v_amount numeric;
  v_user_id uuid;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_total_expected numeric := 0;
  v_winner_amount numeric := 0;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_rows integer;
BEGIN
  -- Every rolling and terminal money authority enters one transaction lane
  -- before it can own an event, obligation, bank, or recipient row.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL OR p_observed_winner_id IS NULL THEN
    RAISE EXCEPTION 'place settlement requires tournament and observed winner ids'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical lock order. Re-locks inside owner-only callees are rows already
  -- owned by this transaction and therefore cannot invert a wait dependency.
  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  v_status := upper(COALESCE(v_t.status,''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot settle from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not an ordinary cash ladder',
      p_tournament_id USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_payouts p
              WHERE p.tournament_id = p_tournament_id
                AND lower(COALESCE(p.source,'')) = 'final_table_deal')
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id = p_tournament_id
                   AND o.kind = 'final_table_deal') THEN
    RAISE EXCEPTION
      'tournament % carries final-table-deal evidence; use the deal authority',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Funding the advertised guarantee is part of this settlement transaction,
  -- not a best-effort request made by the game process immediately beforehand.
  -- fn_apply_prize_guarantee re-locks the row already owned here and either
  -- debits the event-owned bank plus finalizes the pool, or raises. Prove its
  -- receipt against the refreshed row before deriving even the first place; a
  -- refusal therefore rolls back the overlay, every payout and the finish.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_places');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.variant, t.tournament_type, t.is_premium_spin,
         t.satellite_target_id, t.satellite_target, t.prize_pool,
         t.bubble_protection, t.buy_in_amount, t.guaranteed_prize,
         t.prize_pool_finalized
    INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1 FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id FOR UPDATE;
  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF EXISTS (SELECT 1 FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'registered') THEN
    RAISE EXCEPTION 'tournament % still has a registered unresolved player',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- The helper counts the final field, so derive only after the complete
  -- roster has joined the canonical tournament -> roster lock sequence.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place',a.place,'amount',a.amount) ORDER BY a.place),'[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty ladder', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_live_count FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text IN ('playing','winner');
  IF v_live_count > 1 THEN
    RAISE EXCEPTION 'tournament % still has % live players',
      p_tournament_id, v_live_count USING ERRCODE = '55000';
  ELSIF v_live_count = 1 THEN
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text IN ('playing','winner');
  ELSE
    -- The observed last survivor may already have crossed through
    -- `eliminated` in an all-in race. The committed transition sequence, not
    -- a wall clock, proves that this row was the final elimination.
    SELECT tp.* INTO v_winner FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = p_observed_winner_id
       AND tp.status::text = 'eliminated'
       AND tp.elimination_sequence IS NOT NULL;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.id <> v_winner.id
         AND tp.elimination_sequence = v_winner.elimination_sequence
    ) THEN
      RAISE EXCEPTION
        'tournament % has an ambiguous final elimination witness',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF FOUND AND EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND (tp.elimination_sequence IS NULL
              OR tp.elimination_sequence > v_winner.elimination_sequence)
    ) THEN
      v_winner := NULL;
    END IF;
  END IF;
  IF v_winner.id IS NULL OR v_winner.user_id IS DISTINCT FROM p_observed_winner_id THEN
    RAISE EXCEPTION 'observed winner % does not match locked winner % for tournament %',
      p_observed_winner_id, v_winner.user_id, p_tournament_id
      USING ERRCODE = '40001';
  END IF;

  -- Lock the whole set once, before validation or the ascending-place walk.
  PERFORM 1 FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND (o.place IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = o.place))
  ) THEN
    RAISE EXCEPTION
      'tournament % has a place obligation outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  IF v_status = 'COMPLETED' THEN
    IF v_winner.status::text <> 'winner' OR v_winner.position <> 1 THEN
      RAISE EXCEPTION
        'COMPLETED tournament % is not an exact replay: winner is not durable',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  ELSE
    -- Recorded finish positions are the engine's live witness. Never rebuild
    -- an all-busted field from timestamps. Promotion may fill first place, but
    -- it cannot displace another recorded first or vacate a ladder place.
    IF EXISTS (SELECT 1 FROM public.tournament_players tp
                WHERE tp.tournament_id = p_tournament_id
                  AND tp.position = 1
                  AND tp.user_id <> v_winner.user_id) THEN
      RAISE EXCEPTION 'tournament % assigns first place to another player',
        p_tournament_id USING ERRCODE = '23505';
    END IF;
    IF v_winner.position IS NOT NULL AND v_winner.position <> 1
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_ladder) a
                    WHERE (a->>'place')::integer = v_winner.position) THEN
      RAISE EXCEPTION
        'promoting winner % would vacate cash place % in tournament %',
        v_winner.user_id, v_winner.position, p_tournament_id
        USING ERRCODE = '55000';
    END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1,
           eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament % could not promote exactly one winner',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    -- Final numeric positions are derived from the transition witness, not
    -- from the field size that happened to exist when each player busted.
    -- This is the root fix for late registration enlarging the field after an
    -- early elimination. Existing money evidence is never relabelled: a
    -- legacy event whose paid place would move fails closed for explicit
    -- adjudication instead of rewriting settled history.
    SELECT count(*), count(tp.elimination_sequence),
           count(DISTINCT tp.elimination_sequence)
      INTO v_eliminated_count, v_sequenced_count, v_rows
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated';
    IF v_eliminated_count <> v_field_size - 1
       OR v_sequenced_count <> v_eliminated_count
       OR v_rows <> v_eliminated_count THEN
      RAISE EXCEPTION
        'tournament % has no complete durable elimination sequence (%/% of %)',
        p_tournament_id, v_sequenced_count, v_rows, v_eliminated_count
        USING ERRCODE = 'P0404';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (
          SELECT tp.id, tp.position,
                 row_number() OVER (
                   ORDER BY tp.elimination_sequence DESC, tp.id ASC
                 )::integer + 1 AS expected_position
            FROM public.tournament_players tp
           WHERE tp.tournament_id = p_tournament_id
             AND tp.status::text = 'eliminated'
        ) ranked
       WHERE ranked.position IS DISTINCT FROM ranked.expected_position
    ) THEN
      IF EXISTS (
        SELECT 1 FROM public.tournament_payouts p
         WHERE p.tournament_id = p_tournament_id
           AND p."position" IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id
           AND o.kind = 'place'
      ) THEN
        RAISE EXCEPTION
          'tournament % needs a late-entry position normalization but already carries settled place evidence',
          p_tournament_id USING ERRCODE = 'P0404';
      END IF;

      UPDATE public.tournament_players tp
         SET position = NULL
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated';

      WITH ranked AS (
        SELECT tp.id,
               row_number() OVER (
                 ORDER BY tp.elimination_sequence DESC, tp.id ASC
               )::integer + 1 AS expected_position
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated'
      )
      UPDATE public.tournament_players tp
         SET position = ranked.expected_position
        FROM ranked
       WHERE tp.id = ranked.id;
    END IF;
  END IF;

  -- Derive the single pool-funded bubble promise after standings are final.
  -- The percentage helper has already reserved this exact amount from its
  -- ladder. Satellites never enter this authority: their bubble is paid the
  -- residual that cannot buy a full seat by the satellite settle path.
  SELECT max((a->>'place')::integer) + 1
    INTO v_bubble_place
    FROM jsonb_array_elements(v_ladder) a;
  IF COALESCE(v_t.bubble_protection, false)
     AND v_bubble_place IS NOT NULL
     AND v_bubble_place <= v_field_size THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has invalid bubble buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;
    v_bubble_amount := round(v_t.buy_in_amount, 2);
    IF v_bubble_amount > v_t.prize_pool THEN
      RAISE EXCEPTION 'tournament % bubble amount % exceeds pool %',
        p_tournament_id, v_bubble_amount, v_t.prize_pool
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), min(tp.user_id::text)::uuid
      INTO v_rows, v_bubble_user_id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.status::text = 'eliminated';
    IF v_rows <> 1 OR v_bubble_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no single eliminated stone bubble at place %',
        p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
    END IF;
  END IF;

  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_bubble_payout_count, v_bubble_paid
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';
  SELECT count(*) INTO v_bubble_ob_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';

  IF v_bubble_amount = 0 THEN
    IF v_bubble_payout_count <> 0 OR v_bubble_paid <> 0
       OR v_bubble_ob_count <> 0 THEN
      RAISE EXCEPTION 'tournament % carries bubble evidence but no bubble is due',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSE
    IF v_bubble_paid > v_bubble_amount
       OR EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND (p.user_id IS DISTINCT FROM v_bubble_user_id
              OR p."position" IS NOT NULL
              OR p.amount IS NULL
              OR p.amount::text IN ('NaN','Infinity','-Infinity')
              OR p.amount <= 0
              OR p.amount IS DISTINCT FROM round(p.amount, 2)
              OR p.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM public.wallet_credit_idempotency k
                 WHERE k.key = p.idempotency_key
                   AND k.user_id = p.user_id
                   AND k.amount = p.amount))) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble payout evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_bubble_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.user_id = v_bubble_user_id;
    IF v_bubble_ob_count > 0
       AND (v_bubble_ob_count <> 1 OR v_bubble_ob.id IS NULL
         OR v_bubble_ob.place IS NOT NULL
         OR v_bubble_ob.amount_owed IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_paid
         OR v_bubble_ob.amount_paid < 0
         OR v_bubble_ob.amount_paid > v_bubble_ob.amount_owed
         OR (v_bubble_ob.amount_paid = v_bubble_ob.amount_owed) IS DISTINCT FROM
            (v_bubble_ob.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'tournament % has malformed bubble obligation evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_bubble_ob_count = 0
       AND (v_bubble_payout_count <> 0 OR v_bubble_paid <> 0) THEN
      RAISE EXCEPTION 'tournament % has bubble money without its debt record',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF v_status = 'COMPLETED'
       AND (v_bubble_ob_count <> 1
         OR v_bubble_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.amount_paid IS DISTINCT FROM v_bubble_amount
         OR v_bubble_ob.settled_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = v_bubble_user_id
              AND tp.position = v_bubble_place
              AND tp.prize IS NOT DISTINCT FROM v_bubble_amount)) THEN
      RAISE EXCEPTION 'COMPLETED tournament % has no exact bubble replay',
        p_tournament_id USING ERRCODE = '55000';
    END IF;
  END IF;

  -- Anything paid from the prize bank outside the derived ladder makes a full
  -- structure payout unsafe. Bounty/seat sources belong to other authorities.
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND COALESCE(p.source,'') NOT IN
           ('bounty','own_bounty','mystery_bounty','mystery_bounty_residual',
            'bounty_residual','satellite_seat','bubble_protection')
       AND (p."position" IS NULL OR NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_ladder) a
          WHERE (a->>'place')::integer = p."position"))
  ) THEN
    RAISE EXCEPTION 'tournament % has prize evidence outside its derived ladder',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  -- Obligation-shaped wallet identity with no exact payout row is mixed
  -- evidence. It is checked globally before any place can move.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id AND p.amount = k.amount)
  ) THEN
    RAISE EXCEPTION
      'tournament % has wallet-credit identity without payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Preflight every place before settling the first one.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    v_place := v_row.place; v_amount := v_row.amount; v_user_id := v_row.user_id;
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'tournament % has no finisher for cash place %',
        p_tournament_id, v_place USING ERRCODE = '23502';
    END IF;
    IF v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount < 0
       OR v_amount IS DISTINCT FROM round(v_amount,2) THEN
      RAISE EXCEPTION 'tournament % derived invalid amount % for place %',
        p_tournament_id, v_amount, v_place USING ERRCODE = '22003';
    END IF;
    v_total_expected := v_total_expected + v_amount;
    IF v_place = 1 THEN v_winner_amount := v_amount; END IF;
    IF v_status = 'COMPLETED'
       AND v_row.cached_prize IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION
        'COMPLETED tournament %, place % has stale prize cache % (expected %)',
        p_tournament_id, v_place, v_row.cached_prize, v_amount
        USING ERRCODE = '55000';
    END IF;

    -- Each payout row is also required to name an exact wallet-credit identity.
    IF EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id AND p."position" = v_place
         AND (p.user_id IS DISTINCT FROM v_user_id OR p.amount IS NULL
           OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount < 0
           OR p.amount IS DISTINCT FROM round(p.amount,2)
           OR p.idempotency_key IS NULL OR NOT EXISTS (
             SELECT 1 FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key AND k.user_id = p.user_id
                AND k.amount = p.amount))
    ) THEN
      RAISE EXCEPTION
        'tournament %, place % has mixed/malformed/wrong-recipient evidence',
        p_tournament_id, v_place USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*), COALESCE(sum(p.amount),0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p."position" = v_place;
    v_evidence := round(v_evidence,2);
    IF v_evidence > v_amount THEN
      RAISE EXCEPTION 'tournament %, place % records % above entitlement %',
        p_tournament_id, v_place, v_evidence, v_amount USING ERRCODE = '23514';
    END IF;

    v_ob := NULL;
    SELECT * INTO v_ob FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place' AND o.place = v_place;
    IF FOUND THEN
      IF v_ob.user_id IS DISTINCT FROM v_user_id OR v_ob.amount_owed IS NULL
         OR v_ob.amount_paid IS NULL
         OR v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
         OR v_ob.amount_owed IS DISTINCT FROM round(v_ob.amount_owed,2)
         OR v_ob.amount_paid IS DISTINCT FROM round(v_ob.amount_paid,2)
         OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
         OR v_ob.amount_paid > v_ob.amount_owed
         OR v_ob.amount_owed > v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_evidence THEN
        RAISE EXCEPTION 'tournament %, place % has incompatible obligation',
          p_tournament_id, v_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_amount = 0 THEN
      -- Zero-valued ladder places are standings, not debts.
      IF v_evidence <> 0 OR (v_ob.id IS NOT NULL
         AND (v_ob.amount_owed <> 0 OR v_ob.amount_paid <> 0)) THEN
        RAISE EXCEPTION 'zero-value place % in tournament % carries money evidence',
          v_place, p_tournament_id USING ERRCODE = '23514';
      END IF;
    ELSIF v_status = 'COMPLETED' THEN
      IF v_ob.id IS NULL OR v_ob.amount_owed IS DISTINCT FROM v_amount
         OR v_ob.amount_paid IS DISTINCT FROM v_amount
         OR v_evidence IS DISTINCT FROM v_amount THEN
        RAISE EXCEPTION 'COMPLETED tournament %, place % is not an exact replay',
          p_tournament_id, v_place USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;

  IF round(v_total_expected + v_bubble_amount, 2)
       IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % ladder % plus bubble % does not equal locked pool %',
      p_tournament_id, v_total_expected, v_bubble_amount, v_t.prize_pool
      USING ERRCODE = '23514';
  END IF;

  IF v_status <> 'COMPLETED' THEN
    -- Materialize the bubble and the entire positive ladder before the first
    -- wallet credit. The payment walk is driven from one complete locked debt
    -- set, so failure on any recipient rolls every obligation and credit back.
    IF v_bubble_amount > 0 AND v_bubble_ob_count = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
      VALUES
        (p_tournament_id,'bubble_protection',NULL,v_bubble_user_id,
         v_bubble_amount,0,'engine.fn_settle_tournament_places',NULL)
      RETURNING * INTO v_bubble_ob;
      v_bubble_ob_count := 1;
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place;

      UPDATE public.tournament_obligations o
         SET amount_owed = v_row.amount,
             source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
             updated_at = now()
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN
        INSERT INTO public.tournament_obligations
          (tournament_id,kind,place,user_id,amount_owed,amount_paid,source,settled_at)
        VALUES
          (p_tournament_id,'place',v_row.place,v_row.user_id,v_row.amount,
           v_evidence,'engine.fn_settle_tournament_places',
           CASE WHEN v_evidence = v_row.amount THEN now() ELSE NULL END);
      ELSIF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament %, place % matched % obligations',
          p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
      END IF;
    END LOOP;

    -- Re-lock/prove the complete set immediately before any raw payer runs.
    PERFORM 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind IN ('bubble_protection','place')
     ORDER BY o.kind, o.place NULLS LAST, o.id FOR UPDATE;

    IF v_bubble_amount > 0 THEN
      v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
        p_tournament_id, v_bubble_user_id, v_bubble_amount);
    END IF;

    FOR v_row IN
      SELECT (a->>'place')::integer AS place,
             (a->>'amount')::numeric AS amount, tp.user_id
        FROM jsonb_array_elements(v_ladder) a
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (a->>'place')::integer
       WHERE (a->>'amount')::numeric > 0
       ORDER BY (a->>'place')::integer
    LOOP
      v_result := public.fn_ca_settle_tournament_place_raw(
        p_tournament_id,v_row.place,v_row.user_id,v_row.amount);
      IF COALESCE((v_result->>'fully_settled')::boolean,false) IS NOT TRUE THEN
        RAISE EXCEPTION 'tournament %, place % returned a partial settlement',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    -- tournament_players.prize is presentation cache, stamped only from the
    -- successfully settled DB ladder and in this same transaction.
    UPDATE public.tournament_players SET prize = 0
     WHERE tournament_id = p_tournament_id;
    FOR v_row IN SELECT (a->>'place')::integer AS place,
                         (a->>'amount')::numeric AS amount
                   FROM jsonb_array_elements(v_ladder) a
    LOOP
      UPDATE public.tournament_players SET prize = v_row.amount
       WHERE tournament_id = p_tournament_id AND position = v_row.place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'could not stamp one prize cache for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END LOOP;

    IF v_bubble_amount > 0 THEN
      UPDATE public.tournament_players
         SET prize = v_bubble_amount
       WHERE tournament_id = p_tournament_id
         AND user_id = v_bubble_user_id
         AND position = v_bubble_place;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION
          'could not stamp one bubble prize cache for tournament %, place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
    END IF;

    IF v_status = 'RUNNING' THEN
      UPDATE public.tournaments SET status = 'COMPLETING'
       WHERE id = p_tournament_id AND status = 'RUNNING';
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'tournament % lost its RUNNING finish claim',
          p_tournament_id USING ERRCODE = '40001';
      END IF;
      v_status := 'COMPLETING';
    END IF;
  END IF;

  IF v_bubble_amount > 0 AND v_status = 'COMPLETED' THEN
    -- Exact replay only: the completed preflight above proved this call cannot
    -- move money, while the raw helper proves every durable receipt again.
    v_bubble_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
  END IF;

  IF v_bubble_amount > 0 AND NOT EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id = v_bubble_user_id
       AND tp.position = v_bubble_place
       AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
  ) THEN
    RAISE EXCEPTION
      'post-settlement bubble prize-cache proof failed for tournament %, place %',
      p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
  END IF;

  -- Prove the durable end-state and build the presentation-only receipt.
  FOR v_row IN
    SELECT (a->>'place')::integer AS place,
           (a->>'amount')::numeric AS amount, tp.user_id,
           tp.prize AS cached_prize
      FROM jsonb_array_elements(v_ladder) a
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (a->>'place')::integer
     ORDER BY (a->>'place')::integer
  LOOP
    IF v_row.cached_prize IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'post-settlement prize-cache proof failed for tournament %, place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
    IF v_row.amount > 0 THEN
      v_ob := NULL;
      SELECT * INTO v_ob FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place' AND o.place = v_row.place;
      SELECT COALESCE(sum(p.amount),0) INTO v_evidence
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p."position" = v_row.place AND p.user_id = v_row.user_id;
      IF v_ob.id IS NULL OR v_ob.user_id IS DISTINCT FROM v_row.user_id
         OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
         OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
         OR v_evidence IS DISTINCT FROM v_row.amount THEN
        RAISE EXCEPTION 'post-settlement proof failed for tournament %, place %',
          p_tournament_id, v_row.place USING ERRCODE = 'P0404';
      END IF;
    END IF;
    v_payouts := v_payouts || jsonb_build_object(
      'place',v_row.place,'user_id',v_row.user_id,'amount',v_row.amount);
  END LOOP;

  RETURN jsonb_build_object(
    'ok',true,
    'fully_settled',true,
    'status',v_status,
    'payouts',v_payouts,
    'bubble_protection',CASE WHEN v_bubble_amount > 0 THEN
      jsonb_build_object('user_id',v_bubble_user_id,'position',v_bubble_place,
                         'amount',v_bubble_amount)
      ELSE 'null'::jsonb END,
    'winner_amount',v_winner_amount);
END;
$settle_places$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_places(uuid,uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_tournament_place_amounts(uuid) IS
  'Owner-only exact-cent cash ladder derived from the locked tournament row and final field; a due bubble buy-in is reserved from the pool before percentages, and known Spins use the canonical drawn tier.';
COMMENT ON FUNCTION public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric) IS
  'Owner-only raw place payer used by the atomic service door. A partial result raises and rolls the outer ladder back.';
COMMENT ON FUNCTION public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric) IS
  'Owner-only raw payer for a database-derived, pool-funded stone-bubble buy-in. Partial settlement raises and rolls its outer transaction back.';
COMMENT ON FUNCTION public.fn_settle_tournament_bubble_protection(uuid,uuid) IS
  'Service-only immediate bubble door: identity is observed, while locked database state derives the eligible user, place and base buy-in.';
COMMENT ON FUNCTION public.fn_settle_tournament_places(uuid,uuid) IS
  'Service-only atomic cash finish: locked DB state derives the pool-funded bubble, winner, recipients and amounts; bubble, all places, winner standing and RUNNING-to-COMPLETING commit together or not at all.';

-- ROLLING CUTOVER: the deployed engine still invokes these legacy functions
-- until the atomic server build is live. Their bodies, ACLs, schedules and
-- heartbeat registrations must remain untouched in stage 1. They are removed
-- by the explicit post-engine cleanup migration after production verification.
-- Stage 1 deliberately leaves every legacy cash function byte-for-byte
-- unchanged. The post-engine cleanup migration removes them after the
-- deployed runtime proves its atomic receipt path.


-- This is a DB-first rolling cutover. Keep the old final-table RPC callable
-- and byte-for-byte unchanged until the new server has been published.
DO $remember_legacy_final_table_deal$
DECLARE
  v_legacy_hash text;
BEGIN
  IF to_regprocedure('public.fn_final_table_deal(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'atomic deal cutover requires the existing fn_final_table_deal(uuid)';
  END IF;
  SELECT md5(pg_get_functiondef(
           'public.fn_final_table_deal(uuid)'::regprocedure))
    INTO v_legacy_hash;
  PERFORM set_config('app.atomic_deal_legacy_hash', v_legacy_hash, true);
END;
$remember_legacy_final_table_deal$;

-- Owner-only payment primitive for a database-derived deal share.
CREATE OR REPLACE FUNCTION public.fn_ca_settle_final_table_deal_share_raw(p_tournament_id uuid, p_user_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $deal_share_raw$
DECLARE
  v_result jsonb;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_amount IS NULL
     OR p_amount::text IN ('NaN','Infinity','-Infinity')
     OR p_amount <= 0
     OR p_amount IS DISTINCT FROM round(p_amount, 2) THEN
    RAISE EXCEPTION 'raw final-table-deal settlement received invalid derived inputs'
      USING ERRCODE = '22023';
  END IF;

  v_result := public.fn_settle_tournament_obligation(
    p_tournament_id,
    'final_table_deal',
    NULL,
    p_user_id,
    p_amount,
    'final_table_deal',
    'Final Table Deal (Exact-Cent Chip Chop)',
    NULL
  );

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
     OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM p_amount
     OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM p_amount
     OR COALESCE((v_result->>'remaining')::numeric, p_amount) <> 0 THEN
    RAISE EXCEPTION 'tournament % deal share for % did not settle in full: %',
      p_tournament_id, p_user_id, v_result USING ERRCODE = 'P0404';
  END IF;

  RETURN v_result;
END;
$deal_share_raw$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_final_table_deal(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $final_table_deal$
DECLARE
  v_t record;
  v_status text;
  v_table_size integer;
  v_field_size integer;
  v_live_count integer;
  v_live_table_count integer;
  v_live_seat_count integer;
  v_live_seated_users integer;
  v_vote_count integer;
  v_total_chips numeric;
  v_pool_cents bigint;
  v_prior_paid_cents bigint;
  v_fixed_entitlement_cents bigint := 0;
  v_fixed_paid_cents bigint := 0;
  v_fixed_shortfall_cents bigint := 0;
  v_fixed_count integer := 0;
  v_ladder_max_place integer;
  v_bubble_place integer;
  v_bubble_user_id uuid;
  v_bubble_amount numeric(15,2) := 0;
  v_bubble_entitlement_cents bigint := 0;
  v_bubble_paid_cents bigint := 0;
  v_bubble_shortfall_cents bigint := 0;
  v_bubble_obligation_count integer := 0;
  v_bubble_candidate_count integer := 0;
  v_has_bubble boolean := false;
  v_bubble_obligation_source text :=
    'engine.fn_settle_tournament_bubble_protection';
  v_undistributed_cents bigint;
  v_distributed_cents bigint := 0;
  v_remainder_cents bigint;
  v_share_cents bigint;
  v_amount numeric(15,2);
  v_rank integer := 0;
  v_rows integer;
  v_now timestamptz := now();
  v_leader uuid;
  v_result jsonb;
  v_guarantee_result jsonb;
  v_ladder jsonb := '[]'::jsonb;
  v_fixed jsonb := '[]'::jsonb;
  v_shares jsonb := '[]'::jsonb;
  v_payouts jsonb := '[]'::jsonb;
  v_winner_amount numeric(15,2) := 0;
  v_row record;
  v_ob public.tournament_obligations%ROWTYPE;
  v_evidence numeric;
  v_evidence_count integer;
  v_not_pool text[] := ARRAY[
    'satellite_seat','bounty','mystery_bounty','bounty_residual',
    'own_bounty','mystery_bounty_residual'
  ];
BEGIN
  -- Share the same first lock as the whole-event terminal authority. Re-entry
  -- from that authority is transaction-local and immediate.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'final-table deal requires a tournament id'
      USING ERRCODE = '22004';
  END IF;

  -- Canonical money lock order: tournament, authoritative guarantee-funding
  -- bank, complete roster, complete obligation set. Every validation and every
  -- amount derivation follows it.
  SELECT t.id, t.status, t.prize_pool, t.final_table_deal_enabled,
         t.table_size, t.variant, t.tournament_type, t.satellite_target_id,
         t.satellite_target, t.bubble_protection, t.buy_in_amount,
         t.guaranteed_prize, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist', p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;

  v_status := upper(COALESCE(v_t.status::text, ''));
  IF v_status NOT IN ('RUNNING','COMPLETING','COMPLETED') THEN
    RAISE EXCEPTION 'tournament % cannot execute or replay a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF lower(COALESCE(v_t.variant::text, '')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text, '')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite, not a cash final-table deal',
      p_tournament_id USING ERRCODE = '22023';
  END IF;

  -- The chop and any guarantee overlay are one commit. A process-side funding
  -- request can improve the live preview, but it is never settlement evidence:
  -- this locked authority funds again idempotently and proves the refreshed
  -- pool before it derives fixed places or a single deal share.
  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool < 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  IF v_t.guaranteed_prize IS NOT NULL
     AND (v_t.guaranteed_prize::text IN ('NaN','Infinity','-Infinity')
       OR v_t.guaranteed_prize < 0
       OR v_t.guaranteed_prize IS DISTINCT FROM round(v_t.guaranteed_prize, 2)) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent guarantee %',
      p_tournament_id, v_t.guaranteed_prize USING ERRCODE = '22003';
  END IF;
  v_guarantee_result := public.fn_apply_prize_guarantee(
    p_tournament_id, 'engine.fn_settle_tournament_final_table_deal');
  IF COALESCE((v_guarantee_result->>'ok')::boolean, false) IS NOT TRUE
     OR (COALESCE((v_guarantee_result->>'overlay')::numeric,0) > 0
         AND COALESCE(
           (v_guarantee_result->>'overlay_journaled')::boolean,false)
             IS NOT TRUE) THEN
    RAISE EXCEPTION 'tournament % guarantee funding refused before deal: %',
      p_tournament_id, v_guarantee_result USING ERRCODE = 'P0404';
  END IF;

  SELECT t.id, t.status, t.prize_pool, t.final_table_deal_enabled,
         t.table_size, t.variant, t.tournament_type, t.satellite_target_id,
         t.satellite_target, t.bubble_protection, t.buy_in_amount,
         t.guaranteed_prize, t.prize_pool_finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF COALESCE(v_t.prize_pool_finalized, false) IS NOT TRUE
     OR v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2)
     OR v_t.prize_pool < COALESCE(v_t.guaranteed_prize, 0)
     OR v_guarantee_result->>'prize_pool' IS NULL
     OR (v_guarantee_result->>'prize_pool')::numeric IS DISTINCT FROM v_t.prize_pool THEN
    RAISE EXCEPTION
      'tournament % guarantee funding did not produce one finalized locked deal pool: result %, pool %, guarantee %, finalized %',
      p_tournament_id, v_guarantee_result, v_t.prize_pool,
      v_t.guaranteed_prize, v_t.prize_pool_finalized USING ERRCODE = 'P0404';
  END IF;

  PERFORM 1
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
   ORDER BY tp.id
   FOR UPDATE;

  PERFORM 1
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
   ORDER BY o.kind, o.place NULLS LAST, o.id
   FOR UPDATE;

  -- Evidence rows are append-only. Canonical payers hold the tournament lock;
  -- row locks additionally keep an existing receipt stable while it is proved.
  PERFORM 1
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
   ORDER BY p.id
   FOR SHARE;

  IF v_t.table_size IS NULL OR v_t.table_size < 2 OR v_t.table_size > 10 THEN
    RAISE EXCEPTION 'tournament % has invalid final-table size %',
      p_tournament_id, v_t.table_size USING ERRCODE = '23514';
  END IF;
  v_table_size := v_t.table_size;

  SELECT count(*) INTO v_field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id;
  IF v_field_size < 2 THEN
    RAISE EXCEPTION 'tournament % has fewer than two roster rows', p_tournament_id
      USING ERRCODE = '23514';
  END IF;

  -- Every payout row that consumes the prize pool must be finite, nonnegative,
  -- whole-cent evidence tied to the exact wallet-credit identity. The player
  -- prize column is deliberately absent from this calculation: it is a cache,
  -- never evidence that money moved.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND (
         p.amount IS NULL
         OR p.amount::text IN ('NaN','Infinity','-Infinity')
         OR p.amount <= 0
         OR p.amount IS DISTINCT FROM round(p.amount, 2)
         OR NOT EXISTS (
           SELECT 1
             FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.user_id = p.user_id
              AND (p."position" IS NULL OR tp.position = p."position")
         )
         OR (p.amount > 0 AND (
           p.idempotency_key IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM public.wallet_credit_idempotency k
              WHERE k.key = p.idempotency_key
                AND k.user_id = p.user_id
                AND k.amount = p.amount
           )
         ))
       )
  ) THEN
    RAISE EXCEPTION 'tournament % has malformed or unbacked prize payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_t.prize_pool IS NULL
     OR v_t.prize_pool::text IN ('NaN','Infinity','-Infinity')
     OR v_t.prize_pool <= 0
     OR v_t.prize_pool IS DISTINCT FROM round(v_t.prize_pool, 2) THEN
    RAISE EXCEPTION 'tournament % has invalid whole-cent prize pool %',
      p_tournament_id, v_t.prize_pool USING ERRCODE = '22003';
  END IF;
  v_pool_cents := round(v_t.prize_pool * 100)::bigint;

  -- The locked structure fixes every already-eliminated cash entitlement.
  -- Live places are superseded by the unanimous chip chop; places below the
  -- live field remain exact structure debts and reduce the chop residual at
  -- their full entitlement, whether previously unpaid, partly paid or paid.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place', a.place,
           'amount', a.amount,
           'cents', round(a.amount * 100)::bigint
         ) ORDER BY a.place), '[]'::jsonb)
    INTO v_ladder
    FROM public.fn_ca_tournament_place_amounts(p_tournament_id) a;
  IF jsonb_array_length(v_ladder) = 0 THEN
    RAISE EXCEPTION 'tournament % derived an empty cash structure',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  SELECT max((e->>'place')::integer)
    INTO v_ladder_max_place
    FROM jsonb_array_elements(v_ladder) e;
  IF v_ladder_max_place IS NULL OR v_ladder_max_place < 1 THEN
    RAISE EXCEPTION 'tournament % derived an invalid cash structure tail',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_bubble_place := v_ladder_max_place + 1;

  IF v_status = 'RUNNING' THEN
    SELECT count(*), COALESCE(sum(tp.chips), 0)
      INTO v_live_count, v_total_chips
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing'
       AND tp.eliminated_at IS NULL;
  ELSIF v_status IN ('COMPLETING','COMPLETED') THEN
    SELECT count(DISTINCT p.user_id) INTO v_live_count
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';
  ELSE
    RAISE EXCEPTION 'tournament % cannot execute or replay a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;

  IF v_live_count < 2 OR v_live_count > v_table_size THEN
    RAISE EXCEPTION 'tournament % has % dealt/live players outside final-table size %',
      p_tournament_id, v_live_count, v_table_size USING ERRCODE = '55000';
  END IF;

  -- Late registration can grow the final field after an early bust already
  -- received a then-correct position. Normalize the locked eliminated tail
  -- before pricing its fixed places. The DB-owned elimination_sequence is the
  -- durable chronology witness: the latest elimination gets live_count+1 and
  -- the earliest gets field_size. Mutable wall clocks and stale place numbers
  -- are never used to reconstruct history. The consolidated predecessor owns
  -- the sequence column, allocator, unique index and transition trigger.
  IF v_status = 'RUNNING' THEN
    IF EXISTS (
      SELECT 1 FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND (
           (tp.status::text = 'playing' AND tp.eliminated_at IS NULL
             AND (tp.position IS NOT NULL OR tp.elimination_sequence IS NOT NULL))
           OR
           (NOT (tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
             AND (tp.status::text <> 'eliminated'
               OR tp.eliminated_at IS NULL
               OR tp.position IS NULL
               OR tp.position < 2
               OR tp.position > v_field_size
               OR tp.elimination_sequence IS NULL
               OR tp.elimination_sequence <= 0))
         )
    ) OR (SELECT count(DISTINCT tp.elimination_sequence)
            FROM public.tournament_players tp
           WHERE tp.tournament_id = p_tournament_id
             AND tp.status::text = 'eliminated'
             AND tp.eliminated_at IS NOT NULL)
          <> v_field_size - v_live_count
    THEN
      RAISE EXCEPTION
        'tournament % roster lacks complete unique elimination-sequence evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    UPDATE public.tournament_players tp
       SET position = NULL
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
       AND tp.eliminated_at IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_field_size - v_live_count THEN
      RAISE EXCEPTION 'tournament % normalized % of % eliminated standings',
        p_tournament_id, v_rows, v_field_size - v_live_count
        USING ERRCODE = 'P0404';
    END IF;

    WITH ranked AS (
      SELECT tp.id,
             (v_live_count + row_number() OVER (
               ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
               AS normalized_position
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
    )
    UPDATE public.tournament_players tp
       SET position = ranked.normalized_position
      FROM ranked
     WHERE tp.id = ranked.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> v_field_size - v_live_count THEN
      RAISE EXCEPTION 'tournament % could not finish tail normalization',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF EXISTS (
    SELECT 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'eliminated'
       AND (tp.eliminated_at IS NULL OR tp.elimination_sequence IS NULL
         OR tp.elimination_sequence <= 0)
  ) OR (SELECT count(DISTINCT tp.elimination_sequence)
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'eliminated')
        <> (SELECT count(*)
              FROM public.tournament_players tp
             WHERE tp.tournament_id = p_tournament_id
               AND tp.status::text = 'eliminated') THEN
    RAISE EXCEPTION
      'tournament % replay lacks complete unique elimination-sequence evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Bubble protection is part of the locked tournament prize pool. It exists
  -- only when the durable eliminated tail already contains the one player at
  -- max(cash place)+1. If that place is still among the players making this
  -- deal, nobody bubbled and the full remaining pool is chopped. A completed
  -- bubble is exact prior pool evidence; partial or differently-owned state is
  -- never resumed.
  IF COALESCE(v_t.bubble_protection, false)
     AND v_field_size > v_ladder_max_place THEN
    IF v_t.buy_in_amount IS NULL
       OR v_t.buy_in_amount::text IN ('NaN','Infinity','-Infinity')
       OR v_t.buy_in_amount <= 0
       OR v_t.buy_in_amount IS DISTINCT FROM round(v_t.buy_in_amount, 2) THEN
      RAISE EXCEPTION 'tournament % has an invalid bubble-protection buy-in %',
        p_tournament_id, v_t.buy_in_amount USING ERRCODE = '22003';
    END IF;

    IF v_bubble_place > v_live_count THEN
      SELECT count(*)
        INTO v_bubble_candidate_count
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_bubble_place
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
         AND tp.elimination_sequence IS NOT NULL
         AND tp.elimination_sequence > 0;
      SELECT tp.user_id
        INTO v_bubble_user_id
        FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id
         AND tp.position = v_bubble_place
         AND tp.status::text = 'eliminated'
         AND tp.eliminated_at IS NOT NULL
         AND tp.elimination_sequence IS NOT NULL
         AND tp.elimination_sequence > 0
       ORDER BY tp.id
       LIMIT 1;
      IF v_bubble_candidate_count <> 1 OR v_bubble_user_id IS NULL THEN
        RAISE EXCEPTION
          'tournament % lacks one durable stone-bubble finisher at place %',
          p_tournament_id, v_bubble_place USING ERRCODE = 'P0404';
      END IF;
      v_has_bubble := true;
      v_bubble_amount := v_t.buy_in_amount::numeric(15,2);
      v_bubble_entitlement_cents := round(v_bubble_amount * 100)::bigint;
    END IF;
  END IF;

  SELECT count(*)
    INTO v_bubble_obligation_count
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'bubble_protection';
  SELECT count(*), COALESCE(sum(p.amount), 0)
    INTO v_evidence_count, v_evidence
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND p.source = 'bubble_protection';

  IF NOT v_has_bubble THEN
    IF v_bubble_obligation_count <> 0 OR v_evidence_count <> 0 THEN
      RAISE EXCEPTION
        'tournament % has bubble state without an eligible eliminated bubble',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  ELSIF v_bubble_obligation_count = 0 AND v_evidence_count = 0 THEN
    v_bubble_paid_cents := 0;
  ELSIF v_bubble_obligation_count = 1 AND v_evidence_count = 0 THEN
    -- A prior atomic attempt may have shaped the canonical debt before any
    -- wallet movement. That state is safe to resume, but only while it is
    -- exactly unpaid and has no orphaned obligation-key credit witness.
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key LIKE
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%';
    IF v_ob.id IS NULL
       OR v_ob.place IS NOT NULL
       OR v_ob.user_id IS DISTINCT FROM v_bubble_user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM 0::numeric
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NOT NULL
       OR v_rows <> 0 THEN
      RAISE EXCEPTION
        'tournament % has partial or mismatched unpaid bubble-protection state',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_bubble_paid_cents := 0;
  ELSIF v_bubble_obligation_count = 1 AND v_evidence_count = 1 THEN
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key =
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0';
    IF v_ob.id IS NULL
       OR v_ob.place IS NOT NULL
       OR v_ob.user_id IS DISTINCT FROM v_bubble_user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence IS DISTINCT FROM v_bubble_amount
       OR v_rows <> 1
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND p."position" IS NULL
            AND p.user_id = v_bubble_user_id
            AND p.amount = v_bubble_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       ) THEN
      RAISE EXCEPTION
        'tournament % has partial or mismatched bubble-protection evidence',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    v_bubble_paid_cents := v_bubble_entitlement_cents;
  ELSE
    RAISE EXCEPTION
      'tournament % has incomplete bubble-protection evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  v_bubble_shortfall_cents :=
    v_bubble_entitlement_cents - v_bubble_paid_cents;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_ladder) e
      LEFT JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id
       AND tp.position = (e->>'place')::integer
     WHERE (e->>'place')::integer > v_live_count
       AND (e->>'cents')::bigint > 0
       AND (tp.id IS NULL OR tp.status::text <> 'eliminated'
         OR tp.eliminated_at IS NULL)
  ) THEN
    RAISE EXCEPTION
      'tournament % has a positive eliminated-place entitlement without its exact finisher',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'place', q.place,
           'user_id', q.user_id,
           'amount', q.amount,
           'cents', q.cents,
           'evidence_cents', q.evidence_cents
         ) ORDER BY q.place), '[]'::jsonb)
    INTO v_fixed
    FROM (
      SELECT (e->>'place')::integer AS place,
             tp.user_id,
             (e->>'amount')::numeric(15,2) AS amount,
             (e->>'cents')::bigint AS cents,
             COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
               AS evidence_cents
        FROM jsonb_array_elements(v_ladder) e
        JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id
         AND tp.position = (e->>'place')::integer
        LEFT JOIN public.tournament_payouts p
          ON p.tournament_id = p_tournament_id
         AND p."position" = (e->>'place')::integer
         AND p.user_id = tp.user_id
         AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
         AND p.source <> 'final_table_deal'
         AND p.source <> 'bubble_protection'
       WHERE (e->>'place')::integer > v_live_count
         AND (e->>'cents')::bigint > 0
       GROUP BY (e->>'place')::integer, tp.user_id,
                (e->>'amount')::numeric(15,2), (e->>'cents')::bigint
    ) q;

  SELECT jsonb_array_length(v_fixed),
         COALESCE(sum((e->>'cents')::bigint), 0)::bigint,
         COALESCE(sum((e->>'evidence_cents')::bigint), 0)::bigint
    INTO v_fixed_count, v_fixed_entitlement_cents, v_fixed_paid_cents
    FROM jsonb_array_elements(v_fixed) e;

  -- Pool evidence before the deal must be exact evidence for one of those
  -- fixed eliminated places. Unpositioned, live-place, non-ITM and wrong-user
  -- rows cannot silently shrink the amount being chopped.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal'
       AND NOT (
         (p.source = 'bubble_protection'
          AND v_has_bubble
          AND p."position" IS NULL
          AND p.user_id = v_bubble_user_id
          AND p.amount = v_bubble_amount)
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(v_fixed) e
            WHERE (e->>'place')::integer = p."position"
              AND (e->>'user_id')::uuid = p.user_id
         )
       )
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_fixed) e
     WHERE (e->>'evidence_cents')::bigint < 0
        OR (e->>'evidence_cents')::bigint > (e->>'cents')::bigint
  ) THEN
    RAISE EXCEPTION
      'tournament % has payout evidence outside an exact fixed-place entitlement',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
    INTO v_prior_paid_cents
    FROM public.tournament_payouts p
   WHERE p.tournament_id = p_tournament_id
     AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
     AND COALESCE(p.source, '') <> 'final_table_deal';

  IF v_prior_paid_cents < 0 OR v_prior_paid_cents > v_pool_cents
     OR v_prior_paid_cents <>
          v_fixed_paid_cents + v_bubble_paid_cents THEN
    RAISE EXCEPTION 'tournament % records % prior prize cents against a % cent pool',
      p_tournament_id, v_prior_paid_cents, v_pool_cents
      USING ERRCODE = '23514';
  END IF;
  v_fixed_shortfall_cents := v_fixed_entitlement_cents - v_fixed_paid_cents;
  IF v_fixed_shortfall_cents < 0 OR v_bubble_shortfall_cents < 0
     OR v_prior_paid_cents + v_fixed_shortfall_cents
          + v_bubble_shortfall_cents > v_pool_cents THEN
    RAISE EXCEPTION 'tournament % has invalid fixed-place or bubble reserve',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  v_undistributed_cents :=
    v_pool_cents - v_prior_paid_cents - v_fixed_shortfall_cents
      - v_bubble_shortfall_cents;

  -- COMPLETING/COMPLETED is an evidence-only replay. It cannot infer a deal
  -- from mutable chip counts or silently convert a normal finish into a deal.
  IF v_status IN ('COMPLETING','COMPLETED') THEN
    IF v_has_bubble
       AND v_bubble_paid_cents <> v_bubble_entitlement_cents THEN
      RAISE EXCEPTION
        'tournament % replay lacks its exact pool-funded bubble receipt',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
    ) THEN
      RAISE EXCEPTION 'tournament % is % without a durable final-table-deal receipt',
        p_tournament_id, v_status USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.tournament_payouts p
       WHERE p.tournament_id = p_tournament_id
         AND p.source = 'final_table_deal'
         AND (p."position" IS NOT NULL OR p.amount <= 0)
    ) THEN
      RAISE EXCEPTION 'tournament % has malformed final-table-deal payout rows',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM (
          SELECT p.user_id, count(*) AS n, sum(p.amount) AS amount,
                 min(p.idempotency_key) AS idempotency_key
            FROM public.tournament_payouts p
           WHERE p.tournament_id = p_tournament_id
             AND p.source = 'final_table_deal'
           GROUP BY p.user_id
        ) e
        LEFT JOIN public.tournament_players tp
          ON tp.tournament_id = p_tournament_id AND tp.user_id = e.user_id
        LEFT JOIN public.tournament_obligations o
          ON o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
         AND o.place IS NULL
         AND o.user_id = e.user_id
       WHERE e.n <> 1
          OR tp.id IS NULL
          OR tp.position IS NULL
          OR tp.position < 1
          OR tp.position > v_live_count
          OR tp.prize IS DISTINCT FROM e.amount
          OR (tp.position = 1 AND tp.status::text <> 'winner')
          OR (tp.position > 1 AND tp.status::text <> 'eliminated')
          OR o.id IS NULL
          OR o.amount_owed IS DISTINCT FROM e.amount
          OR o.amount_paid IS DISTINCT FROM e.amount
          OR o.source IS DISTINCT FROM 'final_table_deal'
          OR o.adjustment_id IS NOT NULL
          OR o.settled_at IS NULL
          OR e.idempotency_key IS DISTINCT FROM
             'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':0'
          OR (SELECT count(*)
                FROM public.wallet_credit_idempotency k
               WHERE k.key LIKE
                 'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%')
             <> 1
          OR NOT EXISTS (
            SELECT 1
              FROM public.wallet_credit_idempotency k
             WHERE k.key = e.idempotency_key
               AND k.user_id = e.user_id
               AND k.amount = e.amount
          )
    ) OR EXISTS (
      SELECT 1
        FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal'
         AND (o.place IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM public.tournament_payouts p
            WHERE p.tournament_id = p_tournament_id
              AND p.source = 'final_table_deal'
              AND p.user_id = o.user_id
         ))
    ) THEN
      RAISE EXCEPTION 'tournament % final-table-deal obligations, evidence and standings disagree',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF (SELECT count(*) FROM public.tournament_obligations o
         WHERE o.tournament_id = p_tournament_id AND o.kind = 'place')
         <> v_fixed_count
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_fixed) e
           LEFT JOIN public.tournament_obligations o
             ON o.tournament_id = p_tournament_id
            AND o.kind = 'place'
            AND o.place = (e->>'place')::integer
          WHERE o.id IS NULL
             OR o.user_id IS DISTINCT FROM (e->>'user_id')::uuid
             OR o.amount_owed IS DISTINCT FROM (e->>'amount')::numeric
             OR o.amount_paid IS DISTINCT FROM (e->>'amount')::numeric
             OR o.settled_at IS NULL
             OR (e->>'evidence_cents')::bigint <> (e->>'cents')::bigint
       ) THEN
      RAISE EXCEPTION
        'tournament % fixed-place obligations or evidence are not fully settled',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    IF (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.position BETWEEN 1 AND v_field_size) <> v_field_size
       OR EXISTS (
         SELECT 1 FROM generate_series(1, v_field_size) g(place)
          WHERE NOT EXISTS (
            SELECT 1 FROM public.tournament_players tp
             WHERE tp.tournament_id = p_tournament_id
               AND tp.position = g.place
          )
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND (tp.position IS NULL OR tp.position < 1
              OR tp.position > v_field_size)
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.position = 1
            AND tp.status::text = 'winner'
            AND tp.eliminated_at IS NULL
            AND tp.elimination_sequence IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.position > 1
            AND (tp.status::text <> 'eliminated'
              OR tp.eliminated_at IS NULL
              OR tp.elimination_sequence IS NULL
              OR tp.elimination_sequence <= 0)
       )
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT tp.position,
                    (1 + row_number() OVER (
                      ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                      AS expected_position
               FROM public.tournament_players tp
              WHERE tp.tournament_id = p_tournament_id
                AND tp.status::text = 'eliminated'
           ) ranked
          WHERE ranked.position IS DISTINCT FROM ranked.expected_position
       )
       OR EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.prize IS DISTINCT FROM COALESCE((
              SELECT sum(p.amount)
                FROM public.tournament_payouts p
               WHERE p.tournament_id = p_tournament_id
                 AND p.user_id = tp.user_id
                 AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
            ), 0)
       ) THEN
      RAISE EXCEPTION 'tournament % replay has incomplete final standings',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;

    SELECT count(*) INTO v_vote_count
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position BETWEEN 1 AND v_live_count
       AND EXISTS (
         SELECT 1 FROM public.tournament_deal_votes v
          WHERE v.tournament_id = p_tournament_id
            AND v.user_id = tp.user_id
       );
    IF v_vote_count <> v_live_count THEN
      RAISE EXCEPTION 'tournament % replay has only % of % durable deal votes',
        p_tournament_id, v_vote_count, v_live_count USING ERRCODE = 'P0404';
    END IF;

    SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
      INTO v_distributed_cents
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';
    IF v_prior_paid_cents + v_distributed_cents <> v_pool_cents THEN
      RAISE EXCEPTION 'tournament % replay accounts for % of % prize cents',
        p_tournament_id, v_prior_paid_cents + v_distributed_cents, v_pool_cents
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'place', tp.position,
             'user_id', tp.user_id,
             'amount', p.amount
           ) ORDER BY tp.position), '[]'::jsonb)
      INTO v_payouts
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal';

    SELECT p.amount INTO v_winner_amount
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p_tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal'
       AND tp.position = 1;

    RETURN jsonb_build_object(
      'ok', true,
      'fully_settled', true,
      'status', v_status,
      'payouts', v_payouts,
      'winner_amount', v_winner_amount,
      'money_path', 'fn_settle_tournament_final_table_deal');
  END IF;

  IF v_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'tournament % cannot execute a deal from status %',
      p_tournament_id, v_t.status USING ERRCODE = '55000';
  END IF;
  IF COALESCE(v_t.final_table_deal_enabled, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournament % does not have final-table deals enabled',
      p_tournament_id USING ERRCODE = '55000';
  END IF;
  IF v_undistributed_cents <= 0 THEN
    RAISE EXCEPTION 'tournament % has no undistributed prize money',
      p_tournament_id USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id AND p.source = 'final_table_deal'
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id AND o.kind = 'final_table_deal'
  ) THEN
    RAISE EXCEPTION 'RUNNING tournament % already has final-table-deal state',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF v_total_chips IS NULL
     OR v_total_chips::text IN ('NaN','Infinity','-Infinity')
     OR v_total_chips <= 0
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text = 'playing'
          AND tp.eliminated_at IS NULL
          AND (tp.chips IS NULL OR tp.chips < 0)
     ) THEN
    RAISE EXCEPTION 'tournament % has invalid live chip evidence',
      p_tournament_id USING ERRCODE = '22003';
  END IF;

  -- A fresh deal may not omit an unresolved roster row or overwrite an
  -- existing standing. Prior eliminated positions must already occupy exactly
  -- the contiguous tail after the players who are about to chop.
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND NOT (tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
       AND (tp.status::text <> 'eliminated' OR tp.position IS NULL
         OR tp.eliminated_at IS NULL
         OR tp.position <= v_live_count OR tp.position > v_field_size)
  ) OR EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
       AND tp.position IS NOT NULL
  ) OR (SELECT count(*) FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.position BETWEEN v_live_count + 1 AND v_field_size)
       <> v_field_size - v_live_count
  THEN
    RAISE EXCEPTION 'tournament % roster does not carry a complete pre-deal standing tail',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- A pre-existing place debt is accepted only when its owner, amount paid
  -- and payout evidence describe one exact fixed entitlement. A historical
  -- smaller amount_owed may be raised to the canonical structure amount below;
  -- paid evidence may never be rewritten or inferred from the prize cache.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(v_fixed) e
          WHERE (e->>'place')::integer = o.place
            AND (e->>'user_id')::uuid = o.user_id
            AND o.amount_owed IS NOT NULL
            AND o.amount_paid IS NOT NULL
            AND o.amount_owed::text NOT IN ('NaN','Infinity','-Infinity')
            AND o.amount_paid::text NOT IN ('NaN','Infinity','-Infinity')
            AND o.amount_owed = round(o.amount_owed, 2)
            AND o.amount_paid = round(o.amount_paid, 2)
            AND o.amount_paid >= 0
            AND o.amount_owed >= o.amount_paid
            AND o.amount_owed <= (e->>'amount')::numeric
            AND round(o.amount_paid * 100)::bigint =
                (e->>'evidence_cents')::bigint
       )
  ) THEN
    RAISE EXCEPTION 'tournament % has an incompatible fixed-place obligation',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tournament_obligations o
      JOIN public.wallet_credit_idempotency k
        ON k.key LIKE
           'tourney:' || p_tournament_id::text || ':obl:' || o.id::text || ':%'
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
          WHERE p.idempotency_key = k.key
            AND p.tournament_id = p_tournament_id
            AND p.user_id = k.user_id
            AND p.amount = k.amount
            AND p."position" = o.place
       )
  ) THEN
    RAISE EXCEPTION
      'tournament % has a fixed-place wallet key without exact payout evidence',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- An alive player cannot already own prize-bank payout evidence. That would
  -- make the remaining pool valid in aggregate but the recipient debt wrong.
  IF EXISTS (
    SELECT 1
      FROM public.tournament_payouts p
      JOIN public.tournament_players tp
        ON tp.tournament_id = p.tournament_id AND tp.user_id = p.user_id
     WHERE p.tournament_id = p_tournament_id
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
       AND p.amount > 0
  ) THEN
    RAISE EXCEPTION 'tournament % has prior prize evidence for a live deal player',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- Lock the current table layout after the three canonical money sets. The
  -- active seats must be exactly the live roster and must all be on one live
  -- tournament table.
  PERFORM 1 FROM public.tables tb
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY tb.id FOR UPDATE;
  PERFORM 1
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
   ORDER BY s.id
   FOR UPDATE OF s;

  SELECT count(DISTINCT s.table_id), count(*), count(DISTINCT s.user_id)
    INTO v_live_table_count, v_live_seat_count, v_live_seated_users
    FROM public.table_seats s
    JOIN public.tables tb ON tb.id = s.table_id
   WHERE tb.tournament_id = p_tournament_id
     AND lower(tb.status::text) IN ('running','waiting')
     AND s.left_at IS NULL
     AND s.user_id IS NOT NULL;
  IF v_live_table_count <> 1
     OR v_live_seat_count <> v_live_count
     OR v_live_seated_users <> v_live_count
     OR EXISTS (
       (SELECT tp.user_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
       EXCEPT
       (SELECT s.user_id
          FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = p_tournament_id
           AND lower(tb.status::text) IN ('running','waiting')
           AND s.left_at IS NULL AND s.user_id IS NOT NULL)
     ) OR EXISTS (
       (SELECT s.user_id
          FROM public.table_seats s
          JOIN public.tables tb ON tb.id = s.table_id
         WHERE tb.tournament_id = p_tournament_id
           AND lower(tb.status::text) IN ('running','waiting')
           AND s.left_at IS NULL AND s.user_id IS NOT NULL)
       EXCEPT
       (SELECT tp.user_id
          FROM public.tournament_players tp
         WHERE tp.tournament_id = p_tournament_id
           AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL)
     ) THEN
    RAISE EXCEPTION 'tournament % live roster is not seated together at one final table',
      p_tournament_id USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.tournament_deal_votes v
   WHERE v.tournament_id = p_tournament_id
   ORDER BY v.user_id FOR SHARE;
  SELECT count(*) INTO v_vote_count
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.tournament_deal_votes v
        WHERE v.tournament_id = p_tournament_id AND v.user_id = tp.user_id
     );
  IF v_vote_count <> v_live_count THEN
    RAISE EXCEPTION 'tournament % has only % of % required live-player votes',
      p_tournament_id, v_vote_count, v_live_count USING ERRCODE = '55000';
  END IF;

  -- Price in integer cents. Each proportional share is floored; the exact
  -- residual goes to the deterministic chip leader (rank 1).
  FOR v_row IN
    SELECT tp.user_id, tp.chips, tp.registered_at
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.status::text = 'playing' AND tp.eliminated_at IS NULL
     ORDER BY tp.chips DESC, tp.registered_at ASC NULLS LAST, tp.user_id ASC
  LOOP
    v_rank := v_rank + 1;
    v_share_cents := floor(
      (v_row.chips::numeric * v_undistributed_cents::numeric) / v_total_chips
    )::bigint;
    IF v_share_cents <= 0 THEN
      RAISE EXCEPTION 'tournament % chip chop gives rank % a nonpositive share',
        p_tournament_id, v_rank USING ERRCODE = '23514';
    END IF;
    v_distributed_cents := v_distributed_cents + v_share_cents;
    v_shares := v_shares || jsonb_build_object(
      'place', v_rank,
      'user_id', v_row.user_id,
      'cents', v_share_cents);
    IF v_rank = 1 THEN v_leader := v_row.user_id; END IF;
  END LOOP;

  v_remainder_cents := v_undistributed_cents - v_distributed_cents;
  IF v_remainder_cents < 0 OR v_leader IS NULL THEN
    RAISE EXCEPTION 'tournament % produced an invalid deal residual of % cents',
      p_tournament_id, v_remainder_cents USING ERRCODE = '23514';
  END IF;

  -- Add the residual before the first write. Every recipient has one final
  -- amount and one obligation settlement.
  SELECT COALESCE(jsonb_agg(
           CASE WHEN e->>'user_id' = v_leader::text
                THEN jsonb_set(e, '{cents}',
                     to_jsonb((e->>'cents')::bigint + v_remainder_cents))
                ELSE e END
           ORDER BY (e->>'place')::integer
         ), '[]'::jsonb)
    INTO v_shares
    FROM jsonb_array_elements(v_shares) e;

  -- A stone-bubble debt, when one already exists, is part of the same complete
  -- transaction shape. It is pool-funded and user-keyed (position NULL).
  -- Complete historical evidence was proved above; only a genuinely absent
  -- row may be created here.
  IF v_has_bubble AND v_bubble_obligation_count = 0 THEN
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid,
       source, settled_at)
    VALUES
      (p_tournament_id, 'bubble_protection', NULL, v_bubble_user_id,
       v_bubble_amount, 0, v_bubble_obligation_source, NULL);
  END IF;

  -- Shape every positive fixed-place debt first. Existing evidence seeds
  -- amount_paid exactly; amount_owed becomes the canonical locked entitlement.
  -- No wallet can move until the bubble, this set and every deal share below
  -- all exist.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount,
           ((e->>'evidence_cents')::numeric / 100)::numeric(15,2)
             AS evidence
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    UPDATE public.tournament_obligations o
       SET amount_owed = v_row.amount,
           user_id = v_row.user_id,
           source = COALESCE(o.source, 'engine.fn_settle_tournament_places'),
           updated_at = v_now,
           settled_at = CASE WHEN v_row.evidence = v_row.amount
                             THEN COALESCE(o.settled_at, v_now)
                             ELSE NULL END
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND o.place = v_row.place;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      INSERT INTO public.tournament_obligations
        (tournament_id, kind, place, user_id, amount_owed, amount_paid,
         source, settled_at)
      VALUES
        (p_tournament_id, 'place', v_row.place, v_row.user_id, v_row.amount,
         v_row.evidence, 'engine.fn_settle_tournament_places',
         CASE WHEN v_row.evidence = v_row.amount THEN v_now ELSE NULL END);
    ELSIF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament %, place % matched % fixed obligations',
        p_tournament_id, v_row.place, v_rows USING ERRCODE = '23505';
    END IF;
  END LOOP;

  -- Shape every positive deal share. The full positive fixed-place plus
  -- deal-share debt set is durable in this transaction before the first payer.
  INSERT INTO public.tournament_obligations
    (tournament_id, kind, place, user_id, amount_owed, amount_paid, source)
  SELECT p_tournament_id,
         'final_table_deal',
         NULL,
         (e->>'user_id')::uuid,
         ((e->>'cents')::numeric / 100)::numeric(15,2),
         0,
         'final_table_deal'
    FROM jsonb_array_elements(v_shares) e
   ORDER BY (e->>'place')::integer;

  PERFORM 1
    FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind IN ('bubble_protection','place','final_table_deal')
   ORDER BY o.kind, o.place NULLS LAST, o.user_id, o.id
   FOR UPDATE;

  IF (v_has_bubble AND (
        (SELECT count(*) FROM public.tournament_obligations o
          WHERE o.tournament_id = p_tournament_id
            AND o.kind = 'bubble_protection') <> 1
        OR NOT EXISTS (
          SELECT 1 FROM public.tournament_obligations o
           WHERE o.tournament_id = p_tournament_id
             AND o.kind = 'bubble_protection'
             AND o.place IS NULL
             AND o.user_id = v_bubble_user_id
             AND o.amount_owed = v_bubble_amount
             AND o.amount_paid =
                 (v_bubble_paid_cents::numeric / 100)::numeric(15,2)
             AND o.source = v_bubble_obligation_source
             AND o.adjustment_id IS NULL
             AND ((v_bubble_paid_cents = v_bubble_entitlement_cents
                    AND o.settled_at IS NOT NULL)
               OR (v_bubble_paid_cents = 0 AND o.settled_at IS NULL))
        )
      ))
     OR (NOT v_has_bubble AND EXISTS (
       SELECT 1 FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'bubble_protection'
     ))
     OR (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'place') <> v_fixed_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'place'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_fixed) e
             WHERE (e->>'place')::integer = o.place
               AND (e->>'user_id')::uuid = o.user_id
               AND (e->>'amount')::numeric IS NOT DISTINCT FROM o.amount_owed
               AND ((e->>'evidence_cents')::numeric / 100)::numeric(15,2)
                   IS NOT DISTINCT FROM o.amount_paid
               AND ((o.amount_paid = o.amount_owed AND o.settled_at IS NOT NULL)
                 OR (o.amount_paid < o.amount_owed AND o.settled_at IS NULL))
          )
     )
     OR (SELECT count(*) FROM public.tournament_obligations o
       WHERE o.tournament_id = p_tournament_id
         AND o.kind = 'final_table_deal') <> v_live_count
     OR EXISTS (
       SELECT 1
         FROM public.tournament_obligations o
        WHERE o.tournament_id = p_tournament_id
          AND o.kind = 'final_table_deal'
          AND (
            o.place IS NOT NULL
            OR o.amount_paid <> 0
            OR o.source IS DISTINCT FROM 'final_table_deal'
            OR o.settled_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_shares) e
               WHERE (e->>'user_id')::uuid = o.user_id
                 AND ((e->>'cents')::numeric / 100)::numeric(15,2)
                     IS NOT DISTINCT FROM o.amount_owed
            )
          )
    ) THEN
    RAISE EXCEPTION
      'tournament % could not shape the complete bubble, fixed-place and deal debt set',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  -- The complete positive obligation set now exists and is locked. Settle an
  -- eligible pool-funded bubble first, then each fixed place, still inside the
  -- same transaction as the chop. Any later refusal rolls every earlier wallet
  -- credit, payout, obligation and standing back together.
  IF v_has_bubble THEN
    v_result := public.fn_ca_settle_tournament_bubble_raw(
      p_tournament_id, v_bubble_user_id, v_bubble_amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM v_bubble_amount
       OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM v_bubble_amount
       OR COALESCE((v_result->>'remaining')::numeric, v_bubble_amount) <> 0 THEN
      RAISE EXCEPTION 'tournament % bubble protection did not settle in full',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_result := public.fn_ca_settle_tournament_place_raw(
      p_tournament_id, v_row.place, v_row.user_id, v_row.amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE
       OR (v_result->>'amount_owed')::numeric IS DISTINCT FROM v_row.amount
       OR (v_result->>'amount_paid')::numeric IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'tournament %, fixed place % did not settle in full',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p."position" = v_row.place
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal';
    IF v_evidence_count < 1 OR v_evidence IS DISTINCT FROM v_row.amount THEN
      RAISE EXCEPTION 'tournament %, fixed place % lacks exact full evidence',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  v_distributed_cents := 0;
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'cents')::bigint AS cents
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer
  LOOP
    v_amount := (v_row.cents::numeric / 100)::numeric(15,2);
    IF v_amount <= 0 OR v_amount IS DISTINCT FROM round(v_amount, 2) THEN
      RAISE EXCEPTION 'tournament % derived invalid deal amount % for rank %',
        p_tournament_id, v_amount, v_row.place USING ERRCODE = '22003';
    END IF;

    v_result := public.fn_ca_settle_final_table_deal_share_raw(
      p_tournament_id, v_row.user_id, v_amount);
    IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_result->>'fully_settled')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'tournament % rank % returned an incomplete deal share',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'final_table_deal'
       AND o.place IS NULL
       AND o.user_id = v_row.user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p.source = 'final_table_deal'
       AND p."position" IS NULL;
    IF v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_amount
       OR v_ob.source IS DISTINCT FROM 'final_table_deal'
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_amount
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.user_id = v_row.user_id
            AND p.source = 'final_table_deal'
            AND p."position" IS NULL
            AND p.amount = v_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       )
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1 THEN
      RAISE EXCEPTION 'tournament % rank % did not write one exact payout row',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;

    v_distributed_cents := v_distributed_cents + v_row.cents;
    v_payouts := v_payouts || jsonb_build_object(
      'place', v_row.place,
      'user_id', v_row.user_id,
      'amount', v_amount);
    IF v_row.place = 1 THEN v_winner_amount := v_amount; END IF;
  END LOOP;

  IF v_distributed_cents <> v_undistributed_cents
     OR v_prior_paid_cents + v_fixed_shortfall_cents
        + v_bubble_shortfall_cents + v_distributed_cents <> v_pool_cents
     OR (SELECT COALESCE(sum(round(p.amount * 100)::bigint), 0)::bigint
           FROM public.tournament_payouts p
          WHERE p.tournament_id = p_tournament_id
            AND NOT (COALESCE(p.source, '') = ANY (v_not_pool)))
        <> v_pool_cents THEN
    RAISE EXCEPTION 'tournament % deal distributed % of % remaining cents',
      p_tournament_id, v_distributed_cents, v_undistributed_cents
      USING ERRCODE = '23514';
  END IF;

  -- The final standings and presentation cache commit with the money. Existing
  -- eliminated standings were proved above and are never rebuilt from clocks.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           ((e->>'cents')::numeric / 100)::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer DESC
  LOOP
    UPDATE public.tournament_players
       SET position = v_row.place,
           prize = v_row.amount,
           status = CASE WHEN v_row.place = 1
                         THEN 'winner'
                         ELSE 'eliminated' END,
           eliminated_at = CASE WHEN v_row.place = 1 THEN NULL ELSE v_now END
     WHERE tournament_id = p_tournament_id
       AND user_id = v_row.user_id
       AND status::text = 'playing'
       AND eliminated_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp one standing for rank %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  -- Prize is presentation cache, never payment evidence. Every eliminated
  -- tail row starts at zero; positive fixed places then receive their full
  -- locked structure entitlement, not merely the amount that happened to be
  -- paid before this transaction.
  UPDATE public.tournament_players tp
     SET prize = 0
   WHERE tp.tournament_id = p_tournament_id
     AND tp.position > v_live_count;
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    UPDATE public.tournament_players tp
       SET prize = v_row.amount
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_row.place
       AND tp.user_id = v_row.user_id
       AND tp.status::text = 'eliminated';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp fixed prize place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_has_bubble THEN
    UPDATE public.tournament_players tp
       SET prize = v_bubble_amount
     WHERE tp.tournament_id = p_tournament_id
       AND tp.position = v_bubble_place
       AND tp.user_id = v_bubble_user_id
       AND tp.status::text = 'eliminated'
       AND tp.eliminated_at IS NOT NULL
       AND tp.elimination_sequence IS NOT NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'tournament % could not stamp its stone-bubble prize cache',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  UPDATE public.tournaments
     SET status = 'COMPLETING', updated_at = v_now
   WHERE id = p_tournament_id AND upper(status::text) = 'RUNNING';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'tournament % lost its RUNNING deal claim',
      p_tournament_id USING ERRCODE = '40001';
  END IF;
  v_status := 'COMPLETING';

  -- Prove the exact durable state after every write. Any discrepancy aborts
  -- the statement and therefore every share credited above.
  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           ((e->>'cents')::numeric / 100)::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_shares) e
     ORDER BY (e->>'place')::integer
  LOOP
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'final_table_deal'
       AND o.place IS NULL
       AND o.user_id = v_row.user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'final_table_deal'
       AND p."position" IS NULL
       AND p.user_id = v_row.user_id;
    IF v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
       OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
       OR v_ob.source IS DISTINCT FROM 'final_table_deal'
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_row.amount
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_row.user_id
            AND tp.position = v_row.place
            AND tp.prize IS NOT DISTINCT FROM v_row.amount
            AND tp.status::text = CASE WHEN v_row.place = 1 THEN 'winner' ELSE 'eliminated' END
       ) THEN
      RAISE EXCEPTION 'tournament % failed post-deal proof at rank %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT (e->>'place')::integer AS place,
           (e->>'user_id')::uuid AS user_id,
           (e->>'amount')::numeric(15,2) AS amount
      FROM jsonb_array_elements(v_fixed) e
     ORDER BY (e->>'place')::integer
  LOOP
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'place'
       AND o.place = v_row.place;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.user_id = v_row.user_id
       AND p."position" = v_row.place
       AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
       AND p.source <> 'final_table_deal';
    IF v_ob.id IS NULL
       OR v_ob.user_id IS DISTINCT FROM v_row.user_id
       OR v_ob.amount_owed IS DISTINCT FROM v_row.amount
       OR v_ob.amount_paid IS DISTINCT FROM v_row.amount
       OR v_ob.settled_at IS NULL
       OR v_evidence_count < 1
       OR v_evidence IS DISTINCT FROM v_row.amount
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_row.user_id
            AND tp.position = v_row.place
            AND tp.prize IS NOT DISTINCT FROM v_row.amount
            AND tp.status::text = 'eliminated'
            AND tp.eliminated_at IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'tournament % failed fixed-place proof at place %',
        p_tournament_id, v_row.place USING ERRCODE = 'P0404';
    END IF;
  END LOOP;

  IF v_has_bubble THEN
    SELECT count(*) INTO v_bubble_obligation_count
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection';
    SELECT * INTO v_ob
      FROM public.tournament_obligations o
     WHERE o.tournament_id = p_tournament_id
       AND o.kind = 'bubble_protection'
       AND o.place IS NULL
       AND o.user_id = v_bubble_user_id;
    SELECT count(*), COALESCE(sum(p.amount), 0)
      INTO v_evidence_count, v_evidence
      FROM public.tournament_payouts p
     WHERE p.tournament_id = p_tournament_id
       AND p.source = 'bubble_protection';
    SELECT count(*) INTO v_rows
      FROM public.wallet_credit_idempotency k
     WHERE k.key =
       'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0';
    IF v_bubble_obligation_count <> 1
       OR v_ob.id IS NULL
       OR v_ob.amount_owed IS DISTINCT FROM v_bubble_amount
       OR v_ob.amount_paid IS DISTINCT FROM v_bubble_amount
       OR v_ob.source IS DISTINCT FROM v_bubble_obligation_source
       OR v_ob.adjustment_id IS NOT NULL
       OR v_ob.settled_at IS NULL
       OR v_evidence_count <> 1
       OR v_evidence IS DISTINCT FROM v_bubble_amount
       OR v_rows <> 1
       OR (SELECT count(*)
             FROM public.wallet_credit_idempotency k
            WHERE k.key LIKE
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':%')
          <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM public.tournament_payouts p
           JOIN public.wallet_credit_idempotency k
             ON k.key = p.idempotency_key
            AND k.user_id = p.user_id
            AND k.amount = p.amount
          WHERE p.tournament_id = p_tournament_id
            AND p.source = 'bubble_protection'
            AND p."position" IS NULL
            AND p.user_id = v_bubble_user_id
            AND p.amount = v_bubble_amount
            AND p.idempotency_key =
              'tourney:' || p_tournament_id::text || ':obl:' || v_ob.id::text || ':0'
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id
            AND tp.user_id = v_bubble_user_id
            AND tp.position = v_bubble_place
            AND tp.prize IS NOT DISTINCT FROM v_bubble_amount
            AND tp.status::text = 'eliminated'
            AND tp.eliminated_at IS NOT NULL
            AND tp.elimination_sequence IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'tournament % failed pool-funded bubble proof',
        p_tournament_id USING ERRCODE = 'P0404';
    END IF;
  END IF;

  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.position IS NOT NULL)
       <> v_field_size
     OR EXISTS (
       SELECT 1 FROM generate_series(1, v_field_size) g(place)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.tournament_players tp
          WHERE tp.tournament_id = p_tournament_id AND tp.position = g.place
        )
     )
     OR EXISTS (
       SELECT 1
         FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.status::text = 'eliminated'
          AND (tp.eliminated_at IS NULL OR tp.elimination_sequence IS NULL
            OR tp.elimination_sequence <= 0)
     )
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT tp.position,
                  (1 + row_number() OVER (
                    ORDER BY tp.elimination_sequence DESC NULLS LAST, tp.id ASC))::integer
                    AS expected_position
             FROM public.tournament_players tp
            WHERE tp.tournament_id = p_tournament_id
              AND tp.status::text = 'eliminated'
         ) ranked
        WHERE ranked.position IS DISTINCT FROM ranked.expected_position
     )
     OR EXISTS (
       SELECT 1 FROM public.tournament_players tp
        WHERE tp.tournament_id = p_tournament_id
          AND tp.prize IS DISTINCT FROM COALESCE((
            SELECT sum(p.amount)
              FROM public.tournament_payouts p
             WHERE p.tournament_id = p_tournament_id
               AND p.user_id = tp.user_id
               AND NOT (COALESCE(p.source, '') = ANY (v_not_pool))
          ), 0)
     ) THEN
    RAISE EXCEPTION 'tournament % did not finish with one standing per roster row',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'fully_settled', true,
    'status', v_status,
    'payouts', v_payouts,
    'winner_amount', v_winner_amount,
    'money_path', 'fn_settle_tournament_final_table_deal');
END;
$final_table_deal$;

REVOKE ALL ON FUNCTION public.fn_ca_settle_final_table_deal_share_raw(
  uuid,uuid,numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid)
  TO service_role;

COMMENT ON FUNCTION public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric) IS
  'Owner-only final-table-deal obligation payer. The atomic deal door derives its inputs and any partial result raises.';
COMMENT ON FUNCTION public.fn_settle_tournament_final_table_deal(uuid) IS
  'Service-only atomic exact-cent final-table deal. Locked roster, votes, table layout and payout evidence derive every share; all shares and standings commit together or not at all.';

-- Stage 1 deliberately leaves every legacy repair function, scheduled job,
-- heartbeat entry and fn_final_table_deal byte-for-byte unchanged. Only the
-- post-engine cleanup migration may remove those compatibility doors.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes) VALUES
  ('fn_credit_and_log', 'approved',
   'Atomic tournament cash settlement: owner-only wallet credit plus mandatory payout evidence. No application role can call it directly.'),
  ('fn_ca_tournament_place_amounts', 'approved',
   'Atomic tournament cash settlement: owner-only exact-cent cash ladder derivation. It moves no money.'),
  ('fn_ca_settle_tournament_place_raw', 'approved',
   'Atomic tournament cash settlement: owner-only derived-place obligation payer. Partial settlement raises.'),
  ('fn_ca_settle_tournament_bubble_raw', 'approved',
   'Atomic tournament cash settlement: owner-only pool-funded bubble obligation payer. Partial settlement raises.'),
  ('fn_ca_settle_final_table_deal_share_raw', 'approved',
   'Atomic tournament cash settlement: owner-only final-table deal share payer. Partial settlement raises.'),
  ('fn_settle_tournament_bubble_protection', 'approved',
   'Atomic tournament cash settlement: service-only immediate pool-funded bubble authority.'),
  ('fn_settle_tournament_places', 'approved',
   'Atomic tournament cash settlement: service-only all-or-nothing cash finish authority.'),
  ('fn_settle_tournament_final_table_deal', 'approved',
   'Atomic tournament cash settlement: service-only all-or-nothing final-table deal authority.')
ON CONFLICT (proname) DO UPDATE
   SET status = EXCLUDED.status,
       notes = EXCLUDED.notes;

DO $verify_cash_authorities$
DECLARE
  v_deal text;
  v_raw text;
  v_guarantee text;
  v_guarantee_core text;
  v_legacy_hash text;
BEGIN
  IF has_function_privilege('service_role',
       'public.fn_stamp_tournament_elimination_sequence()', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_tournament_place_amounts(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_settle_tournament_place_raw(uuid,integer,uuid,numeric)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_settle_tournament_bubble_raw(uuid,uuid,numeric)', 'EXECUTE')
     OR has_function_privilege('service_role',
       'public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'an owner-only cash primitive is executable by service_role';
  END IF;

  IF NOT has_function_privilege('service_role',
       'public.fn_settle_tournament_bubble_protection(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_settle_tournament_places(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.fn_settle_tournament_final_table_deal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a public atomic cash authority is not executable by service_role';
  END IF;

  IF has_function_privilege('anon',
       'public.fn_settle_tournament_bubble_protection(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_tournament_bubble_protection(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_settle_tournament_places(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_tournament_places(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.fn_settle_tournament_final_table_deal(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.fn_settle_tournament_final_table_deal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute a cash settlement authority';
  END IF;

  IF (SELECT count(*)
        FROM public.ca_money_rpc_registry r
       WHERE r.proname IN (
         'fn_credit_and_log','fn_ca_tournament_place_amounts',
         'fn_ca_settle_tournament_place_raw','fn_ca_settle_tournament_bubble_raw',
         'fn_ca_settle_final_table_deal_share_raw',
         'fn_settle_tournament_bubble_protection','fn_settle_tournament_places',
         'fn_settle_tournament_final_table_deal')
         AND r.status = 'approved') <> 8 THEN
    RAISE EXCEPTION 'cash settlement authority registry is incomplete';
  END IF;

  SELECT p.prosrc INTO v_deal
    FROM pg_proc p
   WHERE p.oid = 'public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure;
  SELECT p.prosrc INTO v_raw
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_settle_final_table_deal_share_raw(uuid,uuid,numeric)'::regprocedure;
  SELECT p.prosrc INTO v_guarantee
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure;
  SELECT p.prosrc INTO v_guarantee_core
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_ca_apply_prize_guarantee_core(uuid,text)'::regprocedure;
  IF v_guarantee IS NULL
     OR v_guarantee NOT LIKE '%overlay_journaled%'
     OR v_guarantee NOT LIKE '%fn_ca_apply_prize_guarantee_core%'
     OR v_guarantee NOT LIKE '%tourney:%guarantee_overlay%'
     OR v_guarantee NOT LIKE '%guarantee overlay is not one exact journaled escrow credit%'
     OR v_guarantee_core IS NULL
     OR v_guarantee_core NOT LIKE '%fn_apply_prize_guarantee_before_atomic_proof%'
     OR v_guarantee_core NOT LIKE '%guarantee bank did not debit the exact overlay%'
     OR v_guarantee_core NOT LIKE '%guarantee overlay journal key already exists unexpectedly%'
     OR v_guarantee_core NOT LIKE '%guarantee bank debit did not credit live escrow exactly%'
     OR v_guarantee_core NOT LIKE '%atomic_guarantee_funding_aborted%' THEN
    RAISE EXCEPTION
      'fn_apply_prize_guarantee lost its atomic escrow journal ordering';
  END IF;
  IF v_deal IS NULL
     OR v_deal NOT LIKE '%ORDER BY tp.id%FOR UPDATE%'
     OR v_deal NOT LIKE '%ORDER BY o.kind%FOR UPDATE%'
     OR v_deal NOT LIKE '%fn_ca_tournament_place_amounts%'
     OR v_deal NOT LIKE '%fn_ca_settle_tournament_place_raw%'
     OR v_deal NOT LIKE '%fn_ca_settle_tournament_bubble_raw%'
     OR v_deal NOT LIKE '%fn_ca_settle_final_table_deal_share_raw%'
     OR v_deal NOT LIKE '%tournament_deal_votes%'
     OR v_deal NOT LIKE '%table_seats%'
     OR v_deal NOT LIKE '%wallet_credit_idempotency%'
     OR v_deal NOT LIKE '%elimination_sequence DESC%'
     OR v_deal NOT LIKE '%fully_settled%'
     OR v_deal NOT LIKE '%COMPLETING%COMPLETED%'
     OR v_deal LIKE '%sum(prize)%'
     OR v_deal LIKE '%fn_credit_and_log(%'
     OR position('INSERT INTO public.tournament_obligations' IN v_deal) = 0
     OR position('v_result := public.fn_ca_settle_tournament_place_raw' IN v_deal)
          <= position('INSERT INTO public.tournament_obligations' IN v_deal)
     OR position('v_result := public.fn_ca_settle_final_table_deal_share_raw' IN v_deal)
          <= position('INSERT INTO public.tournament_obligations' IN v_deal) THEN
    RAISE EXCEPTION
      'fn_settle_tournament_final_table_deal lost a required atomicity invariant';
  END IF;

  IF v_raw IS NULL
     OR v_raw NOT LIKE '%fn_settle_tournament_obligation%'
     OR v_raw NOT LIKE '%final_table_deal%'
     OR v_raw NOT LIKE '%fully_settled%'
     OR v_raw LIKE '%fn_credit_and_log(%'
     OR v_raw LIKE '%INSERT INTO public.tournament_payouts%' THEN
    RAISE EXCEPTION
      'owner-only final-table-deal share payer lost its domain boundary';
  END IF;

  SELECT md5(pg_get_functiondef(
           'public.fn_final_table_deal(uuid)'::regprocedure))
    INTO v_legacy_hash;
  IF v_legacy_hash IS DISTINCT FROM
       current_setting('app.atomic_deal_legacy_hash', true) THEN
    RAISE EXCEPTION
      'legacy fn_final_table_deal changed during the DB-first cutover';
  END IF;
END;
$verify_cash_authorities$;

COMMIT;
