-- ═══════════════════════════════════════════════════════════════════════════════
-- A NEW MEMBER STARTS WITH NOTHING, AND AN AGENT CAN ACTUALLY CLAIM ONE
--
-- Dan, 2026-08-26, binding, verbatim:
--
--   "NEW PLAYERS SHOULD 100% OF THE TIME ALWAYS START WITH ZERO CHIPS! THEY
--    SHOULD NEVER EVER EVER HAVE CHIPS INSIDE THERE ACCOUNT WHEN THEY JOIN."
--
-- ── PART 1: THE 1,000-CHIP MINT ───────────────────────────────────────────────
--
-- `club_members.chip_balance` carried `DEFAULT 1000`. Every membership row ever
-- created without an explicit balance was born holding a thousand chips that
-- nobody transferred, nobody bought, and no ledger row explains. Dan's own test
-- join at 19:21 today landed with exactly that:
--
--   runbabyrun / runthetable45@gmail.com -> SHARK CLUB, chip_balance 1000.00
--
-- This is not cosmetic. `fn_club_chip_circulation()` counts
-- club_members.chip_balance as one of the two live chip pools (121M in member
-- wallets as of yesterday), and `reconcile_ledger_nightly` compares ledger
-- movement against stored balances -- so a default-minted balance reads as
-- drift that nothing can account for, forever.
--
-- Three layers, because a column default is one ALTER away from coming back:
--
--   1. The default becomes 0.
--   2. `fn_join_club` writes chip_balance = 0 EXPLICITLY, so it does not depend
--      on the default at all.
--   3. A BEFORE INSERT trigger zeroes every money column on a new membership
--      row regardless of what the caller asked for. Chips reach a member
--      through a ledgered transfer, or they do not reach them.
--
-- HORSES ARE EXEMPT, and only horses. `HorseOnboarding.ensureClubMembership`
-- seats a horse with 50,000 chips because the fleet is stocked, not bought;
-- a horse with no bankroll cannot sit down and the tables go empty. The
-- exemption is keyed on `profiles.is_horse` / `club_members.is_bot`, which no
-- human account can set for itself.
--
-- NOT TOUCHED: `fn_grant_first_club_bonus`, which credits 10,000 to somebody
-- who CREATES a club. That is a different event from joining one, it is
-- deliberate, and Dan has not asked for it to change. Say so out loud rather
-- than quietly folding it into this.
--
-- NOT TOUCHED: the five existing rows already holding a default-minted 1,000.
-- Those are real balances on real accounts; correcting them is moving money and
-- needs Dan to say so first.
--
-- ── PART 2: "ADD PLAYER" HAS NEVER ONCE WORKED ────────────────────────────────
--
-- Dan, same message: "MAKE SURE THIS PLAYER IS ATTACHED TO THE AGENT WHO
-- REFERRED THEM AND IS ATTACHED TO THEIR DOWNLINES."
--
-- Through an invite link that now works -- verified in production: runbabyrun
-- is attached to kingfish, whose agents row reads total_players 11 against a
-- real downline of 11. Through the agent UI it never has. `PlayerInviteModal`
-- adds a player with
--
--     supabase.from('club_members').insert({ ..., referrer_id: agentId })
--
-- and `club_members` HAS NO referrer_id COLUMN. PostgREST rejects the whole
-- insert (PGRST204), so the button has always failed. It also never set
-- `agent_id`, which is the column the hierarchy is actually built from, and it
-- passed the `agents` table PRIMARY KEY where a user id was wanted.
--
-- `fn_agent_attach_player` below is the real thing: one permission-checked
-- call that creates the membership if needed (at zero chips, via Part 1) and
-- attaches it to the agent, then re-derives that agent's counts.
--
-- ROLLBACK
--
--   ALTER TABLE public.club_members ALTER COLUMN chip_balance SET DEFAULT 1000;
--   DROP TRIGGER IF EXISTS trg_membership_starts_with_zero_chips ON public.club_members;
--   DROP FUNCTION IF EXISTS public.fn_membership_starts_with_zero_chips();
--   DROP FUNCTION IF EXISTS public.fn_agent_attach_player(uuid, uuid, uuid);
--   -- fn_join_club's explicit chip_balance = 0 is left in place: it is correct
--   -- with or without the default.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Pre-flight ──────────────────────────────────────────────────────────────
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

-- ── 1. The default ──────────────────────────────────────────────────────────
ALTER TABLE public.club_members ALTER COLUMN chip_balance SET DEFAULT 0;

-- ── 2. The guard that does not care what the caller asked for ───────────────
CREATE OR REPLACE FUNCTION public.fn_membership_starts_with_zero_chips()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Horses are stocked by the fleet, not by a person joining a club. Nothing a
  -- human account can do sets is_horse or is_bot.
  IF COALESCE(NEW.is_bot, false)
     OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.user_id AND COALESCE(p.is_horse, false))
  THEN
    RETURN NEW;
  END IF;

  -- A membership is born empty. Every chip a member holds must be explainable
  -- by a ledgered transfer that happened after this row existed.
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

-- ── 3. fn_join_club stops relying on the default ────────────────────────────
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

  -- Idempotent: if a membership row already exists, return it unchanged.
  SELECT * INTO v_row FROM club_members
    WHERE club_id = p_club_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN to_jsonb(v_row);
  END IF;

  IF v_uid = v_owner THEN
    v_role := 'owner';
    v_status := 'active';
  ELSE
    -- Enforce the 4-club limit (count active memberships).
    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 4 THEN
      RAISE EXCEPTION 'You can only be a member of up to 4 clubs. Leave a club to join a new one.';
    END IF;

    -- MUST use 'player' not 'member' to satisfy club_members_role_check
    v_role := 'player';
    v_status := CASE WHEN v_requires_approval THEN 'pending' ELSE 'active' END;
  END IF;

  -- chip_balance = 0 is written EXPLICITLY. The column default was 1000 until
  -- 2026-08-26 and every join minted a thousand unbacked chips; naming the
  -- value here means this function is correct whatever the default becomes.
  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0)
  ON CONFLICT (club_id, user_id) DO NOTHING
  RETURNING * INTO v_row;

  -- Race: a concurrent insert won the conflict — re-read the existing row.
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM club_members
      WHERE club_id = p_club_id AND user_id = v_uid;
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$;

-- ── 4. An agent can claim a player, for real this time ──────────────────────
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

  -- Staff of this club may attach anyone to anyone. An agent may only attach
  -- players to THEMSELVES.
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
    -- chip_balance is not named here on purpose: the BEFORE INSERT guard
    -- zeroes it, and naming it would imply this function gets a say.
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

    -- A plain agent may only claim a player nobody has. Staff may move one.
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

  -- Re-derive rather than increment: a counter that is added to drifts.
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
  'Attaches a player to an agent''s downline in one permission-checked call, creating the membership at zero chips if it does not exist. Replaces PlayerInviteModal''s direct insert, which wrote a referrer_id column that does not exist and therefore never once succeeded.';

-- ── Post-apply assertions ───────────────────────────────────────────────────
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
