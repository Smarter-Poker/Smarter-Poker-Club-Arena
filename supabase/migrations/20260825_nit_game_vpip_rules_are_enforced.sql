-- ═══════════════════════════════════════════════════════════════════════════
-- NIT GAME: VPIP RULES THAT ACTUALLY BITE
-- ───────────────────────────────────────────────────────────────────────────
-- APPLIED TO PRODUCTION 2026-08-25 as migrations
--   nit_game_vpip_rules_are_enforced
--   club_home_returns_the_nit_game_columns   (the lobby half, at the foot)
--
-- Dan 2026-08-25: "VPIP NEEDS TO BE BUILT OUT AND ADDED INTO THE TABLE
-- CREATIONS ... FULLY BUILT OUT AND IMPLEMENTED FOR ALL CASH GAMES."
--
-- Four columns existed, the creation page wrote all four, and NOTHING read any
-- of them. The NIT Game toggle's own tooltip says "Penalty for tight play" and
-- there was no penalty:
--
--   nit_game             master switch
--   career_percent_min   minimum LIFETIME VPIP, checked at the door
--   maintain_percent_min minimum VPIP AT THIS TABLE, checked between hands
--   maintain_hands       how many hands before the maintain rule can judge
--
-- WHERE THE NUMBER COMES FROM. `ca_hand_facts` already stores one row per
-- player per hand with a `vpip` boolean, derived by deriveFlowFlags() from the
-- action log -- the same definition the seat HUD and the player stats use. So
-- these rules are a query, not a second implementation, and they cannot drift
-- from the VPIP a player sees on their own HUD. Counting it again in engine
-- memory would also have parted company with the stored figure the first time
-- a process restarted mid-session.
--
-- BOTH RULES FAIL OPEN ON AN INSUFFICIENT SAMPLE. This is not defensiveness,
-- it is the only correct behaviour: a player with no history has a VPIP of
-- 0/0, not 0%. Judging that as zero would refuse every new player from every
-- nit game -- exactly the players a club wants -- and would evict every horse,
-- since horses have no ca_hand_facts rows at all.
--
-- THE CAREER SAMPLE FLOOR is GREATEST(maintain_hands * 10, 100). A career read
-- needs about an order of magnitude more hands than a session read, the host
-- already tunes the session number, and the floor of 100 stops a host who sets
-- maintain_hands to 1 from judging a career on ten hands.
--
-- VERIFIED against production inside rolled-back transactions (CLAUDE.md 11.5),
-- using the one account that actually has hand facts (452 lifetime hands at
-- 21.5% VPIP, 96 of them at one table at 0%):
--   switch off, numbers set high    -> {"ok": true, "reason": "nit_game_off"}
--   career floor 99                 -> career_vpip, 21.5 over 452 hands
--   maintain floor 50, 5 hands      -> the seated player was listed for
--                                      eviction; a horse at the same table
--                                      was not
--   the door, career floor 99       -> NIT_GAME: this table needs a career
--                                      VPIP of at least 99, and yours is 21.5
--                                      over 452 hands
--   a member with no facts at all   -> {"ok": true, "reason": "within_limits"}
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE SHARED READ ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_nit_check(p_table_id uuid, p_user_id uuid, p_since timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on            boolean;
  v_career_min    integer;
  v_maintain_min  integer;
  v_maintain_n    integer;
  v_career_floor  integer;
  v_career_hands  integer;
  v_career_vpip   numeric;
  v_table_hands   integer;
  v_table_vpip    numeric;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.career_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1)
    INTO v_on, v_career_min, v_maintain_min, v_maintain_n
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;

  -- The toggle is the master switch. With NIT Game off the three numbers do
  -- nothing, which is what a switch labelled "Penalty for tight play" means
  -- and what makes the numbers safe to leave at their defaults.
  IF NOT COALESCE(v_on, false) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'nit_game_off');
  END IF;

  -- ── CAREER ───────────────────────────────────────────────────────────────
  IF v_career_min > 0 THEN
    v_career_floor := GREATEST(v_maintain_n * 10, 100);
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_career_hands, v_career_vpip
      FROM public.ca_hand_facts f
     WHERE f.user_id = p_user_id;

    IF v_career_hands >= v_career_floor AND v_career_vpip < v_career_min THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'career_vpip',
        'vpip', v_career_vpip, 'required', v_career_min, 'hands', v_career_hands);
    END IF;
  END IF;

  -- ── MAINTAIN ─────────────────────────────────────────────────────────────
  -- Scoped to THIS table, and to this sitting when a start time is given (the
  -- seat's joined_at). A player who rebuys after a break starts a fresh count;
  -- carrying yesterday's tight session into today would be a rule nobody could
  -- see coming.
  IF v_maintain_min > 0 THEN
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO v_table_hands, v_table_vpip
      FROM public.ca_hand_facts f
     WHERE f.table_id = p_table_id
       AND f.user_id = p_user_id
       AND (p_since IS NULL OR f.played_at >= p_since);

    IF v_table_hands >= v_maintain_n AND v_table_vpip < v_maintain_min THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'maintain_vpip',
        'vpip', v_table_vpip, 'required', v_maintain_min, 'hands', v_table_hands);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'within_limits');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_nit_check(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_nit_check(uuid, uuid, timestamptz) TO authenticated, service_role;

-- ── WHO A NIT GAME SHOULD STAND UP, RIGHT NOW ──────────────────────────────
-- One call per table between hands rather than one per seated player. The
-- engine's dealing loop already evicts on sit-out and on the away-blind cap;
-- this feeds the same machinery.
CREATE OR REPLACE FUNCTION public.fn_nit_evictions(p_table_id uuid)
 RETURNS TABLE(user_id uuid, vpip numeric, required integer, hands integer)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  v jsonb;
BEGIN
  FOR r IN
    SELECT ts.user_id AS uid, ts.joined_at
      FROM public.table_seats ts
      JOIN public.profiles p ON p.id = ts.user_id
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
       -- Horses are never stood up by this rule. They have no ca_hand_facts
       -- rows, so the sample floor already spares them; this makes it explicit
       -- rather than incidental, because the fleet is what keeps tables alive.
       AND COALESCE(p.is_horse, false) = false
  LOOP
    v := public.fn_nit_check(p_table_id, r.uid, r.joined_at);
    IF (v->>'ok')::boolean = false AND v->>'reason' = 'maintain_vpip' THEN
      user_id  := r.uid;
      vpip     := (v->>'vpip')::numeric;
      required := (v->>'required')::integer;
      hands    := (v->>'hands')::integer;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_nit_evictions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_nit_evictions(uuid) TO service_role;

-- ── THE DOOR ───────────────────────────────────────────────────────────────
-- Career VPIP is checked where the seat is sold, beside the VIP, table-size
-- and no-rathole guards. Patched rather than restated so nothing applied to
-- this function earlier the same day can be lost.
--
-- The message carries no percent signs: RAISE treats % as a placeholder, and
-- an escaped %% next to three real arguments is how the first attempt at this
-- migration failed to compile.
DO $$
DECLARE
  v_def text;
  v_anchor CONSTANT text := '  IF EXISTS (SELECT 1 FROM table_seats';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin';

  IF position('NIT_GAME:' in v_def) > 0 THEN
    RAISE NOTICE 'atomic_table_buyin already enforces the career VPIP rule';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'atomic_table_buyin is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def, v_anchor,
    E'  -- NIT GAME, CAREER VPIP (added 2026-08-25). Fails OPEN below the\n'
    || E'  -- sample floor: a player with no history has a VPIP of 0/0, not 0.\n'
    || E'  -- See fn_nit_check.\n'
    || E'  DECLARE v_nit jsonb;\n'
    || E'  BEGIN\n'
    || E'    v_nit := public.fn_nit_check(p_table_id, p_user_id, NULL);\n'
    || E'    IF (v_nit->>''ok'')::boolean = false AND v_nit->>''reason'' = ''career_vpip'' THEN\n'
    || E'      RAISE EXCEPTION ''NIT_GAME: this table needs a career VPIP of at least %, and yours is % over % hands'',\n'
    || E'        v_nit->>''required'', v_nit->>''vpip'', v_nit->>''hands''\n'
    || E'        USING HINT = ''The host has set a minimum voluntarily-put-in-pot rate for this game.'';\n'
    || E'    END IF;\n'
    || E'  END;\n\n'
    || v_anchor);
END $$;

-- ── THE SIGN ───────────────────────────────────────────────────────────────
-- The lobby cannot print a rule it is not sent, and the chip states the actual
-- thresholds because "NIT GAME" alone tells a player nothing about whether
-- they would survive it.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF position('nit_game' in v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already sends the nit game columns';
    RETURN;
  END IF;

  IF position('           is_vip_only, label_as_new, is_featured, hide_club_name' in v_def) = 0 THEN
    RAISE EXCEPTION 'the tables select list is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def,
    '           is_vip_only, label_as_new, is_featured, hide_club_name',
    E'           is_vip_only, label_as_new, is_featured, hide_club_name,\n'
    || E'           -- NIT GAME: the switch and the three numbers it governs.\n'
    || E'           nit_game, career_percent_min, maintain_percent_min, maintain_hands');
END $$;

DO $$
DECLARE v_buyin text; v jsonb; t jsonb;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_buyin FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='atomic_table_buyin';
  IF position('NIT_GAME:' in v_buyin) = 0 THEN
    RAISE EXCEPTION 'the career VPIP gate is not in the deployed function';
  END IF;
  IF position('VIP_ONLY:' in v_buyin) = 0 OR position('IS_TEMPLATE:' in v_buyin) = 0
     OR position('NO_RATHOLE:' in v_buyin) = 0 OR position('TABLE_SIZE:' in v_buyin) = 0
     OR position('TABLE_CAP_REACHED:' in v_buyin) = 0 THEN
    RAISE EXCEPTION 'a guard applied earlier today was lost';
  END IF;

  v := public.get_club_home('shark-club');
  IF COALESCE((v->>'found')::boolean, false) THEN
    t := v->'tables'->0;
    IF t IS NOT NULL AND NOT (t ? 'nit_game' AND t ? 'career_percent_min'
                              AND t ? 'maintain_percent_min' AND t ? 'maintain_hands') THEN
      RAISE EXCEPTION 'the nit game columns did not reach the table payload';
    END IF;
    IF t IS NOT NULL AND (t ? 'settings' OR NOT (t ? 'club_id' AND t ? 'is_vip_only')) THEN
      RAISE EXCEPTION 'an earlier change to this select list was reverted';
    END IF;
  END IF;
END $$;
