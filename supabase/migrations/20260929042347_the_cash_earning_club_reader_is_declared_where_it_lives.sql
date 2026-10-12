-- ════════════════════════════════════════════════════════════════════════════
--  THE CASH EARNING CLUB READER IS DECLARED WHERE IT LIVES (2026-09-29)
-- ════════════════════════════════════════════════════════════════════════════
--
-- `public.fn_cash_earning_club` has existed in production for some time and is
-- declared by NO migration in this repository. One migration mentions it;
-- none creates it. `atomic_distribute_rake` calls it, so the chip-journal
-- atomicity probe - which rebuilds the authoritative function closure from the
-- repo's own migrations and runs it on a disposable cluster - cannot resolve
-- the closure and refuses:
--
--     RuntimeError: Unresolved public function dependency:
--     public.fn_cash_earning_club required by public.atomic_distribute_rake
--
-- The probe is right and the repository was wrong. A money function the rake
-- distribution depends on must be readable in the repo that claims to describe
-- the schema, or the probe guards a closure that is not the one production
-- runs.
--
-- This declares it EXACTLY as production already holds it: the body below is
-- byte-identical to `pg_get_functiondef` at 2026-09-29 04:23Z (prosrc md5
-- 6e5974d930fb873b4a6a3819abed4243, 2293 bytes), and the grants below restate
-- the ACL it already carries (postgres=X, service_role=X). Applying this
-- changes nothing in production; it closes the drift.

CREATE OR REPLACE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_player_id uuid, p_source_club uuid, p_union_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE started timestamptz;clubs uuid[];
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_hand_id IS NULL OR p_table_id IS NULL OR p_player_id IS NULL OR p_source_club IS NULL THEN
  RAISE EXCEPTION 'cash_earning_identity_missing' USING ERRCODE='23514'; END IF;
 SELECT h.started_at INTO started FROM public.hand_history h WHERE h.id=p_hand_id AND h.table_id=p_table_id;
 IF p_union_id IS NULL THEN
  -- Private games may admit a seat funded by another club. Preserve the
  -- actual club at the hand's start; the host only identifies the bank route.
  -- This reader runs before banking an already accepted hand. Unknown seat
  -- evidence must therefore stay NULL, not abort its bank obligation or invent
  -- host ownership. The existing source worker durably refuses that NULL or
  -- an unsupported cross-club liability after the exact bank receipt exists.
  IF started IS NULL OR NOT isfinite(started) OR started>transaction_timestamp() THEN RETURN NULL; END IF;
  SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_player_id
    AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
  -- An overlapping unknown-club seat also makes the evidence ambiguous.
  IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1] AND c.is_union IS NOT TRUE)
  THEN RETURN NULL; END IF;
  RETURN clubs[1];
 END IF;
 -- Preserve the existing shared-union validation and failure contract.
 IF started IS NULL OR started>transaction_timestamp() THEN RAISE EXCEPTION 'cash_hand_start_not_recorded' USING ERRCODE='23514'; END IF;
 SELECT array_agg(DISTINCT s.club_id) INTO clubs FROM public.table_seats s
  WHERE s.table_id=p_table_id AND s.user_id=p_player_id AND s.club_id IS NOT NULL
   AND s.joined_at<=started AND (s.left_at IS NULL OR s.left_at>started);
 IF cardinality(clubs) IS DISTINCT FROM 1
  OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=clubs[1]
   AND (c.is_union IS NOT TRUE OR c.id=p_union_id OR c.union_id=p_union_id))
 THEN RAISE EXCEPTION 'cash_earning_seat_provenance_missing_or_ambiguous' USING ERRCODE='23514'; END IF;
 RETURN clubs[1];
END $function$;

-- The ACL it already carries, restated so the grant is declared beside the
-- definition rather than inherited from an unrecorded change. No browser role
-- may execute it: it is engine-only and its own first line enforces that.
REVOKE ALL ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid)
  TO service_role;
