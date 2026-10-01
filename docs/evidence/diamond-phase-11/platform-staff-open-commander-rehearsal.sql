-- ============================================================================
-- PLATFORM STAFF OPEN COMMANDER (production rehearsal)
-- ============================================================================
-- REHEARSAL ONLY. rehearse.sh runs the migration (or nothing, for the state
-- before it) and then this file against production as ONE transaction that ends
-- in a deliberate error (RAISE EXCEPTION 'REHEARSAL OK ...'), so NOTHING
-- persists. No CI runner loads this file. It is evidence, repeatable by hand:
--   rehearse.sh supabase/migrations/20261001125101_platform_staff_open_commander.sql \
--     docs/evidence/diamond-phase-11/platform-staff-open-commander-rehearsal.sql <you>
--   rehearse.sh /dev/null docs/evidence/diamond-phase-11/platform-staff-open-commander-rehearsal.sql <you>
--
-- WHAT IT PROVES. Club Commander admits daniel@smarter.poker (role god, the
-- platform staff account Dan and the scripts use) through the platform-staff
-- rule, both as the World Hub asks (the server, for the token's user) and as
-- the account asks for itself. An ordinary player is still refused, and cannot
-- borrow the god account's answer by asking about it. Every account that is not
-- platform staff answers exactly as the four ways in say. The arena keeps its
-- system owner.
--
-- MODE is read from production: 'fixed' when has_commander_access carries the
-- platform-staff rule, 'baseline' when it does not. The OK line names it.
--
-- Read-only doors only. No session is created, no Diamond moves, and no row is
-- written. lock_timeout 2s.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE res(n serial PRIMARY KEY, grp text, label text, who text, ok boolean, answer text);

CREATE FUNCTION pg_temp.uid(p_who text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE p_who
    WHEN 'D' THEN '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid  -- daniel@smarter.poker, role god
    WHEN 'P' THEN '318a0d81-6e01-49a1-8884-e5a4c2697a2a'::uuid  -- a player (hydra.bot, not a horse)
  END;
$f$;

-- Become a caller, as PostgREST makes one: 'engine' is the server (the World
-- Hub's check-access route), 'anon' has no account, 'catalog' stays the
-- rehearsal owner.
CREATE FUNCTION pg_temp.become(p_who text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid := pg_temp.uid(p_who);
BEGIN
  IF p_who = 'catalog' THEN RETURN; END IF;
  IF p_who = 'engine' THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SET LOCAL ROLE service_role;
    RETURN;
  END IF;
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    SET LOCAL ROLE anon;
    RETURN;
  END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unknown identity %', p_who; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $f$;

CREATE FUNCTION pg_temp.probe(p_who text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_out text; v_state text; v_msg text;
BEGIN
  BEGIN
    PERFORM pg_temp.become(p_who);
    EXECUTE p_sql INTO v_out;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ANSWERED:' || COALESCE(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  RETURN v_state || '|' || v_msg;
END $f$;

CREATE FUNCTION pg_temp.expect(p_grp text, p_label text, p_who text, p_sql text, p_expect text)
RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE v_ans text := pg_temp.probe(p_who, p_sql); v_ok boolean := v_ans ~ p_expect;
BEGIN
  INSERT INTO pg_temp.res(grp, label, who, ok, answer) VALUES (p_grp, p_label, p_who, v_ok, left(v_ans, 300));
  RETURN v_ok;
END $f$;

DO $scene$
BEGIN
  IF position('PLATFORM STAFF OPEN COMMANDER' IN pg_get_functiondef('public.has_commander_access(uuid)'::regprocedure)) > 0 THEN
    PERFORM set_config('commander.mode', 'fixed', true);
  ELSE
    PERFORM set_config('commander.mode', 'baseline', true);
  END IF;
  IF (SELECT role FROM public.profiles WHERE id = pg_temp.uid('D')) <> 'god'
     OR (SELECT role FROM public.profiles WHERE id = pg_temp.uid('P')) <> 'user'
     OR (SELECT COALESCE(is_horse, false) FROM public.profiles WHERE id = pg_temp.uid('P'))
     OR EXISTS (SELECT 1 FROM public.clubs WHERE owner_id IN (pg_temp.uid('D'), pg_temp.uid('P')))
     OR EXISTS (SELECT 1 FROM public.commander_subscriptions WHERE owner_id IN (pg_temp.uid('D'), pg_temp.uid('P')))
     OR EXISTS (SELECT 1 FROM public.commander_staff WHERE user_id IN (pg_temp.uid('D'), pg_temp.uid('P'))
                   OR linked_user_id IN (pg_temp.uid('D'), pg_temp.uid('P')))
     OR EXISTS (SELECT 1 FROM public.commander_home_groups WHERE owner_id IN (pg_temp.uid('D'), pg_temp.uid('P'))) THEN
    RAISE EXCEPTION 'the scene is not what this rehearsal assumes: neither account may hold any of the four ways in';
  END IF;
END $scene$;

CREATE FUNCTION pg_temp.moded(p_baseline text, p_fixed text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE current_setting('commander.mode') WHEN 'fixed' THEN p_fixed ELSE p_baseline END;
$f$;

CREATE TEMP TABLE base AS SELECT
  (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) AS identity,
  (SELECT owner_id FROM public.clubs WHERE asset = 'diamonds') AS arena_owner;

DO $probes$
DECLARE D uuid := pg_temp.uid('D'); P uuid := pg_temp.uid('P');
BEGIN
  -- 1. Commander admits the god account, through the platform-staff rule only
  PERFORM pg_temp.expect('1 god account', 'Commander access, as the World Hub asks (the server, for the user)', 'engine',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', D),
    pg_temp.moded('^P0001\|ANSWERED:false$', '^P0001\|ANSWERED:true$'));
  PERFORM pg_temp.expect('1 god account', 'the answer says why: platform staff', 'engine',
    format('SELECT public.get_commander_access_details(%L)->>''isPlatformStaff''', D),
    pg_temp.moded('^P0001\|ANSWERED:<null>$', '^P0001\|ANSWERED:true$'));
  PERFORM pg_temp.expect('1 god account', 'and not as a club owner (no club given back)', 'engine',
    format('SELECT public.get_commander_access_details(%L)->>''isClubOwner''', D), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('1 god account', 'no made-up venue or subscription', 'engine',
    format('SELECT (public.get_commander_access_details(%L)->''venueIds'')::text || '' '' || (public.get_commander_access_details(%L)->''subscriptionVenueIds'')::text', D, D),
    '^P0001\|ANSWERED:\[\] \[\]$');
  PERFORM pg_temp.expect('1 god account', 'has_commander_access, as the server asks', 'engine',
    format('SELECT public.has_commander_access(%L)::text', D),
    pg_temp.moded('^P0001\|ANSWERED:false$', '^P0001\|ANSWERED:true$'));
  PERFORM pg_temp.expect('1 god account', 'Commander access, asked for itself', 'D',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', D),
    pg_temp.moded('^P0001\|ANSWERED:false$', '^P0001\|ANSWERED:true$'));
  PERFORM pg_temp.expect('1 god account', 'has_commander_access, asked for itself', 'D',
    format('SELECT public.has_commander_access(%L)::text', D),
    pg_temp.moded('^P0001\|ANSWERED:false$', '^P0001\|ANSWERED:true$'));

  -- 2. an ordinary player is still refused, and cannot borrow the god account's answer
  PERFORM pg_temp.expect('2 player', 'Commander access, as the World Hub asks', 'engine',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', P), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'not platform staff', 'engine',
    format('SELECT COALESCE(public.get_commander_access_details(%L)->>''isPlatformStaff'', ''<absent>'')', P),
    pg_temp.moded('^P0001\|ANSWERED:<absent>$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('2 player', 'has_commander_access, as the server asks', 'engine',
    format('SELECT public.has_commander_access(%L)::text', P), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'Commander access, asked for itself', 'P',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', P), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'has_commander_access, asked for itself', 'P',
    format('SELECT public.has_commander_access(%L)::text', P), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'asking about the god account answers for the player', 'P',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', D), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'has_commander_access about the god account answers for the player', 'P',
    format('SELECT public.has_commander_access(%L)::text', D), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 player', 'no account at all', 'anon',
    format('SELECT public.get_commander_access_details(%L)->>''hasAccess''', D), '^42501\|permission denied for function get_commander_access_details$');

  -- 3. nobody else changes: every account, as the server asks
  PERFORM pg_temp.expect('3 every account', 'has_commander_access = the four ways in, or platform staff (fixed only)', 'engine',
    $q$SELECT count(*) FILTER (WHERE public.has_commander_access(p.id) IS DISTINCT FROM (
               EXISTS (SELECT 1 FROM public.clubs c WHERE c.owner_id = p.id)
            OR EXISTS (SELECT 1 FROM public.commander_subscriptions s WHERE s.owner_id = p.id)
            OR EXISTS (SELECT 1 FROM public.commander_staff cs WHERE (cs.user_id = p.id OR cs.linked_user_id = p.id)
                          AND cs.role IN ('owner','manager') AND cs.venue_id IS NOT NULL)
            OR EXISTS (SELECT 1 FROM public.commander_home_groups g WHERE g.owner_id = p.id)
            OR (current_setting('commander.mode') = 'fixed' AND p.role IN ('admin','superadmin','god'))))::text
       || ' mismatches of ' || count(*) || ', with access ' || count(*) FILTER (WHERE public.has_commander_access(p.id))
       FROM public.profiles p$q$,
    '^P0001\|ANSWERED:0 mismatches of [0-9]+, with access [0-9]+$');
  PERFORM pg_temp.expect('3 every account', 'the World Hub''s answer agrees with has_commander_access for every account', 'engine',
    $q$SELECT count(*) FILTER (WHERE (public.get_commander_access_details(p.id)->>'hasAccess')::boolean
                                   IS DISTINCT FROM public.has_commander_access(p.id))::text || ' of ' || count(*)
       FROM public.profiles p$q$,
    '^P0001\|ANSWERED:0 of [0-9]+$');
  PERFORM pg_temp.expect('3 every account', 'every platform staff account opens Commander', 'engine',
    $q$SELECT count(*) FILTER (WHERE NOT public.has_commander_access(p.id))::text || ' of ' || count(*)
       FROM public.profiles p WHERE p.role IN ('admin','superadmin','god')$q$,
    pg_temp.moded('^P0001\|ANSWERED:1 of 3$', '^P0001\|ANSWERED:0 of 3$'));
END $probes$;

-- ============================================================================
-- 4. THE ARENA KEEPS ITS OWNER, NOTHING MOVED, AND THE VERDICT
-- ============================================================================
DO $end$
DECLARE b record; v_bad text; v_n integer; v_ok integer; v_table text;
BEGIN
  SELECT * INTO b FROM pg_temp.base;
  INSERT INTO pg_temp.res(grp, label, who, ok, answer) VALUES
   ('4 arena', 'the arena still belongs to the system account', 'catalog',
      (SELECT owner_id FROM public.clubs WHERE asset = 'diamonds') = '00000000-0000-0000-0000-000000000001'::uuid
      AND b.arena_owner = '00000000-0000-0000-0000-000000000001'::uuid, b.arena_owner::text),
   ('4 arena', 'the god account owns no club', 'catalog',
      NOT EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = pg_temp.uid('D')), NULL),
   ('4 arena', 'the Diamond identity (register vs supply) is where it started', 'catalog',
      (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) = b.identity, b.identity::text);

  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_n, v_ok FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s | %s', grp, label, who, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END,
                           replace(COALESCE(answer, ''), E'\n', ' ')), E'\n' ORDER BY n)
    INTO v_table FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s', grp, label, who, answer), E'\n' ORDER BY n)
    INTO v_bad FROM pg_temp.res WHERE NOT ok;
  IF v_bad IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL OK [mode %]: % probes, every one as expected, in % ms%', current_setting('commander.mode'), v_n,
      round(extract(epoch FROM clock_timestamp() - now()) * 1000), E'\n' || v_table;
  END IF;
  RAISE EXCEPTION 'REHEARSAL NOT OK [mode %]: % probes, % as expected, % unexpected%', current_setting('commander.mode'),
    v_n, v_ok, v_n - v_ok, E'\n' || 'UNEXPECTED:' || E'\n' || v_bad || E'\n' || 'ALL:' || E'\n' || v_table;
END $end$;
