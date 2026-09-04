-- CASH GAMES PROBE (Slice 1, A1.1-A1.6 + ROE 7/16). One DO block: applies the
-- migration, runs the scenarios as the club owner, RAISES its report so
-- nothing commits. Placeholders (double-underscored): MIGRATION, OWNER, CLUB.
-- Substitute them ONLY inside the DO block below. On 2026-09-04 a generator
-- replaced the token in THIS comment too, which put the whole migration at top
-- level of the file, where psql ran it autocommit - see the changelog.
DO $probe$
DECLARE
  r text := E'PROBE-S1 REPORT\n';
  owner uuid := '__OWNER__';
  club uuid := '__CLUB__';
  stranger uuid := '2a8c045e-cc0d-404f-896b-7e441a3c495a';   -- a member without create rights
  outsider uuid;                                              -- not a member at all (picked below)
  sid uuid := gen_random_uuid();
  j jsonb; msg text; n int; x record; g uuid; t uuid; t_sd uuid; s int;
BEGIN
  EXECUTE $mig$
__MIGRATION__
$mig$;
  r := r || E'migration applied inside the probe transaction\n';

  -- a live session for the owner so fn_caller_session_is_live passes
  INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (sid, owner, now(), now());
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- A1.1 classic nlh 1/2 (unusual blinds so the key is free): one game, one Main 1
  j := public.fn_cash_game_create(club, 'classic', 'nlh', 1.5, 3, NULL, '{}'::jsonb, NULL);
  g := (j->>'game_id')::uuid; t := (j->>'table_id')::uuid;
  SELECT count(*) INTO n FROM tables WHERE cluster_id = g;
  SELECT role, main_index, lifecycle, max_players, min_buy_in, max_buy_in, stakes, name, status, ante_enabled, nit_game, bomb_pot_enabled INTO x FROM tables WHERE id = t;
  r := r || format(E'A1.1 classic nlh: tables=%s role=%s idx=%s lifecycle=%s seats=%s buyin=%s-%s stakes=%s name=%s status=%s ante=%s nit=%s bomb=%s %s\n',
        n, x.role, x.main_index, x.lifecycle, x.max_players, x.min_buy_in, x.max_buy_in, x.stakes, x.name, x.status, x.ante_enabled, x.nit_game, x.bomb_pot_enabled,
        CASE WHEN n=1 AND x.role='main' AND x.main_index=1 AND x.max_players=9 AND x.min_buy_in=120 AND x.max_buy_in=600 AND x.stakes='1.50/3' AND NOT x.ante_enabled AND NOT x.nit_game AND NOT x.bomb_pot_enabled THEN 'PASS' ELSE 'FAIL' END);

  -- R3 + union scope: Main 1 carries the keep-alive flags, and union_id is
  -- what fn_game_creation_access would have told the old page.
  SELECT auto_extension, auto_restart, auto_create_table, union_id INTO x FROM tables WHERE id = t;
  r := r || format(E'R3 main-1 flags: ext=%s restart=%s create=%s union=%s access.union=%s %s\n',
        x.auto_extension, x.auto_restart, x.auto_create_table, x.union_id,
        (public.fn_game_creation_access(club)->>'union_id'),
        CASE WHEN x.auto_extension AND x.auto_restart AND NOT x.auto_create_table
                  AND x.union_id IS NOT DISTINCT FROM (public.fn_game_creation_access(club)->>'union_id')::uuid THEN 'PASS' ELSE 'FAIL' END);

  -- A1.2 madness plo5 1/2 with a 9-seat "override": 6 locked, madness defaults
  j := public.fn_cash_game_create(club, 'madness', 'plo5', 1, 2, 9, '{}'::jsonb, 'Probe Madness');
  t := (j->>'table_id')::uuid;
  SELECT max_players, min_buy_in, max_buy_in, ante_enabled, ante, nit_game, maintain_percent_min, maintain_hands, bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_ante_multiplier, bomb_pot_board_count, bomb_pot_double_board, straddle_enabled INTO x FROM tables WHERE id = t;
  r := r || format(E'A1.2 madness plo5: seats=%s buyin=%s-%s ante=%s/%s vpip=%s/%s/%s bomb=%s/%s/%sx/%s boards/double=%s straddle=%s snap.seats_locked=%s %s\n',
        x.max_players, x.min_buy_in, x.max_buy_in, x.ante_enabled, x.ante, x.nit_game, x.maintain_percent_min, x.maintain_hands,
        x.bomb_pot_enabled, x.bomb_pot_trigger_mode, x.bomb_pot_ante_multiplier, x.bomb_pot_board_count, x.bomb_pot_double_board, x.straddle_enabled, j->'snapshot'->>'seats_locked',
        CASE WHEN x.max_players=6 AND x.min_buy_in=200 AND x.max_buy_in=400 AND x.ante_enabled AND x.ante=2 AND x.nit_game AND x.maintain_percent_min=70 AND x.maintain_hands=30
                  AND x.bomb_pot_enabled AND x.bomb_pot_trigger_mode='once_per_orbit' AND x.bomb_pot_ante_multiplier=3 AND x.bomb_pot_board_count=2 AND x.bomb_pot_double_board AND NOT x.straddle_enabled THEN 'PASS' ELSE 'FAIL' END);

  -- A1.3 action nlh, host changes bomb_ante_bb 2 -> 5: snapshot 5, table posts 5
  j := public.fn_cash_game_create(club, 'action', 'nlh', 1, 2, NULL, '{"bombs": {"ante_bb": 5}}'::jsonb, NULL);
  t := (j->>'table_id')::uuid;
  SELECT bomb_pot_ante_multiplier, bomb_pot_trigger_mode, bomb_pot_interval_seconds, max_players, ante, maintain_percent_min, maintain_hands, name INTO x FROM tables WHERE id = t;
  r := r || format(E'A1.3 action nlh ante_bb override: snapshot=%s table=%s trigger=%s/%ss seats=%s ante=%s vpip=%s/%s name=%s %s\n',
        j->'snapshot'->'bombs'->>'ante_bb', x.bomb_pot_ante_multiplier, x.bomb_pot_trigger_mode, x.bomb_pot_interval_seconds, x.max_players, x.ante, x.maintain_percent_min, x.maintain_hands, x.name,
        CASE WHEN (j->'snapshot'->'bombs'->>'ante_bb')::int=5 AND x.bomb_pot_ante_multiplier=5 AND x.bomb_pot_trigger_mode='timed' AND x.bomb_pot_interval_seconds=900 AND x.max_players=6 AND x.ante=1 AND x.maintain_percent_min=30 AND x.maintain_hands=40 THEN 'PASS' ELSE 'FAIL' END);

  -- A1.4 classic nlh offers 9 or 6; 7 is refused
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'nlh', 2, 4, 7, '{}'::jsonb, NULL);
    r := r || E'A1.4 FAIL classic nlh accepted 7 seats\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A1.4 classic nlh 7 seats refused: %s %s\n', msg, CASE WHEN msg LIKE 'HANDEDNESS_INVALID%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  j := public.fn_cash_game_create(club, 'classic', 'nlh', 2, 4, 6, '{}'::jsonb, NULL);
  SELECT max_players INTO x FROM tables WHERE id = (j->>'table_id')::uuid;
  r := r || format(E'A1.4 classic nlh 6 seats accepted: seats=%s %s\n', x.max_players, CASE WHEN x.max_players=6 THEN 'PASS' ELSE 'FAIL' END);

  -- A1.5 unimplemented variant cannot confirm, never saved as NLHE
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'plo8o', 1, 2, NULL, '{}'::jsonb, NULL);
    r := r || E'A1.5 FAIL plo8o accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'A1.5 plo8o refused: %s %s\n', msg, CASE WHEN msg LIKE 'VARIANT_UNAVAILABLE%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  SELECT count(*) INTO n FROM cash_games WHERE club_id=club AND variant='nlh' AND sb=1 AND bb=2 AND template_name='classic';
  r := r || format(E'A1.5 no silent nlh fallback row: %s %s\n', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END);

  -- A1.6 one cluster, not N cards: every game has exactly one table
  SELECT count(*) INTO n FROM (SELECT cluster_id FROM tables WHERE cluster_id IN (SELECT id FROM cash_games WHERE created_by=owner) GROUP BY cluster_id HAVING count(*) <> 1) q;
  r := r || format(E'A1.6 games with a table count other than 1: %s %s\n', n, CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END);

  -- ROE 7: clocks may only be raised
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'short_deck', 1, 2, NULL, '{"stay_clock_min": 5}'::jsonb, NULL);
    r := r || E'ROE7 FAIL stay clock lowered\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'ROE7 stay clock 5 refused: %s %s\n', msg, CASE WHEN msg LIKE 'STAY_CLOCK_BELOW_FLOOR%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  j := public.fn_cash_game_create(club, 'classic', 'short_deck', 1, 2, 8, '{"stay_clock_min": 20, "rejoin_window_min": 240}'::jsonb, NULL);
  t_sd := (j->>'table_id')::uuid;
  r := r || format(E'ROE7 raised clocks accepted: snapshot stay=%s rejoin=%s seats=%s %s\n', j->'snapshot'->>'stay_clock_min', j->'snapshot'->>'rejoin_window_min', j->'snapshot'->>'seats',
        CASE WHEN (j->'snapshot'->>'stay_clock_min')::int=20 AND (j->'snapshot'->>'rejoin_window_min')::int=240 AND (j->'snapshot'->>'seats')::int=8 THEN 'PASS' ELSE 'FAIL' END);

  -- GAME_EXISTS on the same key
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'madness', 'plo5', 1, 2, NULL, '{}'::jsonb, NULL);
    r := r || E'KEY FAIL duplicate game accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'KEY duplicate refused: %s %s\n', msg, CASE WHEN msg LIKE 'GAME_EXISTS%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- ── Hardening (2026-09-04 audit) + R9 ───────────────────────────────────
  -- H2/H7: a limit game is labelled by bet size, decimals print two places
  j := public.fn_cash_game_create(club, 'classic', 'flh', 1, 2, 6, '{}'::jsonb, NULL);
  SELECT name, stakes INTO x FROM tables WHERE id = (j->>'table_id')::uuid;
  r := r || format(E'H2 flh 1/2 labelled by bet size: name=%s stakes=%s label(0.05,0.10)=%s %s\n', x.name, x.stakes, public.fn_cash_stakes_label(0.05, 0.10, 'nlh'),
        CASE WHEN x.name='FLH 2/4 Classic' AND x.stakes='2/4' AND public.fn_cash_stakes_label(0.05,0.10,'nlh')='0.05/0.10' THEN 'PASS' ELSE 'FAIL' END);

  -- H3: NaN and sub-cent blinds are STAKES_INVALID, not a raw cast or CHECK
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'nlh', 1, 'NaN'::numeric, NULL, '{}'::jsonb, NULL);
    r := r || E'H3 FAIL NaN accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'H3 NaN refused: %s %s\n', msg, CASE WHEN msg LIKE 'STAKES_INVALID%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'nlh', 0.005, 0.01, NULL, '{}'::jsonb, NULL);
    r := r || E'H3 FAIL sub-cent accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'H3 sub-cent refused: %s %s\n', msg, CASE WHEN msg LIKE 'STAKES_INVALID%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- H4: a malformed override names its key; bombs as an array is refused
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'nlh', 5, 10, NULL, '{"vpip_floor": "abc"}'::jsonb, NULL);
    r := r || E'H4 FAIL bad override accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'H4 bad override refused: %s %s\n', msg, CASE WHEN msg LIKE 'OVERRIDE_INVALID: vpip_floor%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'action', 'nlh', 5, 10, NULL, '{"bombs": [1]}'::jsonb, NULL);
    r := r || E'H4 FAIL bombs array accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'H4 bombs array refused: %s %s\n', msg, CASE WHEN msg LIKE 'OVERRIDE_INVALID: bombs%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- R9: a manual table may be created twice at one key, carries no keep-alive flags, snapshot says so
  j := public.fn_cash_game_create(club, 'classic', 'plo4', 5, 10, NULL, '{}'::jsonb, 'Hand Made', false);
  PERFORM public.fn_cash_game_create(club, 'classic', 'plo4', 5, 10, NULL, '{}'::jsonb, 'Hand Made Two', false);
  SELECT auto_extension, auto_restart, auto_create_table INTO x FROM tables WHERE id = (j->>'table_id')::uuid;
  SELECT count(*) INTO n FROM cash_games WHERE club_id=club AND variant='plo4' AND sb=5 AND bb=10 AND NOT must_move;
  r := r || format(E'R9 manual: two at one key=%s ext=%s restart=%s mode=%s must_move=%s %s\n', n, x.auto_extension, x.auto_restart, j->'snapshot'->>'table_mode', j->>'must_move',
        CASE WHEN n=2 AND NOT x.auto_extension AND NOT x.auto_restart AND j->'snapshot'->>'table_mode'='manual' AND (j->>'must_move')::boolean=false THEN 'PASS' ELSE 'FAIL' END);
  -- ...and a must-move game at that same key is still one per club
  PERFORM public.fn_cash_game_create(club, 'classic', 'plo4', 5, 10, NULL, '{}'::jsonb, NULL, true);
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'plo4', 5, 10, NULL, '{}'::jsonb, NULL, true);
    r := r || E'R9 FAIL second must-move game at one key accepted\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'R9 must-move still one per key: %s %s\n', msg, CASE WHEN msg LIKE 'GAME_EXISTS%' THEN 'PASS' ELSE 'FAIL' END);
  END;

  -- H1: closing Main 1 closes the game, the lifecycle pass leaves it closed, the key frees up
  j := public.fn_cash_game_create(club, 'action', 'plo6', 5, 10, NULL, '{}'::jsonb, NULL);
  g := (j->>'game_id')::uuid; t := (j->>'table_id')::uuid;
  EXECUTE 'RESET ROLE';   -- the browser learns the version from fn_list_managed_games; the probe reads it directly
  SELECT coalesce(max(version), 1) INTO n FROM managed_game_contract_versions WHERE game_kind='table' AND game_id=t;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  j := public.fn_execute_managed_game_command(gen_random_uuid(), 'table', t, 'close', n, '{}'::jsonb);
  EXECUTE 'RESET ROLE';   -- the pass is the fleet's (service_role); run it as the engine would
  PERFORM public.fn_table_lifecycle_pass();
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT g2.enabled, g2.state, (g2.closed_by = owner) AS by_owner, tb.status AS tstatus INTO x FROM cash_games g2 JOIN tables tb ON tb.id = t WHERE g2.id = g;
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'action', 'plo6', 5, 10, NULL, '{}'::jsonb, NULL);
    msg := 'recreated';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  r := r || format(E'H1 close main 1 (via the command door): ok=%s enabled=%s state=%s by_owner=%s table=%s after pass; recreate=%s %s\n', j->>'ok', x.enabled, x.state, x.by_owner, x.tstatus, msg,
        CASE WHEN (j->>'ok')::boolean AND NOT x.enabled AND x.state='dormant' AND x.by_owner AND x.tstatus='closed' AND msg='recreated' THEN 'PASS' ELSE 'FAIL' END);
  -- ...and a must-move game that is NOT closed is reopened by the pass (R3)
  j := public.fn_cash_game_create(club, 'madness', 'plo6', 5, 10, NULL, '{}'::jsonb, NULL);
  t := (j->>'table_id')::uuid;
  EXECUTE 'RESET ROLE';
  UPDATE tables SET status='closed' WHERE id = t;   -- something other than the host closed it
  PERFORM public.fn_table_lifecycle_pass();
  SELECT status INTO x FROM tables WHERE id = t;
  r := r || format(E'R3 an open game reopens after a stray close: status=%s %s\n', x.status, CASE WHEN x.status='waiting' THEN 'PASS' ELSE 'FAIL' END);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- H5: a private game is invisible to a non-member; a public one is not
  EXECUTE 'RESET ROLE';
  SELECT p.id INTO outsider FROM profiles p
   WHERE NOT EXISTS (SELECT 1 FROM club_members cm WHERE cm.user_id = p.id AND cm.club_id = club)
     AND coalesce(p.is_horse, false) = false LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  j := public.fn_cash_game_create(club, 'classic', 'pineapple', 5, 10, NULL, '{"options": {"is_private": true}}'::jsonb, 'Secret');
  g := (j->>'game_id')::uuid;
  PERFORM public.fn_cash_game_create(club, 'classic', 'pineapple', 25, 50, NULL, '{}'::jsonb, 'Open');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) FILTER (WHERE name='Secret') AS secret, count(*) FILTER (WHERE name='Open') AS open INTO x FROM cash_games WHERE club_id=club AND variant='pineapple';
  r := r || format(E'H5 outsider sees private=%s public=%s %s\n', x.secret, x.open, CASE WHEN x.secret=0 AND x.open=1 THEN 'PASS' ELSE 'FAIL' END);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) FILTER (WHERE name='Secret') AS secret INTO x FROM cash_games WHERE club_id=club AND variant='pineapple';
  r := r || format(E'H5 member sees private=%s %s\n', x.secret, CASE WHEN x.secret=1 THEN 'PASS' ELSE 'FAIL' END);
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);

  -- the session inherits the game's raised clocks (engine buy-in at the short-deck table)
  SELECT MIN(gs) INTO s FROM generate_series(1,(SELECT max_players FROM tables WHERE id=t_sd)) gs
   WHERE NOT EXISTS (SELECT 1 FROM table_seats ts WHERE ts.table_id=t_sd AND ts.seat_number=gs AND ts.left_at IS NULL);
  PERFORM public.atomic_table_buyin(stranger, t_sd, s, 100, false, NULL, NULL);
  SELECT stay_clock_ms, rejoin_window_ms, stay_remaining_ms INTO x FROM cash_player_session WHERE player_id=stranger AND scope_id=t_sd AND closed_at IS NULL;
  r := r || format(E'SESSION inherits clocks: stay=%s rejoin=%s remaining=%s %s\n', x.stay_clock_ms, x.rejoin_window_ms, x.stay_remaining_ms,
        CASE WHEN x.stay_clock_ms=1200000 AND x.rejoin_window_ms=14400000 AND x.stay_remaining_ms=1200000 THEN 'PASS' ELSE 'FAIL' END);

  -- a stranger cannot create games here
  PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated', 'session_id', sid)::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.fn_cash_game_create(club, 'classic', 'nlh', 3, 6, NULL, '{}'::jsonb, NULL);
    r := r || E'AUTH FAIL stranger created a game\n';
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    r := r || format(E'AUTH stranger refused: %s %s\n', msg, CASE WHEN msg LIKE 'NOT_AUTHORIZED%' OR msg LIKE 'SESSION_REVOKED%' THEN 'PASS' ELSE 'FAIL' END);
  END;
  EXECUTE 'RESET ROLE';

  RAISE EXCEPTION '%', r;
END
$probe$;
