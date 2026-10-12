-- ============================================================================
-- THE ARENA BELONGS TO THE SYSTEM
-- ============================================================================
--
-- Decided by Claude on Dan's delegation of 2026-09-30. Dan: "these are all for
-- you to decide not me ... FIX AND FINISH ALL OF THESE". Recorded in
-- docs/DIAMOND-RULINGS.md (Ruling 22) and
-- docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system.md.
--
-- Found by Diamond Phase 11 line 1 (docs/evidence/diamond-phase-11/
-- request-forgery-and-access.md, "The arena's owner"). The Diamond Arena's club
-- row named a real platform account as owner_id: daniel@smarter.poker, role
-- god, 2d1cd6c3-5700-4af9-a271-d4863fdab20d, an account people and scripts
-- sign in as. Every door that trusts a club's owner therefore treated whoever
-- signed in as that account as the arena's owner: it could edit the arena's
-- club row through the API, read the arena's audit rows and every Diamond
-- seat's session history, run the club integrity report, rewrite a Diamond
-- table's bomb pot through the chip door (outside the Diamond door's rules),
-- and it was the only account that could open a Diamond hand's hole cards.
-- The money consequences were already refused (poker_arena_diamond_identity
-- and the step-0 triggers). The authority itself was not.
--
-- THE SYSTEM IDENTITY. Phase 2's one system Diamond identity is the arena's
-- club row itself (poker_arena_one_diamond_identity and
-- poker_arena_diamond_identity). A club row cannot own itself, because
-- clubs.owner_id references profiles. So the arena is owned by the estate's
-- one non-person account: system@smarter.poker,
-- 00000000-0000-0000-0000-000000000001, "a system actor for service-side
-- writes" (20260901013451). It has no password, no sign-in identity and no
-- session, and it has never signed in. This migration asserts all of that
-- before it names it. Nobody signs in as the arena's owner, so no door that
-- trusts a club's owner admits a person to the arena. Platform staff (Dan
-- included) run the arena through the staff doors, which ask for the platform
-- role and a live session and never for ownership. Nothing a staff door does
-- changes.
--
-- WHAT CHANGES
--   1. fn_club_owner_has_a_player_wallet, the deferred constraint trigger on
--      clubs, gives a club's new owner an 'owner' club_members row. Diamond
--      participation is automatic and holds no wallet, and the arena's
--      membership guard refuses any other row, so this trigger would refuse
--      every change of the arena's owner at commit. It now returns for a club
--      whose asset is not chips. For a chip club it runs the text it ran
--      before.
--   2. The arena's owner_id becomes the system account. This is idempotent: an
--      arena the system already owns is left alone, and an arena owned by
--      anyone else refuses the migration. The former owner's automatic
--      participation row stays what every Diamond player's is.
--   3. fn_ca_operator_read_hand opened a hand's hole cards to the club's owner
--      or a club admin. The arena has no club admin, so for a Diamond hand that
--      was the former owner alone, and nobody could open a Diamond hand once the
--      system owns the arena. A Diamond hand is now opened by platform staff
--      with a live session, as every Diamond staff door admits, and its audit
--      row says platform_admin. A chip hand is opened exactly as before.
--   4. fn_poker_guard_arena_structure, a watched guard, now refuses a Diamond
--      club whose owner is anyone but the system account: "The Diamond Arena
--      Belongs To The System". Neither transfer_club_ownership nor a platform
--      write can hand the arena back to a person.
--
-- Every edit is an asserted substitution. The live md5 is pinned, the old
-- clause must occur exactly once, and the reverse substitution must reproduce
-- the pinned text. There is no new table, column, function or grant. No
-- Diamond moves and no Diamond switch opens.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)):
--   fn_club_owner_has_a_player_wallet          84222e6fb692c99fa27c843584ac9fc0
--   fn_ca_operator_read_hand                   5730804b7bd990a728b93cf602480273
--   fn_poker_guard_arena_structure (watched)   d3ecf93c4ac0aced79031b4ce00df59b
--
-- @live-proof: (SELECT count(*) = 1 AND bool_and(c.owner_id = '00000000-0000-0000-0000-000000000001'::uuid) FROM public.clubs c WHERE c.asset = 'diamonds')
-- @live-proof: (SELECT position('OR NEW.asset IS DISTINCT FROM ''chips'' THEN RETURN NULL; END IF;' IN pg_get_functiondef('public.fn_club_owner_has_a_player_wallet()'::regprocedure)) > 0)
-- @live-proof: (SELECT position('only platform staff may open a Diamond hand' IN pg_get_functiondef('public.fn_ca_operator_read_hand(uuid,bigint,text)'::regprocedure)) > 0 AND position('CASE WHEN v_diamond THEN ''platform_admin''' IN pg_get_functiondef('public.fn_ca_operator_read_hand(uuid,bigint,text)'::regprocedure)) > 0)
-- @live-proof: (SELECT position('The Diamond Arena Belongs To The System' IN pg_get_functiondef('public.fn_poker_guard_arena_structure()'::regprocedure)) > 0)
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is open; this migration expects both closed';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1 and 3: the owner's player wallet is a chip club's, and a Diamond hand is
-- opened by platform staff (asserted substitutions)
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  r record; v_oid oid; v_def text; v_new text; v_back text; v_n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ($f$fn_club_owner_has_a_player_wallet$f$, $p$84222e6fb692c99fa27c843584ac9fc0$p$,
     $o$  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) THEN RETURN NULL; END IF;$o$,
     $n$  -- THE ARENA BELONGS TO THE SYSTEM (2026-09-30): only a chip club gives its
  -- owner a player wallet. Diamond participation is automatic and holds no
  -- wallet (the arena's membership guard refuses any other row), so for the
  -- Diamond Arena this trigger would refuse every change of owner at commit.
  IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) OR NEW.asset IS DISTINCT FROM 'chips' THEN RETURN NULL; END IF;$n$,
     NULL::text, NULL::text),
    ($f$fn_ca_operator_read_hand$f$, $p$5730804b7bd990a728b93cf602480273$p$,
     $o$  v_have   int;
BEGIN
  IF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'only a club owner or admin may open a hand'
      USING ERRCODE = '42501';
  END IF;$o$,
     $n$  v_have   int;
  -- THE ARENA BELONGS TO THE SYSTEM (2026-09-30): the Diamond Arena's owner is
  -- the system account, which nobody signs in as, and the arena has no club
  -- admin. A Diamond hand is opened by platform staff with a live session, as
  -- every Diamond staff door admits. A chip hand is opened as before.
  v_diamond boolean := EXISTS (SELECT 1 FROM public.clubs c
                                WHERE c.id = p_club_id AND c.asset = 'diamonds');
BEGIN
  IF v_diamond THEN
    IF NOT public.fn_is_platform_admin() THEN
      RAISE EXCEPTION 'only platform staff may open a Diamond hand'
        USING ERRCODE = '42501';
    END IF;
    IF NOT public.fn_caller_session_is_live() THEN
      RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE = '28000';
    END IF;
  ELSIF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'only a club owner or admin may open a hand'
      USING ERRCODE = '42501';
  END IF;$n$,
     $o2$    public.fn_ca_club_actor_role(p_club_id, v_uid),
    'hand_godmode_read',$o2$,
     $n2$    CASE WHEN v_diamond THEN 'platform_admin' ELSE public.fn_ca_club_actor_role(p_club_id, v_uid) END,
    'hand_godmode_read',$n2$)
  ) AS t(fn, pin, old, new, old2, new2)
  LOOP
    SELECT p.oid INTO STRICT v_oid FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.fn;
    v_def := pg_get_functiondef(v_oid);
    IF md5(v_def) <> r.pin THEN
      RAISE EXCEPTION '% is not the pinned text (md5 %, pinned %)', r.fn, md5(v_def), r.pin;
    END IF;
    v_n := (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: the clause to change occurs % times, expected 1', r.fn, v_n;
    END IF;
    v_new := replace(v_def, r.old, r.new);
    IF r.old2 IS NOT NULL THEN
      v_n := (length(v_def) - length(replace(v_def, r.old2, ''))) / length(r.old2);
      IF v_n <> 1 THEN
        RAISE EXCEPTION '%: the second clause to change occurs % times, expected 1', r.fn, v_n;
      END IF;
      v_new := replace(v_new, r.old2, r.new2);
    END IF;
    EXECUTE v_new;
    v_back := replace(pg_get_functiondef(v_oid), r.new, r.old);
    IF r.old2 IS NOT NULL THEN
      v_back := replace(v_back, r.new2, r.old2);
    END IF;
    IF md5(v_back) <> r.pin THEN
      RAISE EXCEPTION '%: the reverse substitution does not reproduce the pinned text', r.fn;
    END IF;
  END LOOP;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. The arena's owner is the system account
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  c_system constant uuid := '00000000-0000-0000-0000-000000000001';
  c_former constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_arena uuid; v_owner uuid; v_n integer;
BEGIN
  SELECT c.id, c.owner_id INTO STRICT v_arena, v_owner FROM public.clubs c
   WHERE c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;

  -- The system account is a profile that nobody can sign in as: no password,
  -- no provider identity, no session or refresh token, never signed in, not a
  -- horse, no staff role.
  PERFORM 1 FROM auth.users u
   WHERE u.id = c_system AND u.email = 'system@smarter.poker'
     AND COALESCE(u.encrypted_password, '') = '' AND u.last_sign_in_at IS NULL
     AND NOT COALESCE(u.is_sso_user, false) AND NOT COALESCE(u.is_anonymous, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the system account is not an account nobody signs in as';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.identities WHERE user_id = c_system)
     OR EXISTS (SELECT 1 FROM auth.sessions WHERE user_id = c_system)
     OR EXISTS (SELECT 1 FROM auth.refresh_tokens WHERE user_id = c_system::text) THEN
    RAISE EXCEPTION 'the system account has a way to sign in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = c_system
                  AND p.role = 'user' AND NOT COALESCE(p.is_horse, false)
                  AND NOT COALESCE(p.is_admin, false)) THEN
    RAISE EXCEPTION 'the system account is not a plain non-staff profile';
  END IF;

  IF v_owner = c_system THEN
    RAISE NOTICE 'the Diamond Arena already belongs to the system';
  ELSIF v_owner IS DISTINCT FROM c_former THEN
    RAISE EXCEPTION 'the Diamond Arena is owned by %, not the account this decision moves it from', v_owner;
  ELSE
    UPDATE public.clubs SET owner_id = c_system WHERE id = v_arena AND owner_id = c_former;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the arena owner update touched % rows, expected 1', v_n;
    END IF;
  END IF;
  -- What a commit would check, checked now: the deferred owner-wallet trigger.
  SET CONSTRAINTS ALL IMMEDIATE;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. The arena guard keeps it that way (watched guard, declared)
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  c_pin constant text := 'd3ecf93c4ac0aced79031b4ce00df59b';
  c_old constant text := $o$      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;$o$;
  c_new constant text := $n$      RAISE EXCEPTION 'Diamond Arena Requires Platform Operations' USING ERRCODE='42501';
    END IF;
    -- THE ARENA BELONGS TO THE SYSTEM (2026-09-30, decided by Claude on Dan's
    -- delegation): a Diamond club is owned by the system account, which nobody
    -- signs in as, so no door that trusts a club's owner admits a person to
    -- the arena. Platform staff run it through the staff doors.
    IF NEW.asset='diamonds' AND NEW.owner_id IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
      RAISE EXCEPTION 'The Diamond Arena Belongs To The System' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;$n$;
BEGIN
  SELECT p.oid INTO STRICT v_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'fn_poker_guard_arena_structure';
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> c_pin THEN
    RAISE EXCEPTION 'fn_poker_guard_arena_structure is not the pinned text (md5 %, pinned %)', md5(v_def), c_pin;
  END IF;
  v_n := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_poker_guard_arena_structure: the clause to change occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, c_old, c_new);
  IF md5(replace(pg_get_functiondef(v_oid), c_new, c_old)) <> c_pin THEN
    RAISE EXCEPTION 'fn_poker_guard_arena_structure: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_guard_arena_structure', 'migration the_arena_belongs_to_the_system');

-- ---------------------------------------------------------------------------
-- What must be true now
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  c_system constant uuid := '00000000-0000-0000-0000-000000000001';
  c_former constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_arena uuid; v_txt text; v_bad text; v_state text; v_msg text;
BEGIN
  SELECT c.id INTO STRICT v_arena FROM public.clubs c
   WHERE c.asset = 'diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL
     AND c.owner_id = c_system;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = c_former AND asset = 'diamonds') THEN
    RAISE EXCEPTION 'the former owner still owns a Diamond club';
  END IF;
  -- the arena's participation rows are what they were: automatic players, none for the system
  IF EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id = v_arena
              AND (m.role IS DISTINCT FROM 'player' OR m.status IS DISTINCT FROM 'automatic'
                   OR m.user_id = c_system)) THEN
    RAISE EXCEPTION 'the arena has a membership row that is not an automatic player';
  END IF;

  v_txt := pg_get_functiondef('public.fn_club_owner_has_a_player_wallet()'::regprocedure);
  IF position('IF NEW.owner_id IS NULL OR COALESCE(NEW.is_union, false) OR NEW.asset IS DISTINCT FROM ''chips'' THEN RETURN NULL; END IF;' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the owner-wallet trigger still gives a Diamond owner a chip wallet';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_operator_read_hand(uuid,bigint,text)'::regprocedure);
  IF position('only platform staff may open a Diamond hand' IN v_txt) = 0
     OR position('fn_caller_session_is_live()' IN v_txt) = 0
     OR position('ELSIF NOT public.fn_ca_is_club_control(p_club_id, v_uid) THEN' IN v_txt) = 0
     OR position('CASE WHEN v_diamond THEN ''platform_admin'' ELSE public.fn_ca_club_actor_role(p_club_id, v_uid) END' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the hand door does not open a Diamond hand to platform staff only';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_operator_read_hand(uuid,bigint,text)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_ca_operator_read_hand(uuid,bigint,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'the hand door''s grants moved';
  END IF;
  IF has_function_privilege('anon', 'public.fn_club_owner_has_a_player_wallet()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_club_owner_has_a_player_wallet()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_poker_guard_arena_structure()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_poker_guard_arena_structure()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'a trigger function became callable from a browser';
  END IF;

  -- the guard is live: handing the arena to a person is refused by name
  BEGIN
    UPDATE public.clubs SET owner_id = c_former WHERE id = v_arena;
    RAISE EXCEPTION 'the arena guard let the arena change hands';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_state <> '23514' OR v_msg <> 'The Diamond Arena Belongs To The System' THEN
      RAISE EXCEPTION 'the arena guard answered % %, not The Diamond Arena Belongs To The System', v_state, v_msg;
    END IF;
  END;

  -- the switches stay off, the identity is whole, every watched guard is on its baseline
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open a Diamond switch';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'the arena belongs to the system: the system account owns the Diamond Arena, nobody signs in as it, a Diamond hand opens to platform staff, and the guard refuses handing the arena to a person';
END $m$;
