-- 20260913172658_a_player_can_see_their_own_responsible_gaming_state
--
-- A SELF-EXCLUDED PLAYER WAS TOLD THEY WERE FINE (2026-09-13)
--
-- WHAT WAS WRONG, demonstrated rather than argued. In a transaction that was
-- rolled back, one user was given `self_excluded_until = now() + 30 days` and
-- `fn_rg_require_not_excluded(that_user)` was called twice on the same row:
--
--   as service_role   {"ok": false, "error": "self_excluded", "self_excluded_until": ...}
--   as that player    {"ok": true,  "reason": "no_limits_set"}
--
-- The function is STABLE and NOT SECURITY DEFINER, so it reads
-- `responsible_gaming_limits` with the caller's own privileges. That table has
-- row-level security on and exactly two policies - `rg_limits_admin_select_all`
-- and `rg_limits_service_all`. Neither admits the user the row is ABOUT. So the
-- player's own row is invisible to the player, the function's "no row means no
-- limits" branch turns that invisibility into permission, and the answer comes
-- back `ok`.
--
-- EXECUTE on that function is granted to `authenticated` and `anon`, so it
-- reads as a check any client may make. Any client that made it - the Club
-- Arena rail this migration exists to serve, or anything else reaching for the
-- obvious function - would have been told a self-excluded player may be sold
-- to. A check that fails open is worse than no check: it looks like protection
-- on the review, and it is an advertisement in production.
--
-- WHY A POLICY AND NOT `SECURITY DEFINER`. Making the function definer would
-- also work and would be worse. It takes `p_user_id` as an argument, so as a
-- definer it would answer for ANY user id any caller passed, and a person's
-- self-exclusion is not a fact other players get to query. A SELECT policy
-- scoped to `auth.uid()` fixes the same hole and cannot be pointed at someone
-- else: the function keeps the caller's privileges, and the caller can now see
-- exactly one row - their own.
--
-- THIS DISCLOSES NOTHING NEW. `GET /api/rg/limits` in the World Hub already
-- selects this row and returns it to the player it belongs to. The row was
-- always theirs to see; it just was not visible on the path their own client
-- takes.
--
-- MIRRORS THE SIBLING TABLE. `responsible_gaming_sessions` already carries
-- `rg_sessions_user_select_own` for exactly this reason. The limits table was
-- the one that did not, which is why the gap survived.
--
-- `(SELECT auth.uid())` and not `auth.uid()`: the estate's
-- `fn_rls_policies_with_unhoisted_auth` guard fails any policy that calls auth.*
-- bare, and the verification block below re-runs it.
--
-- BLAST RADIUS: none. `responsible_gaming_limits` holds zero rows today -
-- nobody on this platform has ever set a limit or self-excluded. This closes
-- the hole before the first person walks into it.
--
-- ONE TRANSACTION, per CLAUDE.md's production DDL policy: PostgREST reloads its
-- whole schema cache on every DDL event and one reload costs ~28 seconds.

BEGIN;

DROP POLICY IF EXISTS rg_limits_user_select_own ON public.responsible_gaming_limits;
CREATE POLICY rg_limits_user_select_own
  ON public.responsible_gaming_limits
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

COMMENT ON POLICY rg_limits_user_select_own ON public.responsible_gaming_limits IS
  'A player may read the row that is about them, and only that row. Without it '
  'fn_rg_require_not_excluded - which is not SECURITY DEFINER - answered "ok" '
  'to a self-excluded player asking about themselves.';

DO $$
DECLARE
  v_uid uuid;
  v_house jsonb;
  v_player jsonb;
  v_unhoisted int;
BEGIN
  -- 1. The policy exists and is a SELECT policy for authenticated.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname = 'responsible_gaming_limits'
      AND p.polname = 'rg_limits_user_select_own'
      AND p.polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED: rg_limits_user_select_own is not a SELECT policy';
  END IF;

  -- 2. THIS policy is hoisted. Deliberately not "the estate reports zero":
  --    production already carries one pre-existing offender
  --    (player_boosts.player_boosts_owner_reads, measured 2026-09-13), so an
  --    `expected 0` assertion would fail this migration on apply for somebody
  --    else's row. That one is a performance nit on another table and is not
  --    this change's to fix; what this migration owes is that it does not add
  --    a second.
  SELECT count(*) INTO v_unhoisted
  FROM public.fn_rls_policies_with_unhoisted_auth()
  WHERE policy_name = 'rg_limits_user_select_own';
  IF v_unhoisted <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: rg_limits_user_select_own calls auth.* bare';
  END IF;

  -- 3. THE ACTUAL BEHAVIOUR. Give one user an exclusion, ask the question the
  --    way the house asks it and the way the player's own client asks it, and
  --    require the two answers to agree. The row is removed before the block
  --    ends, so the table is left exactly as it was found.
  SELECT id INTO v_uid FROM auth.users LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE NOTICE 'no auth users; behavioural check skipped';
  ELSE
    INSERT INTO public.responsible_gaming_limits(user_id, self_excluded_until)
    VALUES (v_uid, now() + interval '1 day');

    v_house := public.fn_rg_require_not_excluded(v_uid);

    SET LOCAL ROLE authenticated;
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_uid, 'role', 'authenticated')::text,
      true
    );
    v_player := public.fn_rg_require_not_excluded(v_uid);
    RESET ROLE;

    DELETE FROM public.responsible_gaming_limits WHERE user_id = v_uid;

    IF (v_house->>'ok')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'VERIFY FAILED: the house no longer sees the exclusion: %', v_house;
    END IF;
    IF (v_player->>'ok')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION
        'VERIFY FAILED: the player is still told they are fine: %', v_player;
    END IF;
    IF v_player->>'error' <> 'self_excluded' THEN
      RAISE EXCEPTION 'VERIFY FAILED: the player is given the wrong reason: %', v_player;
    END IF;
  END IF;
END $$;

COMMIT;
