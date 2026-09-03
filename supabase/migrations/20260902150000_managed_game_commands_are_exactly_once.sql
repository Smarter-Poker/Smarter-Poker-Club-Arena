-- Managed Game Commands Are Exactly Once
--
-- A browser retry, double tap, or dropped response must never apply an
-- operator command twice. Every update and close now carries a client UUID,
-- compares the contract version the operator actually reviewed, and produces
-- one durable receipt in the same transaction as the mutation.

BEGIN;

CREATE TABLE IF NOT EXISTS public.managed_game_command_receipts (
  command_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  game_kind text NOT NULL CHECK (game_kind IN ('table', 'tournament')),
  game_id uuid NOT NULL,
  command_action text NOT NULL CHECK (command_action IN ('update', 'close')),
  expected_version integer NOT NULL CHECK (expected_version > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'rejected')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  contract_version_before integer,
  contract_version_after integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (status = 'processing' AND completed_at IS NULL)
    OR (status IN ('succeeded', 'rejected') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_managed_game_command_receipts_game
  ON public.managed_game_command_receipts (game_kind, game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_game_command_receipts_actor
  ON public.managed_game_command_receipts (actor_id, created_at DESC);

ALTER TABLE public.managed_game_command_receipts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_guard_managed_game_command_receipt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Managed game command receipts cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'processing' THEN
    RAISE EXCEPTION 'Completed managed game command receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.command_id <> OLD.command_id
     OR NEW.actor_id <> OLD.actor_id
     OR NEW.game_kind <> OLD.game_kind
     OR NEW.game_id <> OLD.game_id
     OR NEW.command_action <> OLD.command_action
     OR NEW.expected_version <> OLD.expected_version
     OR NEW.request_hash <> OLD.request_hash
     OR NEW.contract_version_before IS DISTINCT FROM OLD.contract_version_before
     OR NEW.created_at <> OLD.created_at
     OR NEW.status = 'processing' THEN
    RAISE EXCEPTION 'Managed game command receipt identity cannot be changed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_managed_game_command_receipt_immutable
  ON public.managed_game_command_receipts;
CREATE TRIGGER trg_managed_game_command_receipt_immutable
BEFORE UPDATE OR DELETE ON public.managed_game_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_managed_game_command_receipt();

CREATE OR REPLACE FUNCTION public.fn_managed_game_command_hash(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'command_id', p_command_id,
          'kind', p_kind,
          'game_id', p_game_id,
          'action', p_action,
          'expected_version', p_expected_version,
          'payload', COALESCE(p_payload, '{}'::jsonb)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$function$;

CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_request_hash text;
  v_existing public.managed_game_command_receipts%ROWTYPE;
  v_before integer;
  v_after integer;
  v_action_result jsonb;
  v_result jsonb;
  v_status text;
  v_reason text;
  v_message text;
  v_sqlstate text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_command_id IS NULL
     OR p_kind NOT IN ('table', 'tournament')
     OR p_action NOT IN ('update', 'close')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR jsonb_typeof(COALESCE(p_payload, '{}'::jsonb)) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  v_request_hash := public.fn_managed_game_command_hash(
    p_command_id, p_kind, p_game_id, p_action, p_expected_version, p_payload
  );

  -- Fast replay path. A command UUID belongs to one actor and exactly one
  -- request fingerprint. Reusing it for different work is never accepted.
  SELECT * INTO v_existing
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.actor_id <> v_uid OR v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;

  -- Serialize all operator commands for a game on its canonical row. This
  -- also makes a concurrent duplicate wait until the first receipt commits.
  IF p_kind = 'table' THEN
    SELECT club_id INTO v_club
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    SELECT club_id INTO v_club
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- The first request may have committed while this transaction waited for
  -- the game lock. Re-read before attempting the unique insert.
  SELECT * INTO v_existing
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.actor_id <> v_uid OR v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT version INTO v_before
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'contract_not_found');
  END IF;

  INSERT INTO public.managed_game_command_receipts (
    command_id, actor_id, game_kind, game_id, command_action,
    expected_version, request_hash, status, contract_version_before
  ) VALUES (
    p_command_id, v_uid, p_kind, p_game_id, p_action,
    p_expected_version, v_request_hash, 'processing', v_before
  );

  IF p_expected_version <> v_before THEN
    v_result := jsonb_build_object(
      'ok', false,
      'reason', 'stale_contract_version',
      'command_id', p_command_id,
      'command_status', 'rejected',
      'expected_version', p_expected_version,
      'current_version', v_before,
      'version_before', v_before,
      'version_after', v_before,
      'replayed', false
    );
    UPDATE public.managed_game_command_receipts
       SET status = 'rejected', result = v_result,
           contract_version_after = v_before, completed_at = now()
     WHERE command_id = p_command_id;
    RETURN v_result;
  END IF;

  BEGIN
    IF p_action = 'update' THEN
      v_action_result := public.fn_update_managed_game(p_kind, p_game_id, p_payload);
    ELSE
      v_action_result := public.fn_close_managed_game(p_kind, p_game_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_reason := CASE
      WHEN v_sqlstate IN ('22P02', '22003', '23514') THEN 'invalid_payload'
      WHEN v_sqlstate = '42501' THEN 'not_authorized'
      WHEN v_sqlstate = '55000' THEN 'contract_rule_blocked'
      ELSE 'command_failed'
    END;
    v_action_result := jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'message', CASE
        WHEN v_sqlstate = '55000' THEN v_message
        ELSE NULL
      END
    );
  END;

  SELECT version INTO v_after
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;
  v_after := COALESCE(v_after, v_before);
  v_status := CASE WHEN COALESCE((v_action_result ->> 'ok')::boolean, false)
    THEN 'succeeded' ELSE 'rejected' END;

  v_result := COALESCE(v_action_result, jsonb_build_object(
    'ok', false, 'reason', 'command_failed'
  )) || jsonb_build_object(
    'command_id', p_command_id,
    'command_status', v_status,
    'expected_version', p_expected_version,
    'current_version', v_after,
    'version_before', v_before,
    'version_after', v_after,
    'replayed', false
  );

  UPDATE public.managed_game_command_receipts
     SET status = v_status, result = v_result,
         contract_version_after = v_after, completed_at = now()
   WHERE command_id = p_command_id;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_managed_game_command_receipt(p_command_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.managed_game_command_receipts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO v_row
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id AND actor_id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'found', false);
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'found', true,
    'receipt', v_row.result || jsonb_build_object(
      'command_id', v_row.command_id,
      'command_status', v_row.status,
      'created_at', v_row.created_at,
      'completed_at', v_row.completed_at
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_managed_game_command_receipts(
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
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_kind NOT IN ('table', 'tournament') OR cardinality(p_game_ids) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT DISTINCT ON (r.game_id)
             r.game_id, r.command_id, r.command_action, r.status,
             r.contract_version_before, r.contract_version_after,
             CASE
               WHEN r.status = 'processing' THEN 'processing'
               WHEN av.version IS NULL THEN 'version_drift'
               ELSE 'confirmed'
             END AS reconciliation_state,
             r.created_at, r.completed_at
        FROM public.managed_game_command_receipts r
        JOIN public.managed_game_contract_versions v
          ON v.game_kind = r.game_kind
         AND v.game_id = r.game_id
         AND v.version = r.contract_version_before
        LEFT JOIN public.managed_game_contract_versions av
          ON av.game_kind = r.game_kind
         AND av.game_id = r.game_id
         AND av.version = r.contract_version_after
       WHERE r.game_kind = p_kind
         AND r.game_id = ANY(COALESCE(p_game_ids, '{}'::uuid[]))
         AND public.fn_can_create_games(v.club_id, v_uid)
       ORDER BY r.game_id, r.created_at DESC
    ) x;

  RETURN jsonb_build_object('ok', true, 'receipts', v_rows);
END;
$function$;

-- Authenticated browsers now have one command door. The Phase 1 functions
-- remain private implementation details so old call sites cannot bypass the
-- receipt, version, or idempotency laws.
REVOKE ALL ON TABLE public.managed_game_command_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_managed_game_command_hash(uuid, text, uuid, text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_guard_managed_game_command_receipt()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_execute_managed_game_command(uuid, text, uuid, text, integer, jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_get_managed_game_command_receipt(uuid)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_get_managed_game_command_receipts(text, uuid[])
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command(uuid, text, uuid, text, integer, jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_managed_game_command_receipt(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_managed_game_command_receipts(text, uuid[])
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_managed_game_command_receipt()
  TO service_role;

COMMENT ON TABLE public.managed_game_command_receipts IS
  'One immutable operator receipt per client command UUID. The receipt and its table or tournament mutation commit atomically.';

COMMIT;
