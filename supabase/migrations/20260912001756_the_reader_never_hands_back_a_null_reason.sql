-- ═══════════════════════════════════════════════════════════════════════════
--  THE READER NEVER HANDS BACK A NULL REASON
--  BBJ programme, post-audit phase 3 of 5, corrective pass (2026-09-12)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Found by the phase 3 deep dive, in a rolled-back transaction that inserted
--  one synthetic row per classifier branch - including a branch that had never
--  existed in production.
--
--  `bbj_near_misses.reason` IS NULLABLE. The creating migration declared it
--  `reason text` with no NOT NULL, and its own comment says a near miss with
--  no reason is "a detector that answered without knowing". The engine's
--  writer defends that with `params.reason ?? 'unspecified'` - but that is ONE
--  writer's discipline, not a constraint, and the reader has to be correct for
--  whatever is in the column rather than for what the current writer happens
--  to put there.
--
--  MEASURED: a row with `reason = NULL` comes back from
--  `fn_bbj_near_miss_summary` as `kind = 'main', reason = NULL`, because
--  `NULL LIKE 'mini\_%'` is NULL and the CASE falls through to ELSE. The panel
--  then calls `reason.startsWith('mini_refused:')` on it, which throws during
--  render. ONE malformed row would blank the entire Jackpot Health panel - the
--  balances, the funding rate, the mini headroom, all of it - on a screen whose
--  whole purpose is to be readable when something is wrong.
--
--  So the reader COALESCEs to 'unspecified', which is the same word the writer
--  already uses for a missing reason and which the panel already labels
--  "Reason Not Recorded". One vocabulary, and a null becomes a visible fact
--  rather than a crash. The panel is given the same guard independently,
--  because a UI that throws on data it did not expect is its own defect.
--
--  WHY NOT `SET NOT NULL` ON THE COLUMN. It is the tempting fix and it is the
--  wrong one here. The near-miss writer is fire-and-forget by construction -
--  "a jackpot must not be lost because its paperwork was" - so a constraint
--  that can reject its INSERT converts a silent, harmless null into a failed
--  write on the settlement path. The column stays permissive; the READER is
--  what must never pass a null on to something that cannot take one.
--
--  Nothing else about the function changes: same signature, same authorisation,
--  same scoping, same ordering.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_near_miss_summary(
  p_pool_id uuid,
  p_days    integer DEFAULT 30
)
RETURNS TABLE(
  kind        text,
  reason      text,
  refusals    bigint,
  last_at     timestamptz,
  biggest_pot numeric,
  example     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_club_id  uuid;
  v_union_id uuid;
  v_allowed  boolean := false;
  v_days     integer;
BEGIN
  /* The caller is named HERE, at this function's own surface, rather than one
     call down inside fn_is_club_admin_uid where check-definer-authorization
     cannot see it. */
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized: the near-miss log is operator telemetry';
  END IF;

  v_days := LEAST(365, GREATEST(1, COALESCE(p_days, 30)));

  SELECT bp.club_id, bp.union_id INTO v_club_id, v_union_id
    FROM public.bbj_pools bp WHERE bp.id = p_pool_id;

  IF v_club_id IS NULL AND v_union_id IS NULL THEN
    RAISE EXCEPTION 'BBJ pool not found';
  END IF;

  IF public.fn_is_platform_admin() THEN
    v_allowed := true;
  ELSIF v_club_id IS NOT NULL THEN
    v_allowed := public.fn_is_club_admin_uid(v_club_id);
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.union_id = v_union_id
         AND public.fn_is_club_admin_uid(c.id)
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Not authorized: club admin role required for this jackpot pool';
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT nm.*
      FROM public.bbj_near_misses nm
     WHERE nm.at > now() - make_interval(days => v_days)
       AND (
             (v_club_id IS NOT NULL AND nm.club_id = v_club_id)
          OR (v_union_id IS NOT NULL AND nm.club_id IN (
                SELECT c.id FROM public.clubs c WHERE c.union_id = v_union_id))
           )
  ),
  classified AS (
    SELECT
      /* THE COALESCE IS THE FIX. The column is nullable; a null reason used to
         come back as a null and the panel called .startsWith() on it. Same
         word the writer uses for a missing reason, so there is one vocabulary
         and not two. */
      COALESCE(s.reason, 'unspecified') AS reason,
      CASE
        WHEN s.reason LIKE 'mini\_refused:%' THEN 'mini_refused'
        WHEN s.reason LIKE 'mini\_%'         THEN 'mini'
        ELSE 'main'
      END AS kind,
      s.at,
      s.pot_size,
      s.message
    FROM scoped s
  )
  SELECT
    c.kind,
    c.reason,
    COUNT(*)::bigint,
    MAX(c.at),
    COALESCE(MAX(c.pot_size), 0),
    (ARRAY_AGG(c.message ORDER BY c.at DESC) FILTER (WHERE c.message IS NOT NULL))[1]
  FROM classified c
  GROUP BY c.kind, c.reason
  ORDER BY (c.kind = 'mini_refused') DESC, COUNT(*) DESC, c.reason;
END;
$function$;

COMMENT ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) IS
  'Why the jackpot did not pay: the near-miss log grouped by the gate that refused, for one pool, over a window of 1-365 days. For a club admin of that pool (or of any club in its union) and for a platform admin - the caller is read from auth.uid() at this function''s own surface. `kind` separates main from mini, and both from mini_refused, which is a hand that qualified and was turned away rather than one that never qualified. A null reason is reported as ''unspecified'' rather than passed on as a null. Moves no money and gates nothing.';

REVOKE ALL ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_near_miss_summary(uuid, integer) TO authenticated, service_role;

DO $$
DECLARE
  v_src      text;
  v_n        bigint;
  v_answered boolean := false;
  v_refusal  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_near_miss_summary';

  IF position('COALESCE(s.reason' in v_src) = 0 THEN
    RAISE EXCEPTION 'the reader can still hand back a null reason';
  END IF;
  IF position('auth.uid()' in v_src) = 0 THEN
    RAISE EXCEPTION 'the near-miss reader cannot be shown to know who is asking';
  END IF;
  IF has_function_privilege('anon', 'public.fn_bbj_near_miss_summary(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can read the near-miss log';
  END IF;
  IF has_table_privilege('anon', 'public.bbj_near_misses', 'SELECT')
     OR has_table_privilege('authenticated', 'public.bbj_near_misses', 'SELECT') THEN
    RAISE EXCEPTION 'a browser role can read the near-miss table directly';
  END IF;

  /* The authorisation gate still refuses a caller with no session. The RAISE
     that reports failure stays OUTSIDE the block that catches failure. */
  BEGIN
    SELECT count(*) INTO v_n
      FROM public.fn_bbj_near_miss_summary('00000000-0000-0000-0000-000000000000'::uuid, 30);
    v_answered := true;
  EXCEPTION
    WHEN OTHERS THEN
      v_refusal := SQLERRM;
  END;

  IF v_answered THEN
    RAISE EXCEPTION 'the near-miss reader answered an unauthenticated caller';
  END IF;
  IF v_refusal IS NULL OR position('Not authorized' in v_refusal) = 0 THEN
    RAISE EXCEPTION 'the near-miss reader refused, but not on the authorisation gate: %',
      COALESCE(v_refusal, '(no error captured)');
  END IF;
END $$;

COMMIT;
