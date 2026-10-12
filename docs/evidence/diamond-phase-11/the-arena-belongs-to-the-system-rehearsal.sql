-- ============================================================================
-- THE ARENA BELONGS TO THE SYSTEM (production rehearsal)
-- ============================================================================
-- REHEARSAL ONLY. rehearse.sh runs the migration (or nothing, for the state
-- before it) and then this file against production as ONE transaction that ends
-- in a deliberate error (RAISE EXCEPTION 'REHEARSAL OK ...'), so NOTHING
-- persists. No CI runner loads this file. It is evidence, repeatable by hand:
--   rehearse.sh supabase/migrations/20260930235500_the_arena_belongs_to_the_system.sql \
--     docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system-rehearsal.sql <you>
--   rehearse.sh /dev/null docs/evidence/diamond-phase-11/the-arena-belongs-to-the-system-rehearsal.sql <you>
--
-- WHAT IT PROVES. The Diamond Arena's former owner is daniel@smarter.poker
-- (role god, 2d1cd6c3), the platform account Dan and the estate's scripts sign
-- in as. With the migration, every door that trusted a club's owner refuses
-- that account at the arena, and every Diamond staff door still admits it as
-- staff. The system account (00000000-...-0001) owns the arena, and nobody can
-- sign in as it. The arena cannot be handed back to a person. A chip hand is
-- opened exactly as before.
--
-- MODE is read from production, not set by hand. It is 'fixed' when the arena
-- belongs to the system account (the migration ran first) and 'baseline' when
-- it belongs to the former owner (nothing ran first). Any other owner stops the
-- run. The OK line names the mode, so a migration rehearsal that printed
-- [mode baseline] would be a failure.
--
-- HOW A PROBE RUNS. Each call runs in a subtransaction that always ends in an
-- error, so whatever the door did is undone as the probe ends. The door's
-- answer is carried out in the error text. The caller takes the real PostgREST
-- role (authenticated or service_role), so grants and row-level security are
-- the ones production enforces. The former owner and a synthetic player (a
-- hydra.bot account, not a horse) are given a session inside this transaction
-- only. No real session is read or used. Staff doors get deliberately invalid
-- input, so even a door that admits a caller refuses one step later and writes
-- nothing. No probe reaches a settlement lane: the cancellation door only ever
-- gets a null id.
--
-- REHEARSAL SAFETY: lock_timeout 2s, no DDL, no lane or advisory lock, a few
-- seconds of runtime. The only rows a probe touches are the arena's club row
-- (an UPDATE that changes nothing, and the refused owner change), each inside a
-- rolled-back probe.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
-- What a commit would check, checked as it happens: the migration's deferred
-- owner-wallet trigger, and every deferred trigger a probe queues.
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TEMP TABLE res(n serial PRIMARY KEY, grp text, label text, who text, ok boolean, answer text);

CREATE FUNCTION pg_temp.uid(p_who text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE split_part(p_who, '_', 1)
    WHEN 'D'   THEN '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid  -- the former owner: daniel@smarter.poker, role god
    WHEN 'P'   THEN '318a0d81-6e01-49a1-8884-e5a4c2697a2a'::uuid  -- a player (hydra.bot, not a horse)
    WHEN 'SYS' THEN '00000000-0000-0000-0000-000000000001'::uuid  -- the system account (never signs in)
  END;
$f$;
CREATE FUNCTION pg_temp.sid(p_uid uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT uuid_in(md5('arena-owner-session:' || p_uid::text)::cstring);
$f$;
CREATE FUNCTION pg_temp.arena() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT id FROM public.clubs WHERE asset = 'diamonds' AND is_platform IS TRUE AND union_id IS NULL;
$f$;

-- Become a caller, as PostgREST makes one. _nosid = a token with no session id;
-- 'catalog' stays the rehearsal owner (auth.users is not readable by a browser role).
CREATE FUNCTION pg_temp.become(p_who text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid := pg_temp.uid(p_who); v_claims jsonb;
BEGIN
  IF p_who = 'catalog' THEN RETURN; END IF;  -- the rehearsal owner reads the catalog
  IF p_who = 'engine' THEN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    PERFORM set_config('request.headers', '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}', true);
    SET LOCAL ROLE service_role;
    RETURN;
  END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unknown identity %', p_who; END IF;
  v_claims := jsonb_build_object('sub', v_uid, 'role', 'authenticated');
  IF split_part(p_who, '_', 2) <> 'nosid' THEN
    v_claims := v_claims || jsonb_build_object('session_id', pg_temp.sid(v_uid));
  END IF;
  PERFORM set_config('request.jwt.claims', v_claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', '{}', true);
  SET LOCAL ROLE authenticated;
END $f$;

-- One call, always rolled back: 'SQLSTATE|message'; a door that answered
-- instead of raising reads 'P0001|ANSWERED:<its answer>'.
CREATE FUNCTION pg_temp.probe(p_who text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_out text; v_state text; v_msg text; v_rows bigint;
BEGIN
  BEGIN
    PERFORM pg_temp.become(p_who);
    IF p_sql ~* '^\s*(insert|update|delete)' THEN
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows=' || v_rows;
    ELSE
      EXECUTE p_sql INTO v_out;
    END IF;
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

-- ============================================================================
-- THE SCENE (inside this rolled-back transaction only)
-- ============================================================================
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, not_after)
SELECT pg_temp.sid(pg_temp.uid(w)), pg_temp.uid(w), now(), now(), NULL
  FROM unnest(ARRAY['D','P']) w;

DO $scene$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.clubs WHERE id = pg_temp.arena();
  IF v_owner = pg_temp.uid('SYS') THEN
    PERFORM set_config('arena_owner.mode', 'fixed', true);
  ELSIF v_owner = pg_temp.uid('D') THEN
    PERFORM set_config('arena_owner.mode', 'baseline', true);
  ELSE
    RAISE EXCEPTION 'the arena is owned by %, which this rehearsal does not know', v_owner;
  END IF;
  IF (SELECT role FROM public.profiles WHERE id = pg_temp.uid('D')) <> 'god'
     OR (SELECT role FROM public.profiles WHERE id = pg_temp.uid('P')) <> 'user'
     OR (SELECT COALESCE(is_horse, false) FROM public.profiles WHERE id = pg_temp.uid('P'))
     OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id IN (pg_temp.uid('D'), pg_temp.uid('P'))
                   AND role IN ('owner','co_owner','admin','manager','super_agent','agent','sub_agent'))
     OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id = pg_temp.uid('SYS'))
     OR NOT EXISTS (SELECT 1 FROM public.club_members WHERE club_id = pg_temp.arena() AND user_id = pg_temp.uid('D')
                       AND role = 'player' AND status = 'automatic')
     OR pg_temp.arena() IS NULL THEN
    RAISE EXCEPTION 'the scene is not what this rehearsal assumes';
  END IF;
END $scene$;

CREATE FUNCTION pg_temp.moded(p_baseline text, p_fixed text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE current_setting('arena_owner.mode') WHEN 'fixed' THEN p_fixed ELSE p_baseline END;
$f$;

-- What must not move: read now, read again at the end.
CREATE TEMP TABLE base AS SELECT
  (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) AS identity,
  (SELECT sum(diamonds) FROM public.profiles WHERE id IN (pg_temp.uid('D'), pg_temp.uid('P'), pg_temp.uid('SYS'))) AS wallets,
  (SELECT count(*) FROM public.club_members WHERE club_id = pg_temp.arena()) AS arena_members,
  (SELECT count(*) FROM public.tables WHERE club_id = pg_temp.arena()) AS arena_tables,
  (SELECT count(*) FROM public.audit_trail WHERE club_id = pg_temp.arena()) AS arena_audit,
  (SELECT owner_id FROM public.clubs WHERE id = pg_temp.arena()) AS arena_owner;

-- ============================================================================
-- 1. A DOOR THAT TRUSTS A CLUB'S OWNER REFUSES THE FORMER OWNER AT THE ARENA
-- ============================================================================
DO $owner$
DECLARE
  v_arena uuid := pg_temp.arena(); D uuid := pg_temp.uid('D'); SYS uuid := pg_temp.uid('SYS');
  v_table uuid;
BEGIN
  SELECT t.id INTO STRICT v_table FROM public.tables t
   WHERE t.club_id = v_arena AND t.tournament_id IS NULL ORDER BY t.created_at LIMIT 1;
  PERFORM pg_temp.expect('1 owner doors', 'club control (the hand, rules and report doors'' test)', 'D',
    format('SELECT public.fn_ca_is_club_control(%L, %L)::text', v_arena, D),
    pg_temp.moded('^P0001\|ANSWERED:true$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('1 owner doors', 'club staff (fn_club_is_staff)', 'D',
    format('SELECT public.fn_club_is_staff(%L, %L)::text', v_arena, D),
    pg_temp.moded('^P0001\|ANSWERED:true$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('1 owner doors', 'club staff (fn_ca_is_club_staff)', 'D',
    format('SELECT public.fn_ca_is_club_staff(%L, %L)::text', v_arena, D),
    pg_temp.moded('^P0001\|ANSWERED:true$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('1 owner doors', 'club role (fn_club_role)', 'D',
    format('SELECT public.fn_club_role(%L, %L)', D, v_arena),
    pg_temp.moded('^P0001\|ANSWERED:owner$', '^P0001\|ANSWERED:player$'));
  PERFORM pg_temp.expect('1 owner doors', 'the role an audit row records (fn_ca_club_actor_role)', 'D',
    format('SELECT public.fn_ca_club_actor_role(%L, %L)', v_arena, D),
    pg_temp.moded('^P0001\|ANSWERED:owner$', '^P0001\|ANSWERED:player$'));
  PERFORM pg_temp.expect('1 owner doors', 'manage the club treasury (fn_actor_can_manage_club_treasury)', 'D',
    format('SELECT public.fn_actor_can_manage_club_treasury(%L)::text', v_arena),
    pg_temp.moded('^P0001\|ANSWERED:true$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('1 owner doors', 'the club integrity report (detect_suspicious_plays)', 'D',
    format('SELECT count(*)::text FROM public.detect_suspicious_plays(%L, 1)', v_arena),
    pg_temp.moded('^P0001\|ANSWERED:[0-9]+$', '^P0001\|not authorized for this club$'));
  PERFORM pg_temp.expect('1 owner doors', 'the arena''s audit rows, read through the API', 'D',
    format('SELECT count(*)::text FROM public.audit_trail WHERE club_id = %L', v_arena),
    pg_temp.moded('^P0001\|ANSWERED:[1-9][0-9]*$', '^P0001\|ANSWERED:0$'));
  PERFORM pg_temp.expect('1 owner doors', 'the arena''s club row, edited through the API (a write that changes nothing)', 'D',
    format('UPDATE public.clubs SET description = description WHERE id = %L', v_arena),
    pg_temp.moded('^P0001\|ANSWERED:rows=1$', '^P0001\|ANSWERED:rows=0$'));
  PERFORM pg_temp.expect('1 owner doors', 'a Diamond table''s bomb pot, through the chip door (invalid mode)', 'D',
    format('SELECT public.fn_update_table_bomb_settings(%L, ''{"bomb_pot_enabled": true, "bomb_pot_trigger_mode": "rehearsal"}''::jsonb)::text', v_table),
    pg_temp.moded('"reason": "bad_trigger_mode"', '"reason": "not_authorized"'));
  PERFORM pg_temp.expect('1 owner doors', 'Commander access through owning a club (World Hub''s check)', 'D',
    format('SELECT public.has_commander_access(%L)::text', D),
    pg_temp.moded('^P0001\|ANSWERED:true$', '^P0001\|ANSWERED:false$'));
  PERFORM pg_temp.expect('1 owner doors', 'the owner the doors now see is the system account', 'engine',
    format('SELECT COALESCE(public.fn_club_role(%L, %L), ''<none>'')', SYS, v_arena),
    pg_temp.moded('^P0001\|ANSWERED:<none>$', '^P0001\|ANSWERED:owner$'));
END $owner$;

-- ============================================================================
-- 2. EVERY DIAMOND STAFF DOOR STILL ADMITS HIM, AS STAFF
-- ============================================================================
-- The control answer is the refusal of the deliberately invalid input, one
-- step after the staff and live-session checks: the door let him in.
CREATE TEMP TABLE doors(k text PRIMARY KEY, sql text, control text);
INSERT INTO pg_temp.doors VALUES
 ('open a cash table', 'SELECT public.fn_poker_diamond_open_cash_table(''Arena Owner Probe'', 0, 2, 20, 200)::text',
   '^22023\|diamond_table_requires_whole_positive_stakes$'),
 ('edit a cash table', format('SELECT public.fn_poker_diamond_edit_cash_table(%L::uuid)::text', gen_random_uuid()),
   '^P0002\|diamond_table_not_found$'),
 ('close a cash table', format('SELECT public.fn_poker_diamond_close_cash_table(%L::uuid)::text', gen_random_uuid()),
   '^P0002\|diamond_table_not_found$'),
 ('switch straddles', format('SELECT public.fn_poker_diamond_set_table_straddle(%L::uuid, NULL, NULL)::text', gen_random_uuid()),
   '^22023\|diamond_straddle_requires_explicit_flags$'),
 ('switch run it twice', format('SELECT public.fn_poker_diamond_set_table_run_it_twice(%L::uuid, NULL)::text', gen_random_uuid()),
   '^22023\|diamond_run_it_twice_requires_an_explicit_flag$'),
 ('switch bomb pots', format('SELECT public.fn_poker_diamond_set_table_bomb_pot(%L::uuid, NULL)::text', gen_random_uuid()),
   '^22023\|diamond_bomb_pot_requires_an_explicit_flag$'),
 ('create a tournament', 'SELECT public.fn_poker_diamond_create_tournament(''[]''::jsonb)::text',
   '^22023\|diamond_tournament_requires_a_configuration$'),
 ('create a seat-first board', 'SELECT public.fn_poker_diamond_create_seat_first_board(''[]''::jsonb)::text',
   '^22023\|diamond_tournament_requires_a_configuration$'),
 ('cancel a tournament', 'SELECT public.fn_poker_diamond_cancel_tournament(NULL::uuid)::text',
   '^22004\|Tournament id is required$'),
 ('remove a registered player', 'SELECT public.fn_poker_diamond_remove_tournament_player(NULL::uuid, NULL::uuid, NULL::uuid)::text',
   '^22004\|tournament and player ids are required$'),
 ('propose a Diamond correction', 'SELECT public.fn_ca_diamond_adjustment_propose(''chips'', NULL, 1, ''arena owner probe'')::text',
   '"refused_reason": "not_a_diamond_target"'),
 ('approve a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_approve(%L::uuid, NULL)::text', gen_random_uuid()),
   '"refused_reason": "not_found"'),
 ('reject a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_reject(%L::uuid, NULL)::text', gen_random_uuid()),
   '"refused_reason": "not_found"'),
 ('settle a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_settle(%L::uuid)::text', gen_random_uuid()),
   '"refused_reason": "not_found"'),
 ('read the staff books', 'SELECT public.fn_ca_diamond_staff_books(''arena-owner-probe'')::text',
   '"refused_reason": "unknown_view"'),
 ('read the incident board', 'SELECT public.fn_ca_diamond_incident_board(''arena-owner-probe'')::text',
   '"error": "invalid_status"'),
 ('review an incident', 'SELECT public.fn_ca_diamond_incident_review(-1, ''arena-owner-probe'', NULL)::text',
   '"error": "unknown_action"'),
 ('read an incident trail', 'SELECT public.fn_ca_diamond_incident_trail(-1)::text',
   '"error": "incident_not_found"'),
 ('resolve an incident family', 'SELECT public.fn_ca_diamond_incident_resolve_family(NULL, NULL, NULL, NULL)::text',
   '"error": "family_required"');

DO $staff$
DECLARE d record; v_arena uuid := pg_temp.arena(); v_chip uuid;
  c_reason constant text := 'rehearsal: staff opens a Diamond hand';
BEGIN
  FOR d IN SELECT * FROM pg_temp.doors ORDER BY k LOOP
    PERFORM pg_temp.expect('2 staff doors', d.k, 'D', d.sql, d.control);
  END LOOP;
  PERFORM pg_temp.expect('2 staff doors', 'review a club''s integrity (fn_ca_can_review_integrity)', 'D',
    format('SELECT public.fn_ca_can_review_integrity(%L)::text', v_arena), '^P0001\|ANSWERED:true$');
  PERFORM pg_temp.expect('2 staff doors', 'see which players are horses (fn_can_see_horse_flag)', 'D',
    format('SELECT public.fn_can_see_horse_flag(%L)::text', v_arena), '^P0001\|ANSWERED:true$');
  -- the hand door: a Diamond hand opens to staff with a live session
  PERFORM pg_temp.expect('2 staff doors', 'open a Diamond hand (no such hand: admitted, then not found)', 'D',
    format('SELECT public.fn_ca_operator_read_hand(%L, -1, %L)::text', v_arena, c_reason),
    '^P0002\|no hand numbered -1$');
  PERFORM pg_temp.expect('2 staff doors', 'open a Diamond hand with a token that has no session', 'D_nosid',
    format('SELECT public.fn_ca_operator_read_hand(%L, -1, %L)::text', v_arena, c_reason),
    pg_temp.moded('^P0002\|no hand numbered -1$', '^28000\|diamond_staff_session_required$'));
  PERFORM pg_temp.expect('2 staff doors', 'open a Diamond hand as a player', 'P',
    format('SELECT public.fn_ca_operator_read_hand(%L, -1, %L)::text', v_arena, c_reason),
    pg_temp.moded('^42501\|only a club owner or admin may open a hand$', '^42501\|only platform staff may open a Diamond hand$'));
  -- a chip hand is opened as before: staff hold no chip club's control by being staff
  SELECT c.id INTO STRICT v_chip FROM public.clubs c WHERE c.id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4' AND c.asset = 'chips';
  PERFORM pg_temp.expect('2 staff doors', 'open a chip club''s hand (unchanged: club control only)', 'D',
    format('SELECT public.fn_ca_operator_read_hand(%L, -1, %L)::text', v_chip, c_reason),
    '^42501\|only a club owner or admin may open a hand$');
END $staff$;

-- ============================================================================
-- 3. THE ARENA CANNOT CHANGE HANDS
-- ============================================================================
-- Before: the owner-wallet trigger refuses ANY new owner (it would give the
-- new owner an 'owner' membership, which the arena's guard refuses). After: the
-- arena guard refuses any owner but the system account, by name.
DO $hands$
DECLARE v_arena uuid := pg_temp.arena();
BEGIN
  PERFORM pg_temp.expect('3 hands', 'the arena handed to another account, by the server', 'engine',
    format('UPDATE public.clubs SET owner_id = %L WHERE id = %L',
           pg_temp.moded(pg_temp.uid('SYS')::text, pg_temp.uid('D')::text), v_arena),
    pg_temp.moded('^23514\|Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy$',
                  '^23514\|The Diamond Arena Belongs To The System$'));
  PERFORM pg_temp.expect('3 hands', 'the system account cannot sign in: no password, provider, session or token, never signed in', 'catalog',
    format('SELECT (COALESCE(u.encrypted_password, '''') = '''' AND u.last_sign_in_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id)
              AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.user_id = u.id)
              AND NOT EXISTS (SELECT 1 FROM auth.refresh_tokens t WHERE t.user_id = u.id::text))::text
              FROM auth.users u WHERE u.id = %L', pg_temp.uid('SYS')),
    '^P0001\|ANSWERED:true$');
END $hands$;

-- ============================================================================
-- 4. NOTHING MOVED, AND THE VERDICT
-- ============================================================================
DO $end$
DECLARE b record; v_now record; v_bad text; v_n integer; v_ok integer; v_table text;
BEGIN
  SELECT * INTO b FROM pg_temp.base;
  SELECT
    (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) AS identity,
    (SELECT sum(diamonds) FROM public.profiles WHERE id IN (pg_temp.uid('D'), pg_temp.uid('P'), pg_temp.uid('SYS'))) AS wallets,
    (SELECT count(*) FROM public.club_members WHERE club_id = pg_temp.arena()) AS arena_members,
    (SELECT count(*) FROM public.tables WHERE club_id = pg_temp.arena()) AS arena_tables,
    (SELECT count(*) FROM public.audit_trail WHERE club_id = pg_temp.arena()) AS arena_audit,
    (SELECT owner_id FROM public.clubs WHERE id = pg_temp.arena()) AS arena_owner
  INTO v_now;
  INSERT INTO pg_temp.res(grp, label, who, ok, answer) VALUES
   ('4 nothing moved', 'the Diamond identity (register vs supply) is where it started', 'catalog',
      v_now.identity = b.identity, format('%s -> %s', b.identity, v_now.identity)),
   ('4 nothing moved', 'no identity''s wallet moved', 'catalog', v_now.wallets = b.wallets, format('%s -> %s', b.wallets, v_now.wallets)),
   ('4 nothing moved', 'no arena membership, table or audit row was written, and the owner is where the mode says', 'catalog',
      (v_now.arena_members, v_now.arena_tables, v_now.arena_audit, v_now.arena_owner)
        = (b.arena_members, b.arena_tables, b.arena_audit, b.arena_owner)
      AND v_now.arena_owner = pg_temp.moded(pg_temp.uid('D')::text, pg_temp.uid('SYS')::text)::uuid,
      format('%s / %s', row(b.arena_members, b.arena_tables, b.arena_audit, b.arena_owner),
                        row(v_now.arena_members, v_now.arena_tables, v_now.arena_audit, v_now.arena_owner))),
   ('4 nothing moved', 'both Diamond switches are still closed', 'catalog',
      NOT EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled), NULL);

  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_n, v_ok FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s | %s', grp, label, who, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END,
                           replace(COALESCE(answer, ''), E'\n', ' ')), E'\n' ORDER BY n)
    INTO v_table FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s', grp, label, who, answer), E'\n' ORDER BY n)
    INTO v_bad FROM pg_temp.res WHERE NOT ok;
  IF v_bad IS NULL THEN
    RAISE EXCEPTION 'REHEARSAL OK [mode %]: % probes, every one as expected, in % ms%', current_setting('arena_owner.mode'), v_n,
      round(extract(epoch FROM clock_timestamp() - now()) * 1000), E'\n' || v_table;
  END IF;
  RAISE EXCEPTION 'REHEARSAL NOT OK [mode %]: % probes, % as expected, % unexpected%', current_setting('arena_owner.mode'),
    v_n, v_ok, v_n - v_ok, E'\n' || 'UNEXPECTED:' || E'\n' || v_bad || E'\n' || 'ALL:' || E'\n' || v_table;
END $end$;
