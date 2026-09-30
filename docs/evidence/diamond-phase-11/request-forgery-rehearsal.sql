-- ============================================================================
-- DIAMOND PHASE 11, LINE 1 - A FORGED REQUEST IS REFUSED (production rehearsal)
-- ============================================================================
-- REHEARSAL ONLY. Run by rehearse.sh (an empty migration, or the migration
-- under test, first) against production as ONE transaction that ends in a
-- deliberate error (RAISE EXCEPTION 'REHEARSAL OK ...'), so NOTHING persists.
-- No CI runner loads this file; it is evidence, repeatable by hand:
--   rehearse.sh /dev/null docs/evidence/diamond-phase-11/request-forgery-rehearsal.sql <you>
--
-- WHAT IT DOES. Calls every Diamond door a browser can reach - and the chip
-- doors a Diamond-shaped request can reach - as the identities a forger has:
-- no account (anon), an ordinary player, a chip-club super agent, and a staff
-- member whose token is signed out, has no session id, or whose session has
-- expired; with a live staff session as the control. Each call is refused by
-- name or it is a failure of this file.
--
-- EVERY PROBE IS ROLLED BACK ON ITS OWN. pg_temp.probe() runs the call in a
-- subtransaction that ALWAYS ends in an error, so whatever the door did - a
-- row lock, a receipt row, an advisory lock - is released the moment the
-- probe ends, and the door's answer is carried out in the error text. The
-- caller becomes the real PostgREST role (anon, authenticated or
-- service_role), so grants and row-level security are the ones production
-- enforces. No probe names a live player's row: the player, second player and
-- staff identities are idle synthetic accounts (hydra.bot, not horses) given a
-- session (and, for staff, the admin role) inside this transaction only; the
-- chip super agent is a synthetic horse used only where the door refuses
-- before it reads a row. Staff probes pass deliberately invalid input, so even
-- a door that wrongly admits a caller refuses one step later and writes
-- nothing. No probe reaches a settlement lane: the cancellation door is only
-- ever called with a null id or by a caller refused before its lane.
--
-- MODES (forgery.mode, set below):
--   baseline - production before 20260930120000: the three holes that
--              migration closes are asserted AS HOLES (a signed-out staff token
--              passes fourteen staff doors; the Diamond Arena is a club-games
--              host; a non-staff "management" caller reads another host's
--              games), so the run documents exactly what was open.
--   fixed    - with 20260930120000 applied (or rehearsed ahead of this file):
--              every one of those probes is refused by name.
-- Every other probe expects the same refusal in both modes.
--
-- REHEARSAL SAFETY (the 2026-09-29 rules): lock_timeout 2s; no DDL; no lane
-- or advisory lock is taken except by a door's own first steps inside a
-- rolled-back probe; runtime a few seconds.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SELECT set_config('forgery.mode', 'baseline', true);

CREATE TEMP TABLE res(n serial PRIMARY KEY, grp text, label text, who text, ok boolean, answer text);

-- The identities. Every uuid is a synthetic account; see the header.
CREATE FUNCTION pg_temp.uid(p_who text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE split_part(p_who, '_', 1)
    WHEN 'P'  THEN '318a0d81-6e01-49a1-8884-e5a4c2697a2a'::uuid  -- player (hydra.bot, not a horse)
    WHEN 'Q'  THEN 'ef85701b-c632-4233-ba43-1e9e46e31b86'::uuid  -- a second player (hydra.bot, not a horse)
    WHEN 'S'  THEN 'a27bd2d8-ff2b-4a8f-87aa-d64fb43b10cf'::uuid  -- staff: made admin in this transaction only
    WHEN 'AG' THEN '00000000-0000-0000-0000-000000000002'::uuid  -- chip-club super agent (synthetic horse)
  END;
$f$;
CREATE FUNCTION pg_temp.sid(p_uid uuid, p_kind text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT uuid_in(md5('forgery-session:' || p_kind || ':' || p_uid::text)::cstring);
$f$;
CREATE FUNCTION pg_temp.arena() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT id FROM public.clubs WHERE asset = 'diamonds' AND is_platform IS TRUE AND union_id IS NULL;
$f$;

-- Become a caller, as PostgREST makes one. Suffixes: _out = the token's
-- session was signed out (no auth.sessions row), _nosid = a token with no
-- session_id claim, _exp = the session row's not_after has passed, _def = the
-- caller's claims inside a definer body (role not switched: what a SECURITY
-- DEFINER door sees when it writes for this caller).
CREATE FUNCTION pg_temp.become(p_who text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_uid uuid := pg_temp.uid(p_who); v_kind text := split_part(p_who, '_', 2); v_claims jsonb;
BEGIN
  IF p_who = 'anon' THEN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    PERFORM set_config('request.headers', '{}', true);
    SET LOCAL ROLE anon;
    RETURN;
  END IF;
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
  IF v_kind = 'out' THEN
    v_claims := v_claims || jsonb_build_object('session_id', pg_temp.sid(v_uid, 'signed-out'));
  ELSIF v_kind = 'exp' THEN
    v_claims := v_claims || jsonb_build_object('session_id', pg_temp.sid(v_uid, 'expired'));
  ELSIF v_kind <> 'nosid' THEN
    v_claims := v_claims || jsonb_build_object('session_id', pg_temp.sid(v_uid, 'live'));
  END IF;
  PERFORM set_config('request.jwt.claims', v_claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', '{}', true);
  IF v_kind <> 'def' THEN
    SET LOCAL ROLE authenticated;
  END IF;
END $f$;

-- One call, always rolled back: 'SQLSTATE|message', where a door that answered
-- instead of raising reads 'P0001|ANSWERED:<its answer>'. p_setup runs first,
-- as the rehearsal owner, inside the same rolled-back subtransaction.
CREATE FUNCTION pg_temp.probe(p_who text, p_sql text, p_setup text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v_out text; v_state text; v_msg text; v_rows bigint;
BEGIN
  BEGIN
    IF p_setup IS NOT NULL THEN EXECUTE p_setup; END IF;
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

-- Record one expectation: the answer must match p_expect (a regex). A NULL
-- expectation is a discovery probe (recorded, never enforced).
CREATE FUNCTION pg_temp.expect(p_grp text, p_label text, p_who text, p_sql text, p_expect text, p_setup text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE v_ans text := pg_temp.probe(p_who, p_sql, p_setup); v_ok boolean;
BEGIN
  v_ok := p_expect IS NULL OR v_ans ~ p_expect;
  INSERT INTO pg_temp.res(grp, label, who, ok, answer)
  VALUES (p_grp, p_label || CASE WHEN p_expect IS NULL THEN ' [discovery]' ELSE '' END, p_who, v_ok, left(v_ans, 400));
  RETURN v_ok;
END $f$;
-- The expectation that depends on the mode.
CREATE FUNCTION pg_temp.moded(p_baseline text, p_fixed text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE current_setting('forgery.mode') WHEN 'fixed' THEN p_fixed ELSE p_baseline END;
$f$;

-- ============================================================================
-- THE SCENE (inside this rolled-back transaction only)
-- ============================================================================
-- A live session for each identity; one staff session that has expired. The
-- signed-out session is simply a session id with no row, which is what GoTrue
-- leaves behind a sign-out.
INSERT INTO auth.sessions (id, user_id, created_at, updated_at, not_after)
SELECT pg_temp.sid(pg_temp.uid(w), 'live'), pg_temp.uid(w), now(), now(), NULL
  FROM unnest(ARRAY['P','Q','S','AG']) w
UNION ALL
SELECT pg_temp.sid(pg_temp.uid('S'), 'expired'), pg_temp.uid('S'), now() - interval '2 hours',
       now() - interval '2 hours', now() - interval '1 minute';
DO $scene$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  UPDATE public.profiles SET role = 'admin' WHERE id = pg_temp.uid('S');
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  IF (SELECT role FROM public.profiles WHERE id = pg_temp.uid('S')) <> 'admin'
     OR (SELECT role FROM public.profiles WHERE id = pg_temp.uid('P')) <> 'user'
     OR (SELECT role FROM public.profiles WHERE id = pg_temp.uid('Q')) <> 'user'
     OR (SELECT role FROM public.profiles WHERE id = pg_temp.uid('AG')) <> 'user'
     OR NOT EXISTS (SELECT 1 FROM public.club_members WHERE user_id = pg_temp.uid('AG') AND role = 'super_agent')
     OR EXISTS (SELECT 1 FROM public.club_members WHERE user_id IN (pg_temp.uid('P'), pg_temp.uid('Q'), pg_temp.uid('S'))
                   AND role IN ('owner','co_owner','admin','super_agent','agent','sub_agent'))
     OR EXISTS (SELECT 1 FROM public.ca_incident_recipients WHERE user_id IN (pg_temp.uid('P'), pg_temp.uid('Q')))
     OR pg_temp.arena() IS NULL THEN
    RAISE EXCEPTION 'the scene is not what this rehearsal assumes';
  END IF;
END $scene$;

-- What must not move: read now, read again at the end.
CREATE TEMP TABLE base AS SELECT
  (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) AS identity,
  (SELECT sum(diamonds) FROM public.profiles WHERE id IN (pg_temp.uid('P'), pg_temp.uid('Q'), pg_temp.uid('S'), pg_temp.uid('AG'))) AS wallets,
  (SELECT count(*) FROM public.club_members WHERE club_id = pg_temp.arena()) AS arena_members,
  (SELECT count(*) FROM public.tables WHERE club_id = pg_temp.arena()) AS arena_tables,
  (SELECT count(*) FROM public.tournaments WHERE club_id = pg_temp.arena()) AS arena_events,
  (SELECT count(*) FROM public.poker_diamond_custody) AS custody_rows,
  (SELECT count(*) FROM public.ca_manual_adjustments) AS adjustments,
  (SELECT count(*) FROM public.ca_diamond_incident_events) AS incident_events,
  (SELECT count(*) FROM public.diamond_game_configs WHERE host_id = pg_temp.arena())
    + (SELECT count(*) FROM public.wheel_configs WHERE host_id = pg_temp.arena()) AS arena_games,
  (SELECT count(*) FROM public.entry_purchase_idempotency_receipts) AS purchase_receipts;

-- ============================================================================
-- 1. MANAGEMENT: EVERY DIAMOND STAFF DOOR, EVERY IDENTITY A FORGER HAS
-- ============================================================================
-- anon            no account: no EXECUTE grant, refused by the database itself
-- P, AG           a player and a chip-club super agent: refused by the staff check
-- S               staff with a live session: the CONTROL - gets past both checks
--                 and is refused by the deliberately invalid input one step later
-- S_out/_nosid/_exp  staff whose token is signed out / has no session id / whose
--                 session expired: refused by name (baseline: the fourteen doors
--                 that did not ask answer like the control - the hole)
CREATE TEMP TABLE doors(k text PRIMARY KEY, sql text, nonstaff text, control text, style text, asked_before boolean);
INSERT INTO pg_temp.doors VALUES
 ('open a cash table', 'SELECT public.fn_poker_diamond_open_cash_table(''Forgery Probe'', 0, 2, 20, 200)::text',
   '^42501\|diamond_table_staff_only$', '^22023\|diamond_table_requires_whole_positive_stakes$', 'raise', false),
 ('edit a cash table', format('SELECT public.fn_poker_diamond_edit_cash_table(%L::uuid)::text', gen_random_uuid()),
   '^42501\|diamond_table_staff_only$', '^P0002\|diamond_table_not_found$', 'raise', true),
 ('close a cash table', format('SELECT public.fn_poker_diamond_close_cash_table(%L::uuid)::text', gen_random_uuid()),
   '^42501\|diamond_table_staff_only$', '^P0002\|diamond_table_not_found$', 'raise', true),
 ('switch straddles', format('SELECT public.fn_poker_diamond_set_table_straddle(%L::uuid, NULL, NULL)::text', gen_random_uuid()),
   '^42501\|diamond_table_staff_only$', '^22023\|diamond_straddle_requires_explicit_flags$', 'raise', false),
 ('switch run it twice', format('SELECT public.fn_poker_diamond_set_table_run_it_twice(%L::uuid, NULL)::text', gen_random_uuid()),
   '^42501\|diamond_table_staff_only$', '^22023\|diamond_run_it_twice_requires_an_explicit_flag$', 'raise', false),
 ('switch bomb pots', format('SELECT public.fn_poker_diamond_set_table_bomb_pot(%L::uuid, NULL)::text', gen_random_uuid()),
   '^42501\|diamond_table_staff_only$', '^22023\|diamond_bomb_pot_requires_an_explicit_flag$', 'raise', false),
 ('create a tournament', 'SELECT public.fn_poker_diamond_create_tournament(''[]''::jsonb)::text',
   '^42501\|diamond_tournament_staff_only$', '^22023\|diamond_tournament_requires_a_configuration$', 'raise', false),
 ('create a seat-first board', 'SELECT public.fn_poker_diamond_create_seat_first_board(''[]''::jsonb)::text',
   '^42501\|diamond_tournament_staff_only$', '^22023\|diamond_tournament_requires_a_configuration$', 'raise', true),
 ('cancel a tournament', 'SELECT public.fn_poker_diamond_cancel_tournament(NULL::uuid)::text',
   '^42501\|diamond_tournament_staff_only$', '^22004\|Tournament id is required$', 'raise', true),
 ('remove a registered player', 'SELECT public.fn_poker_diamond_remove_tournament_player(NULL::uuid, NULL::uuid, NULL::uuid)::text',
   '^42501\|diamond_tournament_staff_only$', '^22004\|tournament and player ids are required$', 'raise', true),
 ('propose a Diamond correction', 'SELECT public.fn_ca_diamond_adjustment_propose(''chips'', NULL, 1, ''forgery probe'')::text',
   '"refused_reason": "platform_staff_only"', '"refused_reason": "not_a_diamond_target"', 'ok', false),
 ('approve a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_approve(%L::uuid, NULL)::text', gen_random_uuid()),
   '"refused_reason": "platform_staff_only"', '"refused_reason": "not_found"', 'ok', false),
 ('reject a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_reject(%L::uuid, NULL)::text', gen_random_uuid()),
   '"refused_reason": "platform_staff_only"', '"refused_reason": "not_found"', 'ok', false),
 ('settle a Diamond correction', format('SELECT public.fn_ca_diamond_adjustment_settle(%L::uuid)::text', gen_random_uuid()),
   '"refused_reason": "platform_staff_only"', '"refused_reason": "not_found"', 'ok', false),
 ('read the staff books', 'SELECT public.fn_ca_diamond_staff_books(''forgery-probe'')::text',
   '"refused_reason": "platform_staff_only"', '"refused_reason": "unknown_view"', 'ok', false),
 ('read the incident board', 'SELECT public.fn_ca_diamond_incident_board(''forgery-probe'')::text',
   '"error": "staff_required"', '"error": "invalid_status"', 'success', false),
 ('review an incident', 'SELECT public.fn_ca_diamond_incident_review(-1, ''forgery-probe'', NULL)::text',
   '"error": "staff_required"', '"error": "unknown_action"', 'success', false),
 ('read an incident trail', 'SELECT public.fn_ca_diamond_incident_trail(-1)::text',
   '"error": "staff_required"', '"error": "incident_not_found"', 'success', false),
 ('resolve an incident family', 'SELECT public.fn_ca_diamond_incident_resolve_family(NULL, NULL, NULL, NULL)::text',
   '"error": "staff_required"', '"error": "family_required"', 'success', false);

DO $staff$
DECLARE d record; w text; v_dead text;
BEGIN
  FOR d IN SELECT * FROM pg_temp.doors ORDER BY k LOOP
    v_dead := CASE d.style WHEN 'raise' THEN '^28000\|diamond_staff_session_required$'
                           ELSE 'ANSWERED:.*"diamond_staff_session_required"' END;
    PERFORM pg_temp.expect('1 staff', d.k || ': no account', 'anon', d.sql, '^42501\|permission denied for function ');
    PERFORM pg_temp.expect('1 staff', d.k || ': a player', 'P', d.sql, d.nonstaff);
    PERFORM pg_temp.expect('1 staff', d.k || ': a chip-club super agent', 'AG', d.sql, d.nonstaff);
    PERFORM pg_temp.expect('1 staff', d.k || ': staff, live session (control)', 'S', d.sql, d.control);
    FOREACH w IN ARRAY ARRAY['S_out','S_nosid','S_exp'] LOOP
      PERFORM pg_temp.expect('1 staff', d.k || ': staff, ' || CASE w WHEN 'S_out' THEN 'signed-out token'
                                 WHEN 'S_nosid' THEN 'token without a session id' ELSE 'expired session' END,
        w, d.sql, CASE WHEN d.asked_before THEN v_dead ELSE pg_temp.moded(d.control, v_dead) END);
    END LOOP;
  END LOOP;
END $staff$;

-- ============================================================================
-- 2..6: CROSS-ASSET MONEY, MEMBERSHIP, MEMBER DATA, CLUB GAMES, ENGINE DOORS
-- ============================================================================
DO $rest$
DECLARE
  v_arena uuid := pg_temp.arena();
  v_table uuid;          -- an idle Diamond cash table (the switch is closed: nobody sits)
  v_chip_club uuid;      -- a chip club
  v_chip_table uuid;     -- a closed chip cash table
  v_chip_event uuid;     -- a finished chip tournament
  v_union uuid;          -- a union
  v_game_club uuid;      -- a chip club whose host keeps club games
  v_stranger_club uuid;  -- a chip club the super agent does not belong to
  P uuid := pg_temp.uid('P'); Q uuid := pg_temp.uid('Q'); AG uuid := pg_temp.uid('AG');
  v_mgmt text;           -- makes the player an incident recipient, inside one probe only
  fn text;
BEGIN
  SELECT t.id INTO v_table FROM public.tables t
   WHERE t.club_id = v_arena AND t.tournament_id IS NULL AND t.status = 'waiting'
     AND COALESCE(t.current_players, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id = t.id AND s.left_at IS NULL)
   ORDER BY t.created_at LIMIT 1;
  SELECT c.id INTO v_chip_club FROM public.clubs c WHERE c.asset = 'chips' ORDER BY c.created_at LIMIT 1;
  SELECT t.id INTO v_chip_table FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE c.asset = 'chips' AND t.tournament_id IS NULL AND t.status = 'closed' ORDER BY t.created_at LIMIT 1;
  SELECT t.id INTO v_chip_event FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
   WHERE c.asset = 'chips' AND t.status IN ('COMPLETED','CANCELLED') AND t.updated_at < now() - interval '1 day'
   ORDER BY t.updated_at DESC LIMIT 1;
  SELECT u.id INTO v_union FROM public.unions u ORDER BY u.created_at LIMIT 1;
  SELECT c.id INTO v_game_club FROM public.clubs c
   WHERE c.asset = 'chips' AND COALESCE(c.union_id, c.id) IN (SELECT host_id FROM public.diamond_game_configs)
   ORDER BY c.created_at LIMIT 1;
  SELECT c.id INTO v_stranger_club FROM public.clubs c
   WHERE c.asset = 'chips' AND NOT EXISTS (SELECT 1 FROM public.club_members m WHERE m.club_id = c.id AND m.user_id = AG)
   ORDER BY c.created_at LIMIT 1;
  IF v_table IS NULL OR v_chip_club IS NULL OR v_chip_table IS NULL OR v_chip_event IS NULL
     OR v_union IS NULL OR v_game_club IS NULL THEN
    RAISE EXCEPTION 'the rehearsal could not find its targets';
  END IF;
  v_mgmt := format('INSERT INTO public.ca_incident_recipients (user_id, scope, active) VALUES (%L, %L, true)', P, 'platform');

  -- --------------------------------------------------------------------------
  -- 2. CROSS-ASSET MONEY: Diamond doors given chip words, chip doors given
  --    Diamond ids, and doors called for somebody else
  -- --------------------------------------------------------------------------
  PERFORM pg_temp.expect('2 money', 'buy-in: a chip club named against a Diamond table (the closed switch refuses first; the arena check is proved in CI)', 'P',
    format('SELECT public.atomic_table_buyin(%L, %L, 1, 100, false, %L, %L)::text', P, v_table, v_chip_club, gen_random_uuid()),
    '^55000\|diamond_cash_not_open$');
  PERFORM pg_temp.expect('2 money', 'buy-in: for another player', 'P',
    format('SELECT public.atomic_table_buyin(%L, %L, 1, 100, false, NULL, %L)::text', Q, v_table, gen_random_uuid()),
    '^42501\|Cannot buy in for another user$');
  PERFORM pg_temp.expect('2 money', 'buy-in: from a signed-out token', 'P_out',
    format('SELECT public.atomic_table_buyin(%L, %L, 1, 100, false, NULL, %L)::text', P, v_table, gen_random_uuid()),
    '^28000\|SESSION_REVOKED');
  PERFORM pg_temp.expect('2 money', 'buy-in: a fraction of a cent', 'P',
    format('SELECT public.atomic_table_buyin(%L, %L, 1, 100.005, false, NULL, %L)::text', P, v_table, gen_random_uuid()),
    '^22003\|Chips Move In Hundredths At Most$');
  PERFORM pg_temp.expect('2 money', 'the chip rebuy door at a Diamond table', 'P',
    format('SELECT public.atomic_table_rebuy(%L, %L, 100, %L)::text', P, v_table, gen_random_uuid()),
    'Player not seated at this table');
  PERFORM pg_temp.expect('2 money', 'the chip rebuy door for another player', 'P',
    format('SELECT public.atomic_table_rebuy(%L, %L, 100, %L)::text', Q, v_table, gen_random_uuid()),
    '^42501\|Cannot rebuy for another player$');
  PERFORM pg_temp.expect('2 money', 'the chip cash-out door at a Diamond table, from a browser', 'P',
    format('SELECT public.fn_cashout_seat_occupancy(%L, %L, 1, %L, %L)::text', P, v_table, gen_random_uuid(), 'voluntary'),
    'Engine authority required');
  PERFORM pg_temp.expect('2 money', 'leave-and-refund at a Diamond table where the caller has no seat', 'P',
    format('SELECT public.fn_leave_seat_and_refund(%L, %L)::text', v_table, gen_random_uuid()), NULL);
  PERFORM pg_temp.expect('2 money', 'chips minted into the Diamond Arena by a player', 'P',
    format('SELECT public.fn_mint_chips_from_diamonds(%L, 100, %L)::text', v_arena, gen_random_uuid()),
    'Only The Club Owner Or An Admin May Mint Chips');
  PERFORM pg_temp.expect('2 money', 'chips minted into the Diamond Arena by staff', 'S',
    format('SELECT public.fn_mint_chips_from_diamonds(%L, 100, %L)::text', v_arena, gen_random_uuid()),
    'Only The Club Owner Or An Admin May Mint Chips');
  PERFORM pg_temp.expect('2 money', 'any chip treasury on the Diamond Arena, by any door (the service role writes it)', 'engine',
    format('UPDATE public.clubs SET chip_treasury = 1 WHERE id = %L', v_arena), 'poker_arena_diamond_identity');
  PERFORM pg_temp.expect('2 money', 'a promo balance on the Diamond Arena, by any door', 'engine',
    format('UPDATE public.clubs SET promo_balance = 1 WHERE id = %L', v_arena), 'poker_arena_diamond_identity');
  PERFORM pg_temp.expect('2 money', 'a Diamond table rewritten by a definer door acting for a player', 'P_def',
    format('UPDATE public.tables SET name = name || %L WHERE id = %L', ' ', v_table), 'Diamond Games Require Platform Operations');
  PERFORM pg_temp.expect('2 money', 'a Diamond table rewritten straight through the API', 'P',
    format('UPDATE public.tables SET name = %L WHERE id = %L', 'forged', v_table), '^P0001\|ANSWERED:rows=0$');
  PERFORM pg_temp.expect('2 money', 'a chip table id at a Diamond staff door', 'S',
    format('SELECT public.fn_poker_diamond_close_cash_table(%L)::text', v_chip_table), '^P0002\|diamond_table_not_found$');
  PERFORM pg_temp.expect('2 money', 'a chip tournament is not a Diamond tournament to any Diamond event door', 'engine',
    format('SELECT public.fn_poker_diamond_tournament(%L)::text', v_chip_event), '^P0001\|ANSWERED:false$');
  PERFORM pg_temp.expect('2 money', 'a tournament rebuy bought for another player', 'P',
    format('SELECT public.process_tournament_rebuy(%L, %L, %L, 1, 1)::text', v_chip_event, Q, 'rebuy'), NULL);
  PERFORM pg_temp.expect('2 money', 'a transfer to somebody who is not a friend', 'P',
    format('SELECT public.send_wallet_diamond_transfer(%L, 1, NULL, %L)::text', Q, 'forgery-probe-000001'),
    'accepted_friend_required');
  PERFORM pg_temp.expect('2 money', 'a transfer to oneself', 'P',
    format('SELECT public.send_wallet_diamond_transfer(%L, 1, NULL, %L)::text', P, 'forgery-probe-000002'),
    '^22023\|invalid_transfer_request$');
  PERFORM pg_temp.expect('2 money', 'a negative transfer', 'P',
    format('SELECT public.send_wallet_diamond_transfer(%L, -5, NULL, %L)::text', Q, 'forgery-probe-000003'),
    '^22023\|invalid_transfer_request$');
  PERFORM pg_temp.expect('2 money', 'a transfer from a signed-out token', 'P_out',
    format('SELECT public.send_wallet_diamond_transfer(%L, 1, NULL, %L)::text', Q, 'forgery-probe-000004'),
    '^42501\|authentication_required$');
  FOREACH fn IN ARRAY ARRAY[
    format('SELECT public.fn_poker_diamond_top_up(%L, %L, 10, 0, %L)::text', P, v_table, gen_random_uuid()),
    format('SELECT public.fn_poker_diamond_buyin(%L, %L, 1, 100, false, NULL, %L)::text', P, v_table, gen_random_uuid()),
    format('SELECT public.fn_poker_diamond_cashout(%L, %L, 1)::text', P, v_table),
    format('SELECT public.fn_poker_diamond_settle_cash_hand(%L, 1, %L::jsonb, 0, 0, %L, 0)::text', v_table, '[]', 'forged'),
    format('SELECT public.fn_poker_diamond_reserve(%L, %L, %L, %L, 1, %L)::text', P, 'cash_seat', v_table, 'forged', gen_random_uuid()),
    format('SELECT public.fn_poker_diamond_release(%L, %L)::text', gen_random_uuid(), gen_random_uuid()),
    format('SELECT public.fn_poker_diamond_tournament_charge(%L, %L, %L, 1, 1, 0, 0, NULL, %L)::text', P, gen_random_uuid(), 'rebuy', 'forged'),
    format('SELECT public.fn_poker_diamond_tournament_pay(%L, 1, %L, %L, %L, %L)::text', P, 'forged', 'prize', gen_random_uuid(), 'forged')]
  LOOP
    PERFORM pg_temp.expect('2 money', 'an engine-only Diamond money door, from a browser: ' || substring(fn from 'public\.([a-z_]+)\('),
      'P', fn, '^42501\|permission denied for function ');
  END LOOP;

  -- --------------------------------------------------------------------------
  -- 3. MEMBERSHIP: joining, approving, inviting, and the hierarchy Phase 2 forbids
  -- --------------------------------------------------------------------------
  PERFORM pg_temp.expect('3 membership', 'the chip join door, pointed at the Diamond Arena', 'P',
    format('SELECT public.fn_join_club(%L)::text', v_arena), NULL);
  PERFORM pg_temp.expect('3 membership', 'the atomic join door, pointed at the Diamond Arena', 'P',
    format('SELECT public.fn_join_club_atomic(%L, %L, NULL)::text', v_arena::text, gen_random_uuid()), NULL);
  PERFORM pg_temp.expect('3 membership', 'the join preview, pointed at the Diamond Arena', 'P',
    format('SELECT public.fn_preview_club_join(%L)::text', v_arena::text), NULL);
  PERFORM pg_temp.expect('3 membership', 'an invite code redeemed into the Diamond Arena', 'P',
    format('SELECT public.fn_redeem_club_invite_code(%L, %L, %L)::text', v_arena, P, 'FORGERY01'), NULL);
  PERFORM pg_temp.expect('3 membership', 'an invite code redeemed for somebody else', 'P',
    format('SELECT public.fn_redeem_club_invite_code(%L, %L, %L)::text', v_arena, Q, 'FORGERY01'), 'not_your_membership');
  PERFORM pg_temp.expect('3 membership', 'a join request approved in the Diamond Arena by a player', 'P',
    format('SELECT public.fn_review_join_request(%L, %L, true)::text', v_arena, Q), 'Not authorized to review join requests for this club');
  PERFORM pg_temp.expect('3 membership', 'a join request approved in the Diamond Arena by a chip-club super agent', 'AG',
    format('SELECT public.fn_review_join_request(%L, %L, true)::text', v_arena, P), 'Not authorized to review join requests for this club');
  PERFORM pg_temp.expect('3 membership', 'a join request cancelled in the Diamond Arena', 'P',
    format('SELECT public.fn_cancel_club_join_request(%L)::text', v_arena), NULL);
  PERFORM pg_temp.expect('3 membership', 'a membership row written straight through the API (the automatic shape)', 'P',
    format('INSERT INTO public.club_members (club_id, user_id, role, status) VALUES (%L, %L, %L, %L)', v_arena, P, 'player', 'automatic'),
    '(Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy|row-level security)');
  PERFORM pg_temp.expect('3 membership', 'an owner membership written straight through the API', 'P',
    format('INSERT INTO public.club_members (club_id, user_id, role, status) VALUES (%L, %L, %L, %L)', v_arena, P, 'owner', 'active'),
    '(Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy|row-level security)');
  PERFORM pg_temp.expect('3 membership', 'a membership row written by any door (the service role writes it)', 'engine',
    format('INSERT INTO public.club_members (club_id, user_id, role, status) VALUES (%L, %L, %L, %L)', v_arena, P, 'player', 'automatic'),
    'Diamond Membership Is Automatic And Has No Chip Wallet Or Hierarchy');
  PERFORM pg_temp.expect('3 membership', 'the Diamond Arena put in a union', 'engine',
    format('INSERT INTO public.union_clubs (union_id, club_id) VALUES (%L, %L)', v_union, v_arena), 'Diamond Arena Cannot Join A Union');
  PERFORM pg_temp.expect('3 membership', 'the Diamond Arena row given a union', 'engine',
    format('UPDATE public.clubs SET union_id = %L WHERE id = %L', v_union, v_arena), '(poker_arena_diamond_identity|Diamond Arena Cannot Join A Union)');
  PERFORM pg_temp.expect('3 membership', 'an agent in the Diamond Arena', 'engine',
    format('INSERT INTO public.agents (user_id, club_id, role, status) VALUES (%L, %L, %L, %L)', P, v_arena, 'agent', 'active'),
    'Diamond Arena Has No Agents Or Commissions');
  PERFORM pg_temp.expect('3 membership', 'a player assigned to an agent in the Diamond Arena', 'engine',
    format('INSERT INTO public.player_agent_assignments (player_id, club_id, agent_id) VALUES (%L, %L, %L)', P, v_arena, Q),
    'Diamond Arena Has No Agents Or Commissions');

  -- --------------------------------------------------------------------------
  -- 4. MEMBER DATA without entitlement (profile field visibility is Dan's open
  --    decision and is NOT probed here)
  -- --------------------------------------------------------------------------
  PERFORM pg_temp.expect('4 member data', 'the Diamond roster without an account', 'anon',
    'SELECT public.fn_diamond_arena_roster(NULL, NULL, NULL, 10)::text', '^42501\|permission denied for function ');
  PERFORM pg_temp.expect('4 member data', 'the Diamond counts without an account', 'anon',
    'SELECT public.fn_diamond_arena_counts()::text', '^42501\|permission denied for function ');
  PERFORM pg_temp.expect('4 member data', 'another player''s wallet summary', 'P',
    format('SELECT public.fn_diamond_wallet_summary(%L)::text', Q), '^42501\|wallet_summary_is_own_only$');
  PERFORM pg_temp.expect('4 member data', 'another player''s arena reconciliation', 'P',
    format('SELECT public.fn_diamond_arena_reconciliation(%L)::text', Q), '^42501\|arena_reconciliation_is_own_only$');
  PERFORM pg_temp.expect('4 member data', 'another player''s Diamond flow', 'P',
    format('SELECT public.fn_diamond_flow_by_kind(%L)::text', Q), '^42501\|diamond_flow_is_own_only$');
  PERFORM pg_temp.expect('4 member data', 'another player''s lifetime totals', 'P',
    format('SELECT public.fn_diamond_lifetime_totals(%L)::text', Q), '^42501\|lifetime_totals_is_own_only$');
  PERFORM pg_temp.expect('4 member data', 'another player''s Diamond cash-out receipt', 'P',
    format('SELECT public.fn_poker_diamond_cashout_receipt(%L, %L)::text', v_table, gen_random_uuid()), '^P0001\|ANSWERED:<null>$');
  PERFORM pg_temp.expect('4 member data', 'every chip-club roster row but one''s own', 'P',
    format('SELECT count(*)::text FROM public.club_members WHERE user_id <> %L', P), '^P0001\|ANSWERED:0$');
  IF v_stranger_club IS NOT NULL THEN
    PERFORM pg_temp.expect('4 member data', 'a chip club''s roster read by a super agent of another club', 'AG',
      format('SELECT count(*)::text FROM public.club_members WHERE club_id = %L', v_stranger_club), '^P0001\|ANSWERED:0$');
  END IF;
  PERFORM pg_temp.expect('4 member data', 'the agent list', 'P', 'SELECT count(*)::text FROM public.agents', '^P0001\|ANSWERED:0$');

  -- --------------------------------------------------------------------------
  -- 5. CLUB GAMES (the Diamond Spins estate): the Diamond Arena as a host, and
  --    another host's games operated or read by a non-staff "management" caller
  -- --------------------------------------------------------------------------
  PERFORM pg_temp.expect('5 club games', 'the Diamond Arena resolved as a club-games host', 'P',
    format('SELECT host_id::text FROM public.fn_wheel_host(%L)', v_arena),
    pg_temp.moded('^P0001\|ANSWERED:' || v_arena::text || '$', '^P0001\|ANSWERED:<null>$'));
  PERFORM pg_temp.expect('5 club games', 'the club-games entry read for the Diamond Arena', 'P',
    format('SELECT public.fn_diamond_games_entry(%L)::text', v_arena),
    pg_temp.moded('"ok": true', 'That Club Could Not Be Found'));
  PERFORM pg_temp.expect('5 club games', 'a club game configured in the Diamond Arena by a player', 'P',
    format('SELECT public.fn_diamond_game_set_config(%L, %L, %L::jsonb)::text', v_arena, 'plinko', '{}'),
    pg_temp.moded('Only The Host Owner Or An Admin May Change This Game', 'That Club Could Not Be Found'));
  PERFORM pg_temp.expect('5 club games', 'a club game configured in the Diamond Arena by staff', 'S',
    format('SELECT public.fn_diamond_game_set_config(%L, %L, %L::jsonb)::text', v_arena, 'plinko', '{"enabled": false}'),
    pg_temp.moded('"ok": true', 'That Club Could Not Be Found'));
  PERFORM pg_temp.expect('5 club games', 'owner terms accepted for the Diamond Arena by staff', 'S',
    format('SELECT public.fn_diamond_spins_owner_terms(%L, true)::text', v_arena),
    pg_temp.moded(NULL, 'That Club Could Not Be Found'));
  PERFORM pg_temp.expect('5 club games', 'another host''s game P&L read by a player', 'P',
    format('SELECT public.fn_diamond_game_pnl(%L)::text', v_game_club), 'Only The Host''s Owners And Admins Read This');
  PERFORM pg_temp.expect('5 club games', 'another host''s game P&L read by an incident recipient who is not staff', 'P',
    format('SELECT public.fn_diamond_game_pnl(%L)::text', v_game_club),
    pg_temp.moded('"ok": true', 'Only The Host''s Owners And Admins Read This'), v_mgmt);
  PERFORM pg_temp.expect('5 club games', 'another host''s player list read by an incident recipient who is not staff', 'P',
    format('SELECT public.fn_diamond_game_players(%L, 5)::text', v_game_club),
    pg_temp.moded('"ok": true', 'Only The Host''s Owners And Admins Read This'), v_mgmt);
  PERFORM pg_temp.expect('5 club games', 'another host''s game P&L read by staff (control)', 'S',
    format('SELECT public.fn_diamond_game_pnl(%L)::text', v_game_club), '"ok": true');
  IF current_setting('forgery.mode') = 'fixed' THEN
    -- Before the fix these would pass the operator check and lock a real host's
    -- rows, so they are asked only where the door refuses first.
    PERFORM pg_temp.expect('5 club games', 'another host''s game limits changed by an incident recipient who is not staff', 'P',
      format('SELECT public.fn_diamond_game_set_config(%L, %L, %L::jsonb)::text', v_game_club, 'plinko', '{}'),
      'Only The Host Owner Or An Admin May Change This Game', v_mgmt);
    PERFORM pg_temp.expect('5 club games', 'another host''s promo wallet funded by an incident recipient who is not staff', 'P',
      format('SELECT public.fn_diamond_game_fund_promo(%L, 1, %L)::text', v_game_club, 'forgeryprobe01'),
      'Only The Host''s Owners And Admins Move This Money', v_mgmt);
  END IF;

  -- --------------------------------------------------------------------------
  -- 6. THE ENGINE-ONLY DOORS: no browser role can execute a Diamond money core
  -- --------------------------------------------------------------------------
  FOREACH fn IN ARRAY ARRAY['fn_poker_diamond_buyin','fn_poker_diamond_cashout','fn_poker_diamond_top_up',
    'fn_poker_diamond_settle_cash_hand','fn_poker_diamond_reserve','fn_poker_diamond_release',
    'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_refund',
    'fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_seat_transfer','fn_poker_diamond_tournament_unregister',
    'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_custody_add','fn_poker_diamond_tournament_close_custody',
    'fn_poker_diamond_tournament_open_shadow','fn_poker_diamond_tournament_settle_fee','fn_poker_diamond_spin_draw',
    'fn_poker_diamond_create_spin','fn_poker_diamond_staff_audit','fn_poker_diamond_audit_tournament_created',
    'add_diamonds_to_balance','deduct_diamonds','award_diamonds','award_diamonds_v2','fn_ca_diamond_incident',
    'fn_ca_register_diamond_journal_row','purchase_vip_with_diamonds_atomic_v3','purchase_merch_with_diamonds_atomic_v2',
    'fn_purchase_club_shop_item_diamonds_v2','refund_diamond_merch_order_atomic_v2','settle_diamond_card_purchase_atomic',
    'fn_diamond_purchase_refund','fn_diamond_purchase_dispute','atomic_table_buyin_before_maintenance_announcement_gate',
    'atomic_table_rebuy_before_maintenance_announcement_gate','fn_ca_settle_hand_stacks_absolute','fn_ca_commit_hand_settlement',
    'fn_wheel_can_operate']
  LOOP
    INSERT INTO pg_temp.res(grp, label, who, ok, answer)
    SELECT '6 engine only', 'no browser role executes ' || fn, 'catalog',
           count(*) >= 1 AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                                      AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')),
           count(*) || ' overload(s)'
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = fn;
  END LOOP;
  INSERT INTO pg_temp.res(grp, label, who, ok, answer)
  SELECT '6 engine only', 'no SECURITY DEFINER function named for Diamonds is executable without an account', 'catalog',
         count(*) = 0, COALESCE(string_agg(p.proname, ', '), 'none')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.proname ILIKE '%diamond%'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
END $rest$;

-- ============================================================================
-- 7. NOTHING MOVED, AND THE VERDICT
-- ============================================================================
DO $end$
DECLARE b record; v_now record; v_bad text; v_n integer; v_ok integer; v_disc integer; v_table text;
BEGIN
  SELECT * INTO b FROM pg_temp.base;
  SELECT
    (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) AS identity,
    (SELECT sum(diamonds) FROM public.profiles WHERE id IN (pg_temp.uid('P'), pg_temp.uid('Q'), pg_temp.uid('S'), pg_temp.uid('AG'))) AS wallets,
    (SELECT count(*) FROM public.club_members WHERE club_id = pg_temp.arena()) AS arena_members,
    (SELECT count(*) FROM public.tables WHERE club_id = pg_temp.arena()) AS arena_tables,
    (SELECT count(*) FROM public.tournaments WHERE club_id = pg_temp.arena()) AS arena_events,
    (SELECT count(*) FROM public.poker_diamond_custody) AS custody_rows,
    (SELECT count(*) FROM public.ca_manual_adjustments) AS adjustments,
    (SELECT count(*) FROM public.ca_diamond_incident_events) AS incident_events,
    (SELECT count(*) FROM public.diamond_game_configs WHERE host_id = pg_temp.arena())
      + (SELECT count(*) FROM public.wheel_configs WHERE host_id = pg_temp.arena()) AS arena_games,
    (SELECT count(*) FROM public.entry_purchase_idempotency_receipts) AS purchase_receipts
  INTO v_now;
  INSERT INTO pg_temp.res(grp, label, who, ok, answer) VALUES
   ('7 nothing moved', 'the Diamond identity (register vs supply) is where it started', 'catalog',
      v_now.identity = b.identity, format('%s -> %s', b.identity, v_now.identity)),
   ('7 nothing moved', 'no identity''s wallet moved', 'catalog', v_now.wallets = b.wallets, format('%s -> %s', b.wallets, v_now.wallets)),
   ('7 nothing moved', 'no Diamond membership, table, event, custody, correction, incident event, arena club game or purchase receipt was written', 'catalog',
      (v_now.arena_members, v_now.arena_tables, v_now.arena_events, v_now.custody_rows, v_now.adjustments,
       v_now.incident_events, v_now.arena_games, v_now.purchase_receipts)
      = (b.arena_members, b.arena_tables, b.arena_events, b.custody_rows, b.adjustments,
         b.incident_events, b.arena_games, b.purchase_receipts),
      format('%s / %s', row(b.arena_members, b.arena_tables, b.arena_events, b.custody_rows, b.adjustments,
                            b.incident_events, b.arena_games, b.purchase_receipts),
                        row(v_now.arena_members, v_now.arena_tables, v_now.arena_events, v_now.custody_rows,
                            v_now.adjustments, v_now.incident_events, v_now.arena_games, v_now.purchase_receipts))),
   ('7 nothing moved', 'both Diamond switches are still closed', 'catalog',
      NOT EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled), NULL);

  SELECT count(*), count(*) FILTER (WHERE ok), count(*) FILTER (WHERE label LIKE '%[discovery]')
    INTO v_n, v_ok, v_disc FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s | %s', grp, label, who, CASE WHEN ok THEN 'ok' ELSE 'FAIL' END,
                           replace(COALESCE(answer, ''), E'\n', ' ')), E'\n' ORDER BY n)
    INTO v_table FROM pg_temp.res;
  SELECT string_agg(format('%s | %s | %s | %s', grp, label, who, answer), E'\n' ORDER BY n)
    INTO v_bad FROM pg_temp.res WHERE NOT ok;
  IF v_bad IS NULL AND v_disc = 0 THEN
    RAISE EXCEPTION 'REHEARSAL OK [mode %]: % probes, every one as expected%', current_setting('forgery.mode'), v_n,
      E'\n' || v_table;
  END IF;
  RAISE EXCEPTION 'REHEARSAL NOT OK [mode %]: % probes, % as expected, % unexpected, % discovery%', current_setting('forgery.mode'),
    v_n, v_ok - v_disc, v_n - v_ok, v_disc, E'\n' || COALESCE('UNEXPECTED:' || E'\n' || v_bad || E'\n', '') || 'ALL:' || E'\n' || v_table;
END $end$;
