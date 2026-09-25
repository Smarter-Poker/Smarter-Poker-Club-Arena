-- ============================================================================
-- THE OPENING SCENE: ONE DIAMOND ARENA THAT SATISFIES ITS OWN GUARD
-- ============================================================================
-- PRIVATE ISOLATED FIXTURE ONLY. Never target a shared database. Every row
-- here is synthetic and every account is on the estate's reserved
-- @smarter-poker.invalid fixture domain, which the real signup and social
-- triggers already recognise as certification equipment - so no trigger is
-- disabled and no guard is weakened to seed this.
--
-- THE ARENA MEMBERSHIP BOUNDARY, AND WHY THIS ARENA HAS NO OWNER.
-- poker_arena_membership_guard (fn_poker_guard_arena_structure) is
-- BEFORE INSERT OR UPDATE on public.club_members, and for a club whose asset
-- is 'diamonds' its very first test is `TG_OP='INSERT'`. An INSERT is refused
-- unconditionally. There is no exemption for postgres, for service_role or for
-- a platform admin: a Diamond arena admits NO membership insert at all.
--
-- That is not an accident, and the doors say so in their own words.
-- fn_ca_entry_scope_ok, captured beside this file:
--
--   -- The Diamond arena has no membership rows by design: every account with
--   -- a profile is a member. A retired or missing profile is not.
--
-- and fn_poker_arena_context sets member=true, role='player' for a Diamond
-- arena without consulting club_members at all.
--
-- Production does hold one club_members row for its Diamond Arena, and it is a
-- pre-guard artefact, not a condition the guard admits. Read read-only on
-- 2026-09-20: the arena club and that row were both created at
-- 2026-09-08T11:28:12.386252Z; poker_arena_identity_guards, the migration that
-- installed this guard, is recorded at version 20260908152855 - four hours
-- later - and the row's updated_at is 2026-09-08T15:28:55.978014Z, that
-- migration's own timestamp reshaping it into the only shape the guard
-- tolerates on UPDATE (role 'player', status 'automatic', every chip column
-- zero).
--
-- So the seed satisfies the guard the only way the guard allows: it creates no
-- membership row. clubs.owner_id is nullable in production as it is here, and
-- fn_club_owner_has_a_player_wallet - the DEFERRABLE INITIALLY DEFERRED
-- constraint trigger that would otherwise create the owner's wallet row at
-- COMMIT - returns NULL on its first line when owner_id IS NULL. The trigger
-- is not disabled; it is satisfied.
--
-- chip_treasury is passed as 0 explicitly. public.clubs.chip_treasury defaults
-- to 100000 in production and in this base, and the CHECK constraint
-- poker_arena_diamond_identity requires a Diamond arena to hold no chips.
-- fn_seed_new_club_opening_bank already refuses to grant an opening bank to a
-- non-chip club; the default is a column default, which no trigger overrides.
-- ============================================================================
DO $guard$ BEGIN
  IF current_database() <> 'diamond_tournament_lifecycle'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('port') <> '55733' THEN
    RAISE EXCEPTION 'isolated Diamond tournament lifecycle fixture only';
  END IF;
END $guard$;

CREATE FUNCTION fixture_assert(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
 BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label; END $$;

CREATE FUNCTION fixture_refuses(q text, expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE failed boolean := false; detail text;
BEGIN
  BEGIN EXECUTE q;
  EXCEPTION WHEN OTHERS THEN
    detail := SQLERRM;
    IF detail NOT LIKE '%'||expected||'%' THEN RAISE; END IF;
    failed := true;
  END;
  PERFORM fixture_assert(failed, 'refused: '||expected);
END $$;

-- The estate's own fixture signup path needs a bounded mint policy and a
-- current financial epoch. Both are synthetic finite bounds, not recovered
-- production house rules.
INSERT INTO public.ca_mint_policy
 (id, per_operation_cap_chips, rolling_24h_cap_chips,
  per_operation_cap_diamonds, rolling_24h_cap_diamonds, note)
VALUES (1, 100000, 100000, 5000, 50000,
        'Synthetic bounded lifecycle fixture policy; no production policy claim');
INSERT INTO public.ca_financial_epochs(name, description, is_current)
VALUES ('diamond-mtt-lifecycle', 'Synthetic local epoch; no copied financial rows', true);

SELECT set_config('request.jwt.claim.role', 'service_role', false);

-- Real signup hooks create each profile and its signup Diamond grant.
INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
                       email_confirmed_at, created_at, updated_at, is_super_admin)
VALUES
 ('10000000-0000-0000-0000-00000000000f','authenticated','authenticated',
  'diamondmttstaff@smarter-poker.invalid','{"provider":"email","providers":["email"]}',
  '{"full_name":"Diamond MTT Fixture Staff","poker_alias":"MttFxStaff"}',now(),now(),now(),false),
 ('10000000-0000-0000-0000-000000000001','authenticated','authenticated',
  'diamondmttp1@smarter-poker.invalid','{"provider":"email","providers":["email"]}',
  '{"full_name":"Diamond MTT Fixture One","poker_alias":"MttFxOne"}',now(),now(),now(),false),
 ('10000000-0000-0000-0000-000000000002','authenticated','authenticated',
  'diamondmttp2@smarter-poker.invalid','{"provider":"email","providers":["email"]}',
  '{"full_name":"Diamond MTT Fixture Two","poker_alias":"MttFxTwo"}',now(),now(),now(),false),
 ('10000000-0000-0000-0000-000000000003','authenticated','authenticated',
  'diamondmttp3@smarter-poker.invalid','{"provider":"email","providers":["email"]}',
  '{"full_name":"Diamond MTT Fixture Three","poker_alias":"MttFxThree"}',now(),now(),now(),false);
SET CONSTRAINTS ALL IMMEDIATE;

SELECT fixture_assert((SELECT count(*)=4 FROM public.profiles WHERE diamonds=500
                        AND COALESCE(is_horse,false)=false),
 'the real signup path made four synthetic profiles, each with its own signup grant');
SELECT fixture_assert((SELECT count(*)=0 FROM public.signup_errors),
 'the real signup path caught no error');

-- The platform operator. fn_is_platform_admin reads profiles.role.
UPDATE public.profiles SET role='god' WHERE id='10000000-0000-0000-0000-00000000000f';
SELECT fixture_assert((SELECT role='god' FROM public.profiles
                        WHERE id='10000000-0000-0000-0000-00000000000f'),
 'the fixture staff account holds the platform operations role');

-- Every write from here on is the platform operator's, as production's is.
SELECT set_config('request.jwt.claim.sub','10000000-0000-0000-0000-00000000000f',false);
SELECT set_config('request.jwt.claim.role','authenticated',false);
SELECT set_config('request.jwt.claims',
 '{"role":"authenticated","sub":"10000000-0000-0000-0000-00000000000f"}',false);
SELECT fixture_assert(public.fn_is_platform_admin(),
 'the create door''s staff_only gate sees a platform admin');

INSERT INTO public.clubs(id, name, slug, asset, is_platform, is_union, owner_id, chip_treasury,
                         description, tagline, is_public)
VALUES ('20000000-0000-0000-0000-000000000001','Diamond Arena','diamond-arena','diamonds',
        true, false, NULL, 0,
        'The synthetic fixture arena. Every event inside it plays in Diamonds.',
        'Play Your Diamonds', true);
SET CONSTRAINTS ALL IMMEDIATE;

SELECT fixture_assert((SELECT count(*)=1 FROM public.clubs
                        WHERE asset='diamonds' AND is_platform IS TRUE AND union_id IS NULL),
 'exactly one Diamond arena, platform-owned and in no union');
SELECT fixture_assert((SELECT count(*)=0 FROM public.club_members),
 'the arena carries no membership row, which is the only shape its guard admits');
SELECT fixture_assert((SELECT chip_treasury=0 AND chip_pool=0 AND promo_balance=0
                         AND insurance_balance=0 FROM public.clubs
                        WHERE id='20000000-0000-0000-0000-000000000001'),
 'the Diamond arena holds no chips of any kind');

-- The arena's own settings row. Both switches arrive false, as production holds
-- them, and nothing in this fixture ever turns either on.
INSERT INTO public.ca_arena_settings(id, club_id, settlement_window_days, note)
VALUES (1,'20000000-0000-0000-0000-000000000001',14,'synthetic lifecycle fixture');
SELECT fixture_assert((SELECT NOT cash_games_enabled AND NOT tournaments_enabled
                         AND settlement_window_days=14
                        FROM public.ca_arena_settings WHERE id=1),
 'the arena settings row is present and both switches are closed');

-- The MTT admission ABI production was observed running on 2026-09-20. The
-- creation door reads it to decide whether a field size is capped.
UPDATE public.ca_mtt_admission_contract SET abi='unlimited-mtt-v2' WHERE singleton;
SELECT fixture_assert(public.fn_ca_lock_mtt_admission_contract()='unlimited-mtt-v2',
 'the MTT admission contract states the ABI production runs');

-- The membership guard is intact, and this is the proof: the one row production
-- holds cannot be inserted here, by the guard, with the arena present.
SELECT fixture_refuses($q$
  INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance)
  VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
         'player','automatic',0)$q$,
 'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy');

-- And every account with a profile is nonetheless inside the arena, which is
-- what the guard's refusal is FOR.
SELECT fixture_assert(public.fn_ca_entry_scope_ok('10000000-0000-0000-0000-000000000001',
         '20000000-0000-0000-0000-000000000001'),
 'a profile with no membership row is in scope for a Diamond arena event');
SELECT fixture_assert(NOT public.fn_ca_entry_scope_ok('10000000-0000-0000-0000-0000000000ff',
         '20000000-0000-0000-0000-000000000001'),
 'an account with no profile is not in scope for a Diamond arena event');
SELECT fixture_assert((public.fn_poker_arena_context('diamond-arena')->>'member')::boolean
   AND public.fn_poker_arena_context('diamond-arena')->>'role'='player'
   AND NOT (public.fn_poker_arena_context('diamond-arena')->>'tournamentsEnabled')::boolean
   AND NOT (public.fn_poker_arena_context('diamond-arena')->>'cashGamesEnabled')::boolean,
 'the arena context makes every profile a player and reports both switches closed');
