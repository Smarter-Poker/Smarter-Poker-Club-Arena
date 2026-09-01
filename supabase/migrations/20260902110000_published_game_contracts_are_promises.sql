-- Published Game Contracts Are Promises
--
-- Every game that reaches a lobby now has an immutable, hashed contract
-- revision. Operator edits create a new revision; they never rewrite history.
-- Tournament contract fields lock at the first registration, including horse
-- and system registrations. Guarantee readiness is calculated from the bank
-- that actually funds the overlay and is enforced again at start time.

BEGIN;

CREATE TABLE IF NOT EXISTS public.managed_game_contract_versions (
  id bigserial PRIMARY KEY,
  game_kind text NOT NULL CHECK (game_kind IN ('table', 'tournament')),
  game_id uuid NOT NULL,
  club_id uuid NOT NULL,
  union_id uuid,
  version integer NOT NULL CHECK (version > 0),
  contract jsonb NOT NULL,
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  change_reason text NOT NULL DEFAULT 'published',
  UNIQUE (game_kind, game_id, version),
  UNIQUE (game_kind, game_id, contract_hash)
);

CREATE INDEX IF NOT EXISTS idx_managed_game_contract_versions_game
  ON public.managed_game_contract_versions (game_kind, game_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_managed_game_contract_versions_scope
  ON public.managed_game_contract_versions (club_id, union_id, published_at DESC);

ALTER TABLE public.managed_game_contract_versions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_document(
  p_kind text,
  p_row jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE p_kind
    WHEN 'table' THEN p_row - ARRAY[
      'current_players', 'status', 'created_at', 'updated_at', 'deleted_at',
      'deleted_by', 'is_deleted', 'current_hand_id', 'hand_number',
      'last_activity_at', 'tournament_id', 'engine_instance_id',
      'first_button_seat', 'bomb_pot_manual_pending', 'bomb_pot_sched_state',
      'bomb_pot_next_due_at', 'engine_lease_owner', 'engine_lease_expires_at'
    ]::text[]
    WHEN 'tournament' THEN jsonb_strip_nulls(
      jsonb_build_object(
        'id', p_row -> 'id', 'club_id', p_row -> 'club_id',
        'union_id', p_row -> 'union_id', 'name', p_row -> 'name',
        'game_type', p_row -> 'game_type', 'variant', p_row -> 'variant',
        'tournament_type', p_row -> 'tournament_type',
        'buy_in_amount', p_row -> 'buy_in_amount', 'buy_in_fee', p_row -> 'buy_in_fee',
        'starting_chips', p_row -> 'starting_chips', 'max_players', p_row -> 'max_players',
        'min_players', p_row -> 'min_players', 'blind_structure', p_row -> 'blind_structure',
        'payout_structure', p_row -> 'payout_structure',
        'guaranteed_prize', p_row -> 'guaranteed_prize',
        'late_reg_levels', p_row -> 'late_reg_levels', 'late_reg_mins', p_row -> 'late_reg_mins',
        'rebuy_levels', p_row -> 'rebuy_levels', 'start_time', p_row -> 'start_time',
        'is_rebuy', p_row -> 'is_rebuy', 'is_reentry', p_row -> 'is_reentry',
        'rebuy_cost', p_row -> 'rebuy_cost', 'rebuy_chips', p_row -> 'rebuy_chips'
      ) || jsonb_build_object(
        'add_on_available', p_row -> 'add_on_available', 'addon_cost', p_row -> 'addon_cost',
        'addon_chips', p_row -> 'addon_chips', 'addon_levels', p_row -> 'addon_levels',
        'is_bounty', p_row -> 'is_bounty', 'bounty_amount', p_row -> 'bounty_amount',
        'is_pko', p_row -> 'is_pko', 'is_mystery_bounty', p_row -> 'is_mystery_bounty',
        'spin_type', p_row -> 'spin_type', 'satellite_target_id', p_row -> 'satellite_target_id',
        'satellite_seats', p_row -> 'satellite_seats', 'is_xmtt', p_row -> 'is_xmtt',
        'is_private', p_row -> 'is_private', 'short_description', p_row -> 'short_description',
        'is_vip_only', p_row -> 'is_vip_only', 'ban_chat', p_row -> 'ban_chat',
        'all_in_or_fold', p_row -> 'all_in_or_fold', 'label_as_new', p_row -> 'label_as_new',
        'hide_club_name', p_row -> 'hide_club_name',
        'action_time_seconds', p_row -> 'action_time_seconds', 'table_size', p_row -> 'table_size',
        'accelerated_mtt', p_row -> 'accelerated_mtt',
        'addon_break_minutes', p_row -> 'addon_break_minutes'
      ) || jsonb_build_object(
        'big_blind_ante', p_row -> 'big_blind_ante',
        'authorized_to_register', p_row -> 'authorized_to_register',
        'early_bird_enabled', p_row -> 'early_bird_enabled',
        'early_bird_chips', p_row -> 'early_bird_chips',
        'bubble_protection', p_row -> 'bubble_protection',
        'final_table_deal_enabled', p_row -> 'final_table_deal_enabled',
        'restart_every_minutes', p_row -> 'restart_every_minutes',
        'synchronized_breaks', p_row -> 'synchronized_breaks',
        'max_rebuys', p_row -> 'max_rebuys', 'max_reentries', p_row -> 'max_reentries',
        'is_multi_day', p_row -> 'is_multi_day', 'total_days', p_row -> 'total_days',
        'mystery_bounty_min', p_row -> 'mystery_bounty_min',
        'mystery_bounty_max', p_row -> 'mystery_bounty_max',
        'is_pinned', p_row -> 'is_pinned', 'schedule_id', p_row -> 'schedule_id'
      )
    )
    ELSE '{}'::jsonb
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_managed_game_contract_hash(p_contract jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT encode(extensions.digest(convert_to(p_contract::text, 'UTF8'), 'sha256'), 'hex')
$function$;

CREATE OR REPLACE FUNCTION public.fn_capture_managed_game_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_kind text := CASE TG_TABLE_NAME WHEN 'tables' THEN 'table' ELSE 'tournament' END;
  v_contract jsonb;
  v_hash text;
  v_last_hash text;
  v_version integer;
BEGIN
  IF v_kind = 'table' AND to_jsonb(NEW) -> 'tournament_id' <> 'null'::jsonb THEN
    RETURN NEW;
  END IF;

  v_contract := public.fn_managed_game_contract_document(v_kind, to_jsonb(NEW));
  v_hash := public.fn_managed_game_contract_hash(v_contract);

  SELECT contract_hash, version
    INTO v_last_hash, v_version
    FROM public.managed_game_contract_versions
   WHERE game_kind = v_kind AND game_id = NEW.id
   ORDER BY version DESC
   LIMIT 1;

  IF v_last_hash IS NOT DISTINCT FROM v_hash THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.managed_game_contract_versions (
    game_kind, game_id, club_id, union_id, version, contract,
    contract_hash, published_by, change_reason
  ) VALUES (
    v_kind, NEW.id, NEW.club_id, NEW.union_id, COALESCE(v_version, 0) + 1,
    v_contract, v_hash, auth.uid(),
    CASE
      WHEN TG_OP = 'INSERT' THEN 'created'
      WHEN auth.uid() IS NULL THEN 'system_revision'
      ELSE 'operator_revision'
    END
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_registered_tournament_contract()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  v_old := public.fn_managed_game_contract_document('tournament', to_jsonb(OLD));
  v_new := public.fn_managed_game_contract_document('tournament', to_jsonb(NEW));

  -- auth.uid() is present for an operator/browser request and null for the
  -- service-role tournament engine. The engine may execute deterministic
  -- lifecycle adaptations such as fitting a payout ladder to the final field;
  -- those changes are captured as a new system revision below. Operators can
  -- never use that exception because their JWT keeps auth.uid() populated.
  IF auth.uid() IS NOT NULL AND v_old IS DISTINCT FROM v_new AND EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Tournament contract cannot be modified after a player has registered'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_t record;
  v_union uuid;
  v_enforce boolean;
  v_floor numeric;
  v_bank numeric;
  v_bank_type text;
  v_exposure numeric;
  v_required numeric;
  v_short numeric;
  v_locked boolean;
  v_complete boolean;
BEGIN
  SELECT t.id, t.club_id, t.name, t.status, t.start_time,
         t.tournament_type, t.variant,
         t.buy_in_amount, t.starting_chips, t.max_players,
         t.blind_structure, t.payout_structure,
         COALESCE(t.guaranteed_prize, 0) AS guaranteed_prize,
         COALESCE(t.prize_pool, 0) AS prize_pool
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  SELECT c.union_id, COALESCE(c.guarantee_enforcement_enabled, true),
         COALESCE(c.guarantee_treasury_floor, 0)
    INTO v_union, v_enforce, v_floor
    FROM public.clubs c
   WHERE c.id = v_t.club_id;

  IF v_union IS NOT NULL THEN
    v_bank_type := 'union';
    v_floor := 0;
    SELECT COALESCE(uw.chip_balance, 0)
      INTO v_bank
      FROM public.union_wallets uw
     WHERE uw.union_id = v_union;
    v_bank := COALESCE(v_bank, 0);
    SELECT COALESCE(sum(greatest(COALESCE(t.guaranteed_prize, 0) - COALESCE(t.prize_pool, 0), 0)), 0)
      INTO v_exposure
      FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE c.union_id = v_union
       AND t.id <> p_tournament_id
       AND COALESCE(t.prize_pool_finalized, false) = false
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  ELSE
    v_bank_type := 'club';
    SELECT COALESCE(c.chip_treasury, 0)
      INTO v_bank
      FROM public.clubs c
     WHERE c.id = v_t.club_id;
    v_bank := COALESCE(v_bank, 0);
    SELECT COALESCE(sum(greatest(COALESCE(t.guaranteed_prize, 0) - COALESCE(t.prize_pool, 0), 0)), 0)
      INTO v_exposure
      FROM public.tournaments t
     WHERE t.club_id = v_t.club_id
       AND t.id <> p_tournament_id
       AND COALESCE(t.prize_pool_finalized, false) = false
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  END IF;

  v_required := greatest(v_t.guaranteed_prize - v_t.prize_pool, 0);
  v_short := greatest(COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank, 0);
  v_locked := EXISTS (
    SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = p_tournament_id
  );
  v_complete := NULLIF(trim(COALESCE(v_t.name, '')), '') IS NOT NULL
    AND (
      v_t.start_time IS NOT NULL
      OR upper(COALESCE(v_t.tournament_type, '')) IN ('SNG', 'SPIN')
      OR lower(COALESCE(v_t.variant, '')) IN ('sng', 'spin')
    )
    AND COALESCE(v_t.starting_chips, 0) > 0
    AND COALESCE(v_t.max_players, 0) >= 2
    AND COALESCE(v_t.buy_in_amount, 0) >= 0
    AND jsonb_array_length(COALESCE(v_t.blind_structure, '[]'::jsonb)) > 0
    AND (
      jsonb_array_length(COALESCE(v_t.payout_structure, '[]'::jsonb)) > 0
      OR upper(COALESCE(v_t.tournament_type, '')) = 'SPIN'
      OR lower(COALESCE(v_t.variant, '')) = 'spin'
    );

  RETURN jsonb_build_object(
    'state', CASE
      WHEN upper(v_t.status::text) IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN 'closed'
      WHEN NOT v_complete THEN 'incomplete'
      WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'
      ELSE 'ready'
    END,
    'can_start', upper(v_t.status::text) NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
      AND v_complete AND (NOT v_enforce OR v_short = 0),
    'contract_locked', v_locked,
    'guarantee_enforced', v_enforce,
    'guaranteed_prize', v_t.guaranteed_prize,
    'current_prize_pool', v_t.prize_pool,
    'overlay_required', v_required,
    'bank_type', v_bank_type,
    'bank_balance', v_bank,
    'bank_floor', COALESCE(v_floor, 0),
    'other_live_exposure', COALESCE(v_exposure, 0),
    'short_by', v_short
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_start_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_readiness jsonb;
BEGIN
  IF upper(NEW.status::text) = 'RUNNING'
     AND upper(COALESCE(OLD.status::text, '')) <> 'RUNNING' THEN
    v_readiness := public.fn_tournament_management_readiness(NEW.id);
    IF NOT COALESCE((v_readiness ->> 'can_start')::boolean, false) THEN
      IF v_readiness ->> 'state' = 'funding_blocked' THEN
        RAISE EXCEPTION 'Tournament cannot start because its guarantee is short by % chips',
          v_readiness ->> 'short_by' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'Tournament cannot start because its published contract is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_publish_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_readiness jsonb := public.fn_tournament_management_readiness(NEW.id);
BEGIN
  IF v_readiness ->> 'state' = 'funding_blocked' THEN
    RAISE EXCEPTION 'Tournament cannot be published because its guarantee is short by % chips',
      v_readiness ->> 'short_by' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

-- Establish version 1 for games that were already published before this law.
INSERT INTO public.managed_game_contract_versions (
  game_kind, game_id, club_id, union_id, version, contract,
  contract_hash, change_reason
)
SELECT 'table', t.id, t.club_id, t.union_id, 1, d.contract,
       public.fn_managed_game_contract_hash(d.contract), 'baseline'
  FROM public.tables t
 CROSS JOIN LATERAL (
   SELECT public.fn_managed_game_contract_document('table', to_jsonb(t)) AS contract
 ) d
 WHERE t.tournament_id IS NULL
ON CONFLICT (game_kind, game_id, version) DO NOTHING;

INSERT INTO public.managed_game_contract_versions (
  game_kind, game_id, club_id, union_id, version, contract,
  contract_hash, change_reason
)
SELECT 'tournament', t.id, t.club_id, t.union_id, 1, d.contract,
       public.fn_managed_game_contract_hash(d.contract), 'baseline'
  FROM public.tournaments t
 CROSS JOIN LATERAL (
   SELECT public.fn_managed_game_contract_document('tournament', to_jsonb(t)) AS contract
 ) d
ON CONFLICT (game_kind, game_id, version) DO NOTHING;

DROP TRIGGER IF EXISTS trg_tables_capture_management_contract ON public.tables;
CREATE TRIGGER trg_tables_capture_management_contract
AFTER INSERT OR UPDATE ON public.tables
FOR EACH ROW EXECUTE FUNCTION public.fn_capture_managed_game_contract();

DROP TRIGGER IF EXISTS trg_tournaments_registered_contract_lock ON public.tournaments;
CREATE TRIGGER trg_tournaments_registered_contract_lock
BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_registered_tournament_contract();

DROP TRIGGER IF EXISTS trg_tournaments_start_readiness ON public.tournaments;
CREATE TRIGGER trg_tournaments_start_readiness
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_start_readiness();

DROP TRIGGER IF EXISTS trg_tournaments_publish_readiness ON public.tournaments;
CREATE TRIGGER trg_tournaments_publish_readiness
AFTER INSERT OR UPDATE OF guaranteed_prize, club_id, union_id ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_publish_readiness();

DROP TRIGGER IF EXISTS trg_tournaments_capture_management_contract ON public.tournaments;
CREATE TRIGGER trg_tournaments_capture_management_contract
AFTER INSERT OR UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_capture_managed_game_contract();

CREATE OR REPLACE FUNCTION public.fn_get_managed_game_contracts(
  p_kind text,
  p_game_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_club uuid;
  v_version record;
  v_locked boolean;
  v_readiness jsonb;
  v_result jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_kind NOT IN ('table', 'tournament') OR cardinality(p_game_ids) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_game_ids, '{}'::uuid[]) LOOP
    v_club := NULL;
    IF p_kind = 'table' THEN
      SELECT club_id INTO v_club FROM public.tables WHERE id = v_id;
      v_locked := EXISTS (
        SELECT 1 FROM public.table_seats ts WHERE ts.table_id = v_id AND ts.left_at IS NULL
      );
      v_readiness := jsonb_build_object(
        'state', 'ready', 'can_start', true, 'contract_locked', v_locked
      );
    ELSE
      SELECT club_id INTO v_club FROM public.tournaments WHERE id = v_id;
      v_readiness := public.fn_tournament_management_readiness(v_id);
      v_locked := COALESCE((v_readiness ->> 'contract_locked')::boolean, false);
    END IF;

    IF v_club IS NULL OR NOT public.fn_can_create_games(v_club, v_uid) THEN
      CONTINUE;
    END IF;

    SELECT version, contract_hash, published_at, published_by, change_reason
      INTO v_version
      FROM public.managed_game_contract_versions
     WHERE game_kind = p_kind AND game_id = v_id
     ORDER BY version DESC
     LIMIT 1;

    IF FOUND THEN
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'game_id', v_id,
        'version', v_version.version,
        'contract_hash', v_version.contract_hash,
        'published_at', v_version.published_at,
        'published_by', v_version.published_by,
        'change_reason', v_version.change_reason,
        'contract_locked', v_locked,
        'readiness', v_readiness
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'contracts', v_result);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_managed_game_contract_history(
  p_kind text,
  p_game_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_rows jsonb;
BEGIN
  IF p_kind = 'table' THEN
    SELECT club_id INTO v_club FROM public.tables WHERE id = p_game_id;
  ELSIF p_kind = 'tournament' THEN
    SELECT club_id INTO v_club FROM public.tournaments WHERE id = p_game_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
  END IF;

  IF v_uid IS NULL OR v_club IS NULL OR NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.version DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT version, contract_hash, contract, published_at, published_by, change_reason
        FROM public.managed_game_contract_versions
       WHERE game_kind = p_kind AND game_id = p_game_id
       ORDER BY version DESC
       LIMIT 50
    ) v;

  RETURN jsonb_build_object('ok', true, 'versions', v_rows);
END;
$function$;

REVOKE ALL ON TABLE public.managed_game_contract_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.managed_game_contract_versions_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_managed_game_contract_document(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_managed_game_contract_hash(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_capture_managed_game_contract() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_registered_tournament_contract() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_start_readiness() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_tournament_publish_readiness() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_get_managed_game_contracts(text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_get_managed_game_contract_history(text, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_get_managed_game_contracts(text, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_managed_game_contract_history(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_capture_managed_game_contract() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_registered_tournament_contract() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_start_readiness() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_publish_readiness() TO service_role;

COMMENT ON TABLE public.managed_game_contract_versions IS
  'Append-only, hashed snapshots of every advertised cash-table and tournament contract. Operator changes publish a new version; old promises are never rewritten.';

COMMIT;
