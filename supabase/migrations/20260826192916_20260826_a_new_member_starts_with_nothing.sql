-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826192916; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A NEW MEMBER STARTS WITH NOTHING, AND AN AGENT CAN ACTUALLY CLAIM ONE.
-- Dan 2026-08-26, binding: "NEW PLAYERS SHOULD 100% OF THE TIME ALWAYS START
-- WITH ZERO CHIPS". club_members.chip_balance carried DEFAULT 1000, so every
-- join minted a thousand unbacked chips. Also: PlayerInviteModal's "Add Player"
-- inserted a referrer_id column that does not exist and never set agent_id, so
-- it had never once succeeded. Full rationale and ROLLBACK in
-- supabase/migrations/20260826_a_new_member_starts_with_nothing.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles' AND column_name='is_horse') THEN
    RAISE EXCEPTION 'profiles.is_horse is missing - the horse exemption cannot be expressed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='club_members' AND column_name='is_bot') THEN
    RAISE EXCEPTION 'club_members.is_bot is missing - the horse exemption cannot be expressed';
  END IF;
END $$;

ALTER TABLE public.club_members ALTER COLUMN chip_balance SET DEFAULT 0;

CREATE OR REPLACE FUNCTION public.fn_membership_starts_with_zero_chips()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_bot, false)
     OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.user_id AND COALESCE(p.is_horse, false))
  THEN
    RETURN NEW;
  END IF;

  NEW.chip_balance  := 0;
  NEW.held_chips    := 0;
  NEW.locked_chips  := 0;
  NEW.promo_balance := 0;
  NEW.credit_used   := 0;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_membership_starts_with_zero_chips ON public.club_members;
CREATE TRIGGER trg_membership_starts_with_zero_chips
  BEFORE INSERT ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_membership_starts_with_zero_chips();

COMMENT ON FUNCTION public.fn_membership_starts_with_zero_chips() IS
  'Dan 2026-08-26, binding: a new club membership always starts with zero chips. Zeroes chip_balance, held_chips, locked_chips, promo_balance and credit_used on INSERT no matter what the caller passed. Horses (profiles.is_horse / club_members.is_bot) are exempt because the fleet is stocked rather than bought.';

CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_requires_approval boolean;
  v_active_count int;
  v_role text;
  v_status text;
  v_row club_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT owner_id, COALESCE(requires_approval, false)
    INTO v_owner, v_requires_approval
    FROM clubs
    WHERE id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;

  SELECT * INTO v_row FROM club_members
    WHERE club_id = p_club_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN to_jsonb(v_row);
  END IF;

  IF v_uid = v_owner THEN
    v_role := 'owner';
    v_status := 'active';
  ELSE
    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 4 THEN
      RAISE EXCEPTION 'You can only be a member of up to 4 clubs. Leave a club to join a new one.';
    END IF;

    v_role := 'player';
    v_status := CASE WHEN v_requires_approval THEN 'pending' ELSE 'active' END;
  END IF;

  -- chip_balance = 0 written EXPLICITLY: the default was 1000 until 2026-08-26.
  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0)
  ON CONFLICT (club_id, user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM club_members
      WHERE club_id = p_club_id AND user_id = v_uid;
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_attach_player(
  p_club_id uuid,
  p_agent_user_id uuid,
  p_player_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_caller     uuid := auth.uid();
  v_is_staff   boolean := false;
  v_agent      record;
  v_member     record;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_authenticated',
                              'error', 'Please sign in again.');
  END IF;

  IF p_agent_user_id = p_player_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'self_attach',
                              'error', 'An agent cannot be their own downline.');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = v_caller
    UNION ALL
    SELECT 1 FROM club_members cm
     WHERE cm.club_id = p_club_id AND cm.user_id = v_caller
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND cm.status IN ('active', 'approved')
  ) INTO v_is_staff;

  IF NOT v_is_staff AND v_caller <> p_agent_user_id THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_authorized',
                              'error', 'You can only add players to your own downline.');
  END IF;

  SELECT * INTO v_agent FROM agents
   WHERE club_id = p_club_id AND user_id = p_agent_user_id AND status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_an_active_agent',
                              'error', 'That agent is not active in this club.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_player_id) THEN
    RETURN jsonb_build_object('success', false, 'code', 'unknown_player',
                              'error', 'That player does not exist.');
  END IF;

  SELECT * INTO v_member FROM club_members
   WHERE club_id = p_club_id AND user_id = p_player_id;

  IF NOT FOUND THEN
    INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level,
                              orange_ball_status, agent_id, invited_by)
    VALUES (p_club_id, p_player_id, 'player', 'active', 'bronze', 0, 'cold',
            p_agent_user_id, p_agent_user_id)
    RETURNING * INTO v_member;
  ELSE
    IF v_member.status NOT IN ('active', 'approved', 'pending') THEN
      RETURN jsonb_build_object('success', false, 'code', 'membership_blocked',
                                'error', 'That membership cannot be changed.');
    END IF;

    IF v_member.agent_id IS NOT NULL
       AND v_member.agent_id <> p_agent_user_id
       AND NOT v_is_staff THEN
      RETURN jsonb_build_object('success', false, 'code', 'already_in_a_downline',
                                'error', 'That player is already in another downline.');
    END IF;

    UPDATE club_members
       SET agent_id   = p_agent_user_id,
           invited_by = COALESCE(invited_by, p_agent_user_id),
           status     = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
           updated_at = now()
     WHERE club_id = p_club_id AND user_id = p_player_id
    RETURNING * INTO v_member;
  END IF;

  UPDATE agents
     SET total_players = (SELECT count(*) FROM club_members
                           WHERE agent_id = p_agent_user_id AND club_id = p_club_id),
         active_player_count = (SELECT count(*) FROM club_members
                                 WHERE agent_id = p_agent_user_id AND club_id = p_club_id
                                   AND status IN ('active', 'approved')),
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_member.status,
    'agent_id', v_member.agent_id,
    'chip_balance', v_member.chip_balance
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_agent_attach_player(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_agent_attach_player(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_agent_attach_player(uuid, uuid, uuid) IS
  'Attaches a player to an agent downline in one permission-checked call, creating the membership at zero chips if it does not exist. Replaces PlayerInviteModal direct insert, which wrote a referrer_id column that does not exist and therefore never once succeeded.';

DO $$
DECLARE
  v_default text;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='club_members' AND column_name='chip_balance';
  IF v_default IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'club_members.chip_balance default is %, expected 0', v_default;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='public.club_members'::regclass
                    AND tgname='trg_membership_starts_with_zero_chips') THEN
    RAISE EXCEPTION 'the zero-chips guard trigger was not created';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_join_club')
     NOT LIKE '%orange_ball_status, chip_balance%' THEN
    RAISE EXCEPTION 'fn_join_club does not name chip_balance explicitly';
  END IF;
END $$;

