-- ═══════════════════════════════════════════════════════════════════════════
--  THE ARMS ROSTER NAMES ITS CALLER
--  BBJ programme, post-audit phase 2 of 5, corrective pass (2026-09-11)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `check-definer-authorization` refused `fn_bbj_drill_arms` as "a roster nobody
-- can be scoped out of": SECURITY DEFINER so RLS does not apply, NO ARGUMENTS
-- so it cannot be scoped to a caller, RETURNS A SET so it hands back a list
-- rather than answering one question, and no visible `auth.uid()` /
-- `auth.role()` / `auth.jwt()` so it cannot be shown to know who is asking.
--
-- The guard cites the incident it was written from, and it is the right one:
-- on 2026-09-06 `fn_bbj_unclaimed_shares()` shipped in exactly this shape and
-- returned EVERY unpaid bad-beat-jackpot share on the platform - player name,
-- amount, table, hand - to any account that could log in. It was a read, so
-- the writer rule did not judge it; it was reachable by `authenticated` and
-- not `anon`, so the anon rule did not either. It fell between them.
--
-- This function DID scope itself - `WHERE public.fn_is_platform_admin()` - but
-- that call reads `auth.uid()` one level down, where the guard cannot see it.
-- "It is scoped, trust me" is exactly the claim a guard exists to refuse, and
-- a roster that returns a set and takes no arguments has no other way to be
-- scoped. The caller check is now visible at the function's own surface, the
-- same shape phase 3 used for `fn_bbj_mini_for_club`.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_bbj_drill_arms()
RETURNS TABLE(
  id uuid, table_id uuid, club_id uuid, pool_id uuid, kind text,
  pool_balance_at_arm numeric, note text, armed_by uuid, armed_at timestamptz,
  fired_at timestamptz, fired_hand_number bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id, a.table_id, a.club_id, a.pool_id, a.kind,
         a.pool_balance_at_arm, a.note, a.armed_by, a.armed_at,
         a.fired_at, a.fired_hand_number
    FROM public.bbj_drill_arms a
   WHERE auth.uid() IS NOT NULL
     AND public.fn_is_platform_admin()
   ORDER BY a.armed_at DESC;
$function$;

COMMENT ON FUNCTION public.fn_bbj_drill_arms() IS
  'Every drill arm, newest first, for a platform admin and nobody else - the '
  'caller is read from auth.uid() at this function''s own surface. Carries '
  '`kind` so a mini arm can be told from a main one, and pool_balance_at_arm '
  'is the balance of the bank that arm was armed against.';

REVOKE ALL ON FUNCTION public.fn_bbj_drill_arms() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_drill_arms() TO authenticated, service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_bbj_drill_arms';

  IF position('auth.uid()' in v_src) = 0 THEN
    RAISE EXCEPTION 'the arms roster still cannot be shown to know who is asking';
  END IF;
  IF position('fn_is_platform_admin' in v_src) = 0 THEN
    RAISE EXCEPTION 'the arms roster lost its platform-admin predicate';
  END IF;
  IF has_function_privilege('anon', 'public.fn_bbj_drill_arms()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-out visitor can list the drill arms';
  END IF;

  /* Run as postgres, fn_is_platform_admin() is false, so the roster must come
     back EMPTY rather than erroring - the scoping is a filter, not a refusal. */
  IF (SELECT count(*) FROM public.fn_bbj_drill_arms()) IS NULL THEN
    RAISE EXCEPTION 'the arms roster does not answer at all';
  END IF;
END $$;

COMMIT;
