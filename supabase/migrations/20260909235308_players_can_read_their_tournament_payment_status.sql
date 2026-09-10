-- 20260909233449_players_can_read_their_tournament_payment_status.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
-- Results and player statements need the caller-owned amounts paid and owed.
-- This adds a read-only projection, not a new payment or ledger access path.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The ledger has about 79k rows and no user-first index. This supports the
-- player's own paged read without scanning other players' obligations.
CREATE INDEX ix_tournament_obligations_user_created
ON public.tournament_obligations (user_id, created_at DESC, id DESC)
WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_ca_my_tournament_payments(
  p_tournament_id uuid DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_rows jsonb;
  v_last jsonb;
  v_has_more boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'Payment page size must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'Both payment cursor fields are required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC, page.id DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT o.id, o.tournament_id, t.name AS tournament_name, t.club_id,
           o.kind, o.amount_owed, o.amount_paid, o.created_at, o.updated_at
    FROM public.tournament_obligations o
    JOIN public.tournaments t ON t.id = o.tournament_id
    WHERE o.user_id = v_user_id
      AND (p_tournament_id IS NULL OR o.tournament_id = p_tournament_id)
      AND (p_club_id IS NULL OR t.club_id = p_club_id)
      AND (p_before_created_at IS NULL
           OR (o.created_at, o.id) < (p_before_created_at, p_before_id))
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT p_limit + 1
  ) page;

  v_has_more := jsonb_array_length(v_rows) > p_limit;
  IF v_has_more THEN
    v_rows := v_rows - p_limit;
    v_last := v_rows -> (p_limit - 1);
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_user_id,
    'payments', v_rows,
    'has_more', v_has_more,
    'next_before_created_at', CASE WHEN v_has_more THEN v_last ->> 'created_at' END,
    'next_before_id', CASE WHEN v_has_more THEN v_last ->> 'id' END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_my_tournament_payments(uuid,uuid,timestamptz,uuid,integer)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_my_tournament_payments(uuid,uuid,timestamptz,uuid,integer)
TO authenticated;

COMMENT ON FUNCTION public.fn_ca_my_tournament_payments(uuid,uuid,timestamptz,uuid,integer)
IS 'Read-only, caller-owned tournament obligations. Event completion is not payment confirmation. No ledger table grants are exposed.';


COMMIT;
