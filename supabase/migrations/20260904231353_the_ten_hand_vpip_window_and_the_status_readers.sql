-- ═══════════════════════════════════════════════════════════════════════════════
-- THE TEN-HAND VPIP WINDOW, AND THE TWO READERS THAT SHOW IT
-- (Operation Table Stakes, Gate 5 brought forward; Dan 2026-09-04)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, verbatim: "VPIP SHOULD BE DISPLAYED AS A REALTIME PERCENTAGE TRACKER TO
-- THE LEFT OF THE HERO (ONLY VISIBLE FOR THE USER). AND IF ANYONE FALLS UNDER
-- THE SET THRESHOLD FOR THE GAME AFTER 10 HANDS, OR ANYTIME AFTER THE 10 HANDS,
-- THEY GET BOOTED."
--
-- WHAT WAS TRUE BEFORE THIS. The rule was already armed and already judging:
-- every Action / Madness table carries nit_game = true, maintain_percent_min =
-- the template's floor (30-40 / 60-70), and fn_nit_evictions runs at every hand
-- boundary. Measured 2026-09-04 22:5x UTC: 1,333 hands across 26 templated
-- tables, VPIP on file for every seat, nobody yet under the floor over the
-- window. So "VPIP is not calculating" was really two other things:
--
--   1. The window was 40 hands (Action) / 30 (Madness), from OPORD 1.3
--      section 11.2. Dan has set it to TEN. `maintain_hands` on every cluster
--      table, `vpip_window` in every templated game's snapshot, and the
--      template defaults all say 10 now, and every feeder opened from a
--      snapshot inherits it. The rule itself checks at every hand boundary
--      after the window, which is "anytime after the 10 hands".
--
--   2. Nothing SHOWED a player the number they were being judged on. The only
--      VPIP on screen was the client's own session count, which is not what
--      fn_nit_check reads (ca_hand_facts, this table, this sitting). Two
--      readers below return exactly the judged number:
--
--      fn_cash_vpip_status(table)  the HERO's own figure, keyed on auth.uid(),
--                                  so it is private by construction. The felt
--                                  tracker left of the hero reads it after
--                                  every hand.
--      fn_nit_status(table)        every seated player's figure, for the
--                                  ENGINE (service_role only). The horse brain
--                                  reads its own row so a horse can play to
--                                  the floor the way a human regular would -
--                                  a horse obeys the VPIP floor identically
--                                  (CLAUDE.md 10.5; OPORD 1.4 section 2.2),
--                                  and obeying it means staying above it, not
--                                  being stood up every ten hands.
--
-- MEASURED BEFORE APPLYING, so the first effect is known: with the window at
-- 10, 18 of the 56 players seated on templated tables are under their floor
-- right now - all horses, 15 of them on Madness tables whose floor is 60-70%
-- against a fleet tuned to 19-32% VPIP. They will be stood up at their next
-- hand boundary (atomicCashout -> club_members.chip_balance, reason
-- nit_game_vpip; no chips are lost) and the fleet reseeds. That churn is the
-- reason the brain change ships in the same PR: from the next engine deploy a
-- horse at a floored table widens toward the floor.
--
-- One transaction: one PostgREST reload (CLAUDE.md 2, DDL policy).

BEGIN;

-- ── 1. The template defaults: window = 10 ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(coalesce(p_variant, 'nlh'));
  v_family text;
  v_seats integer; v_seats_locked boolean; v_seat_choices integer[];
  v_vpip integer; v_vpip_window integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;

  v_family := CASE
    WHEN v_v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo'
    WHEN v_v = 'short_deck' THEN 'shortdeck'
    WHEN v_v = 'pineapple' THEN 'pineapple'
    ELSE 'holdem' END;

  -- seats
  IF v_family = 'plo' THEN
    v_seats := 6; v_seats_locked := true; v_seat_choices := ARRAY[6];
  ELSIF v_family = 'holdem' THEN
    IF v_t = 'classic' THEN v_seats := 9; v_seat_choices := ARRAY[9, 6];
    ELSE v_seats := 6; v_seat_choices := ARRAY[2,3,4,5,6,7,8,9]; END IF;
    v_seats_locked := false;
  ELSE
    v_seats := 6; v_seats_locked := false; v_seat_choices := ARRAY[2,3,4,5,6,7,8];
  END IF;

  -- VPIP floor per template x family (percent). The window is TEN hands for
  -- every template (Dan 2026-09-04: "AFTER 10 HANDS, OR ANYTIME AFTER THE 10
  -- HANDS, THEY GET BOOTED"); it was 40 / 30 from OPORD 1.3 section 11.2.
  v_vpip := CASE v_t
    WHEN 'classic' THEN 0
    WHEN 'action'  THEN CASE v_family WHEN 'holdem' THEN 30 WHEN 'plo' THEN 40 ELSE 35 END
    ELSE                CASE v_family WHEN 'holdem' THEN 60 WHEN 'plo' THEN 70 ELSE 65 END END;
  v_vpip_window := 10;

  RETURN jsonb_build_object(
    'template', v_t,
    'variant', v_v,
    'family', v_family,
    'seats', v_seats,
    'seats_locked', v_seats_locked,
    'seat_choices', to_jsonb(v_seat_choices),
    'min_buyin_bb', CASE v_t WHEN 'classic' THEN 40 WHEN 'action' THEN 50 ELSE 100 END,
    'max_buyin_bb', 200,
    'regular_ante', CASE v_t WHEN 'classic' THEN 'none' WHEN 'action' THEN 'sb' ELSE 'bb' END,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object(
      'enabled', v_t <> 'classic',
      'trigger', CASE v_t WHEN 'action' THEN 'timed_15m' WHEN 'madness' THEN 'every_orbit' ELSE NULL END,
      'ante_bb', CASE v_t WHEN 'action' THEN 2 WHEN 'madness' THEN 3 ELSE NULL END,
      'boards', CASE WHEN v_t = 'classic' THEN NULL ELSE 2 END),
    'straddle', false,
    'stay_clock_min', 10,
    'rejoin_window_min', 120,
    'run_it_n_times', 'opt_in',
    'rake', 'existing'
  );
END;
$function$;

-- ── 2. Every templated game and every cluster table already open ─────────────
UPDATE public.cash_games
   SET ruleset_snapshot = jsonb_set(ruleset_snapshot, '{vpip_window}', '10'::jsonb),
       updated_at = now()
 WHERE must_move
   AND coalesce((ruleset_snapshot->>'vpip_window')::integer, 0) <> 10;

UPDATE public.tables
   SET maintain_hands = 10
 WHERE cluster_id IS NOT NULL
   AND coalesce(maintain_hands, 0) <> 10;

-- ── 3. The engine's reader: every seat's judged figure ───────────────────────
-- Same scope as fn_nit_check's MAINTAIN branch (this table, this sitting from
-- table_seats.joined_at), and `evict` is that branch's exact verdict, so the
-- number a horse steers by and the number it is stood up on are one number.
CREATE OR REPLACE FUNCTION public.fn_nit_status(p_table_id uuid)
 RETURNS TABLE(user_id uuid, hands integer, vpip numeric, required integer, window_hands integer, evict boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_on  boolean;
  v_min integer;
  v_n   integer;
  r     record;
BEGIN
  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1)
    INTO v_on, v_min, v_n
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  FOR r IN
    SELECT ts.user_id AS uid, ts.joined_at
      FROM public.table_seats ts
     WHERE ts.table_id = p_table_id
       AND ts.left_at IS NULL
  LOOP
    SELECT count(*)::int,
           CASE WHEN count(*) = 0 THEN NULL
                ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
      INTO hands, vpip
      FROM public.ca_hand_facts f
     WHERE f.table_id = p_table_id
       AND f.user_id = r.uid
       AND (r.joined_at IS NULL OR f.played_at >= r.joined_at);
    user_id      := r.uid;
    required     := CASE WHEN v_on THEN v_min ELSE 0 END;
    window_hands := v_n;
    evict        := v_on AND v_min > 0 AND hands >= v_n AND vpip IS NOT NULL AND vpip < v_min;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_nit_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_nit_status(uuid) TO service_role;

-- ── 4. The hero's reader: MY judged figure, and only mine ────────────────────
-- Keyed on auth.uid(): a browser can only ever ask about itself, which is what
-- "ONLY VISIBLE FOR THE USER" means at the database rather than in a component.
CREATE OR REPLACE FUNCTION public.fn_cash_vpip_status(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_on     boolean;
  v_min    integer;
  v_n      integer;
  v_joined timestamptz;
  v_hands  integer;
  v_vpip   numeric;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_signed_in');
  END IF;

  SELECT COALESCE(t.nit_game, false),
         GREATEST(COALESCE(t.maintain_percent_min, 0), 0),
         GREATEST(COALESCE(t.maintain_hands, 10), 1)
    INTO v_on, v_min, v_n
    FROM public.tables t WHERE t.id = p_table_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  SELECT ts.joined_at INTO v_joined
    FROM public.table_seats ts
   WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NULL
   ORDER BY ts.joined_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'seated', false,
      'nit_game', v_on, 'required', CASE WHEN v_on THEN v_min ELSE 0 END, 'window', v_n);
  END IF;

  SELECT count(*)::int,
         CASE WHEN count(*) = 0 THEN NULL
              ELSE round(100.0 * avg(CASE WHEN f.vpip THEN 1 ELSE 0 END), 1) END
    INTO v_hands, v_vpip
    FROM public.ca_hand_facts f
   WHERE f.table_id = p_table_id
     AND f.user_id = v_uid
     AND (v_joined IS NULL OR f.played_at >= v_joined);

  RETURN jsonb_build_object(
    'ok', true, 'seated', true,
    'nit_game', v_on,
    'required', CASE WHEN v_on THEN v_min ELSE 0 END,
    'window', v_n,
    'hands', v_hands,
    'vpip', v_vpip,
    'since', v_joined);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_cash_vpip_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_vpip_status(uuid) TO authenticated, service_role;

-- ── 5. Assert what this migration promised ───────────────────────────────────
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.cash_games
   WHERE must_move AND coalesce((ruleset_snapshot->>'vpip_window')::integer, 0) <> 10;
  IF v_bad > 0 THEN RAISE EXCEPTION 'vpip_window still not 10 on % templated game(s)', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.tables
   WHERE cluster_id IS NOT NULL AND coalesce(maintain_hands, 0) <> 10;
  IF v_bad > 0 THEN RAISE EXCEPTION 'maintain_hands still not 10 on % cluster table(s)', v_bad; END IF;
  IF (public.fn_cash_template_defaults('madness', 'nlh')->>'vpip_window')::integer <> 10 THEN
    RAISE EXCEPTION 'template defaults still carry the old window';
  END IF;
END $$;

COMMIT;
