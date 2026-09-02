-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828021806; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  fn_mystery_bounty_reveal: p_auto was a caller-supplied authorization bypass
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The authorization line read:
--
--   IF NOT COALESCE(p_auto, false) AND (p_actor_user_id IS NULL
--      OR p_actor_user_id IS DISTINCT FROM v_revealer) THEN ... 'not_the_revealer'
--
-- p_auto is a PARAMETER. Anyone holding an ordinary member JWT could call the
-- RPC with p_auto => true and skip the check entirely: read amount_cents, tier
-- and the recipient list for ANY award id, and flip the award and its chest to
-- 'revealed', stealing the knockout player's reveal. p_actor_user_id was
-- caller-supplied too, so even without p_auto an attacker could simply pass the
-- designated revealer's id.
--
-- Proven on 2026-08-27 in a rolled-back probe as an ordinary authenticated user
-- who was NOT the designated revealer:
--   PROBE1 ok=true amount_cents=1234500 tier=jackpot
--          award_status=revealed chest_status=revealed
--
-- THE FIX. Trust for these two inputs now comes from the request, not the
-- argument list:
--   * p_auto is honoured only for service_role (the engine's deadline sweep).
--   * every other caller's actor is auth.uid(); p_actor_user_id is ignored.
--
-- WHY auth.role() AND NOT current_user. This function is SECURITY DEFINER, so
-- inside the body current_user is the function OWNER (postgres) for the engine
-- and the browser alike — it can never tell them apart. That exact trap made an
-- earlier guard on club_members a silent no-op (see the 2026-08-27 chip-mint
-- fix). auth.role() reads the verified request JWT claim, which SECURITY
-- DEFINER does not rewrite.
--
-- WHY COALESCE(auth.role(), 'service_role'). A NULL means there is no PostgREST
-- request context at all — a direct database connection: psql, pg_cron, a
-- migration. Those are trusted and must keep working. A browser can never
-- produce NULL here: reaching the `authenticated` role requires a verified JWT,
-- and PostgREST always sets request.jwt.claims from it. `anon` holds no EXECUTE
-- on this function.
--
-- Callers, unchanged:
--   src/pages/TablePage.tsx:1171          p_auto: false, p_actor_user_id: userId
--   server/.../TournamentManagerEliminations.ts:1892  p_auto: true (service key)

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_reveal(
  p_award_id uuid,
  p_actor_user_id uuid,
  p_auto boolean DEFAULT false
)
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

REVOKE ALL ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_mystery_bounty_reveal(uuid, uuid, boolean) IS
  'Uncovers a reserved mystery bounty chest. p_auto is honoured only for service_role; every other caller acts as auth.uid() and p_actor_user_id is ignored. Hardened 2026-08-27 after a proven bypass via p_auto => true.';

