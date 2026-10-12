-- ============================================================================
-- THE DIAMOND ARENA HAS A TOURNAMENT SCHEDULE - ONE SPAWN CYCLE, REHEARSED
-- ============================================================================
-- REHEARSAL ONLY. Run by the swarm's rehearse.sh against production after
-- 20261006090619_the_diamond_arena_has_a_tournament_schedule.sql, as ONE
-- transaction that ends in RAISE EXCEPTION 'REHEARSAL OK ...', so NOTHING
-- persists: the four schedule rows, every tournament the cycle spawns, the
-- spawn claims, the session and admin role the system account is given to ask
-- the real door, and the door's own events exist only inside the rolled-back
-- transaction. No switch moves and no Diamond moves.
--
-- 1. ONE SPAWN CYCLE, as ScheduledTournamentService.poll runs it: every
--    instance of every arena row due in its look-ahead (spawnAheadMsFor: six
--    days, every rung being 200 or more; five minutes behind now), its key
--    claimed in tournament_schedule_spawns, the row buildInsertRow writes
--    INSERTed with only the keys the engine sends (so column defaults apply as
--    they do through PostgREST), under SET ROLE service_role with a
--    service_role JWT, through every live trigger, and the claim linked. The
--    rows are the bytes buildInsertRow produced for these configs, generated
--    from the real code, with schedule_id and start_time set per instance.
-- 2. Every spawned event is admitted and well-formed: the arena's club, no
--    union, recognised as a Diamond event at the whole-Diamond unit,
--    REGISTERING in the future, buy_in_amount + buy_in_fee = the advertised
--    total with the fee exactly floor(10%), the bounty whole and within the
--    buy-in, no guarantee, no free buy, no rebuy, no add-on.
-- 3. THE REAL DOOR. The system account is made staff inside this transaction
--    (a session and the admin role, the Phase 11 rehearsal pattern) and
--    fn_poker_diamond_create_tournament is asked for each event. It must admit
--    it with the SAME buy_in_amount, buy_in_fee, bounty_amount, guarantee and
--    bounty flags as the spawned row, at the same unit.
-- 4. And it must REFUSE the zero buy-in freeroll this board leaves out.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';
DO $rehearsal$
DECLARE
  c_arena CONSTANT uuid := '002c2d27-9584-4e52-835a-bb2be148fc81';
  c_staff CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  v_sid uuid := uuid_in(md5('diamond-schedule-rehearsal:' || c_staff::text)::cstring);
  s record; d record; t public.tournaments%ROWTYPE; dt public.tournaments%ROWTYPE;
  v_cols text; v_id uuid; v_door jsonb; v_door_id uuid; v_row jsonb;
  v_total numeric; v_fee numeric; v_bounty numeric; v_n integer; v_all integer := 0;
  v_report text := ''; v_err text; v_ahead interval; v_tpl jsonb;
  v_templates jsonb := '{}'::jsonb;
BEGIN
  -- ── THE SCENE ─────────────────────────────────────────────────────────────
  IF (SELECT count(*) FROM public.tournament_schedules WHERE club_id = c_arena AND active) <> 4 THEN
    RAISE EXCEPTION 'the migration did not leave four active arena schedule rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE club_id = c_arena) THEN
    RAISE EXCEPTION 'the arena already holds tournaments; this rehearsal expects an empty lobby';
  END IF;

  -- The rows buildInsertRow writes for each config (server/src/services/
  -- ScheduledTournamentService.ts), schedule_id and start_time removed.
  SELECT jsonb_object_agg(x.name, x.row) INTO v_templates FROM (VALUES
    ('Diamond Daily Turbo 300', '{"accelerated_mtt":false,"action_time_seconds":15,"add_on_available":false,"addon_break_minutes":1,"addon_chips":null,"addon_cost":null,"addon_levels":null,"all_in_or_fold":false,"authorized_to_register":false,"ban_chat":false,"big_blind_ante":true,"blind_speed":"turbo","blind_structure":[{"ante":6,"bigBlind":50,"durationMinutes":4,"level":1,"smallBlind":25},{"ante":8,"bigBlind":60,"durationMinutes":4,"level":2,"smallBlind":30},{"ante":15,"bigBlind":100,"durationMinutes":4,"level":3,"smallBlind":50},{"ante":20,"bigBlind":150,"durationMinutes":3,"level":4,"smallBlind":75},{"ante":30,"bigBlind":250,"durationMinutes":3,"level":5,"smallBlind":125},{"ante":50,"bigBlind":400,"durationMinutes":3,"level":6,"smallBlind":200},{"ante":80,"bigBlind":600,"durationMinutes":2,"level":7,"smallBlind":300},{"ante":150,"bigBlind":1000,"durationMinutes":2,"level":8,"smallBlind":500},{"ante":200,"bigBlind":1500,"durationMinutes":2,"level":9,"smallBlind":750},{"ante":300,"bigBlind":2500,"durationMinutes":2,"level":10,"smallBlind":1250},{"ante":500,"bigBlind":4000,"durationMinutes":2,"level":11,"smallBlind":2000},{"ante":800,"bigBlind":6000,"durationMinutes":2,"level":12,"smallBlind":3000},{"ante":1500,"bigBlind":10000,"durationMinutes":2,"level":13,"smallBlind":5000},{"ante":2000,"bigBlind":15000,"durationMinutes":2,"level":14,"smallBlind":7500},{"ante":3000,"bigBlind":25000,"durationMinutes":2,"level":15,"smallBlind":12500},{"ante":5000,"bigBlind":40000,"durationMinutes":2,"level":16,"smallBlind":20000},{"ante":8000,"bigBlind":60000,"durationMinutes":2,"level":17,"smallBlind":30000},{"ante":15000,"bigBlind":100000,"durationMinutes":2,"level":18,"smallBlind":50000},{"ante":20000,"bigBlind":150000,"durationMinutes":2,"level":19,"smallBlind":75000},{"ante":30000,"bigBlind":250000,"durationMinutes":2,"level":20,"smallBlind":125000},{"ante":50000,"bigBlind":400000,"durationMinutes":2,"level":21,"smallBlind":200000},{"ante":80000,"bigBlind":600000,"durationMinutes":2,"level":22,"smallBlind":300000},{"ante":150000,"bigBlind":1000000,"durationMinutes":2,"level":23,"smallBlind":500000},{"ante":200000,"bigBlind":1500000,"durationMinutes":2,"level":24,"smallBlind":750000}],"bounty_amount":0,"bubble_protection":false,"buy_in_amount":270,"buy_in_fee":30,"club_id":"002c2d27-9584-4e52-835a-bb2be148fc81","current_players":0,"early_bird_chips":0,"early_bird_enabled":false,"final_table_deal_enabled":false,"game_type":"NLH","guaranteed_prize":0,"hide_club_name":false,"is_bounty":false,"is_mystery_bounty":false,"is_pinned":false,"is_pko":false,"is_rebuy":false,"is_reentry":false,"is_turbo":true,"is_vip_only":false,"is_xmtt":false,"label_as_new":false,"late_reg_levels":7,"late_reg_mins":23,"max_players":500,"max_rebuys":null,"max_reentries":null,"min_players":4,"mystery_bounty_max":0,"mystery_bounty_min":0,"name":"Diamond Daily Turbo 300","payout_percent":10,"payout_structure":[{"percentage":30,"place":1},{"percentage":20,"place":2},{"percentage":15,"place":3},{"percentage":10,"place":4},{"percentage":8,"place":5},{"percentage":6,"place":6},{"percentage":5,"place":7},{"percentage":3.5,"place":8},{"percentage":2.5,"place":9}],"rebuy_chips":null,"rebuy_cost":null,"rebuy_levels":null,"restart_every_minutes":null,"satellite_seats":null,"satellite_target_id":null,"short_description":"300 Diamonds To Enter. No Guarantee.","starting_chips":12000,"status":"REGISTERING","synchronized_breaks":true,"table_size":9,"tournament_type":"MTT","union_id":null,"variant":"freezeout"}'::jsonb),
    ('Diamond Daily Deep Stack 500', '{"accelerated_mtt":false,"action_time_seconds":15,"add_on_available":false,"addon_break_minutes":1,"addon_chips":null,"addon_cost":null,"addon_levels":null,"all_in_or_fold":false,"authorized_to_register":false,"ban_chat":false,"big_blind_ante":true,"blind_speed":"slow","blind_structure":[{"ante":0,"bigBlind":50,"durationMinutes":12,"level":1,"smallBlind":25},{"ante":0,"bigBlind":60,"durationMinutes":12,"level":2,"smallBlind":30},{"ante":10,"bigBlind":80,"durationMinutes":12,"level":3,"smallBlind":40},{"ante":15,"bigBlind":100,"durationMinutes":10,"level":4,"smallBlind":50},{"ante":15,"bigBlind":120,"durationMinutes":10,"level":5,"smallBlind":60},{"ante":20,"bigBlind":150,"durationMinutes":10,"level":6,"smallBlind":75},{"ante":30,"bigBlind":200,"durationMinutes":8,"level":7,"smallBlind":100},{"ante":30,"bigBlind":250,"durationMinutes":8,"level":8,"smallBlind":125},{"ante":30,"bigBlind":300,"durationMinutes":8,"level":9,"smallBlind":150},{"ante":50,"bigBlind":400,"durationMinutes":6,"level":10,"smallBlind":200},{"ante":60,"bigBlind":500,"durationMinutes":6,"level":11,"smallBlind":250},{"ante":80,"bigBlind":600,"durationMinutes":6,"level":12,"smallBlind":300},{"ante":100,"bigBlind":800,"durationMinutes":6,"level":13,"smallBlind":400},{"ante":150,"bigBlind":1000,"durationMinutes":6,"level":14,"smallBlind":500},{"ante":150,"bigBlind":1200,"durationMinutes":6,"level":15,"smallBlind":600},{"ante":200,"bigBlind":1500,"durationMinutes":6,"level":16,"smallBlind":750},{"ante":300,"bigBlind":2000,"durationMinutes":6,"level":17,"smallBlind":1000},{"ante":300,"bigBlind":2500,"durationMinutes":6,"level":18,"smallBlind":1250},{"ante":300,"bigBlind":3000,"durationMinutes":6,"level":19,"smallBlind":1500},{"ante":500,"bigBlind":4000,"durationMinutes":6,"level":20,"smallBlind":2000},{"ante":600,"bigBlind":5000,"durationMinutes":6,"level":21,"smallBlind":2500},{"ante":800,"bigBlind":6000,"durationMinutes":6,"level":22,"smallBlind":3000},{"ante":1000,"bigBlind":8000,"durationMinutes":6,"level":23,"smallBlind":4000},{"ante":1500,"bigBlind":10000,"durationMinutes":6,"level":24,"smallBlind":5000},{"ante":1500,"bigBlind":12000,"durationMinutes":6,"level":25,"smallBlind":6000},{"ante":2000,"bigBlind":15000,"durationMinutes":6,"level":26,"smallBlind":7500},{"ante":3000,"bigBlind":20000,"durationMinutes":6,"level":27,"smallBlind":10000},{"ante":3000,"bigBlind":25000,"durationMinutes":6,"level":28,"smallBlind":12500},{"ante":3000,"bigBlind":30000,"durationMinutes":6,"level":29,"smallBlind":15000},{"ante":5000,"bigBlind":40000,"durationMinutes":6,"level":30,"smallBlind":20000},{"ante":6000,"bigBlind":50000,"durationMinutes":6,"level":31,"smallBlind":25000},{"ante":8000,"bigBlind":60000,"durationMinutes":6,"level":32,"smallBlind":30000},{"ante":10000,"bigBlind":80000,"durationMinutes":6,"level":33,"smallBlind":40000},{"ante":15000,"bigBlind":100000,"durationMinutes":6,"level":34,"smallBlind":50000},{"ante":15000,"bigBlind":120000,"durationMinutes":6,"level":35,"smallBlind":60000},{"ante":20000,"bigBlind":150000,"durationMinutes":6,"level":36,"smallBlind":75000},{"ante":30000,"bigBlind":200000,"durationMinutes":6,"level":37,"smallBlind":100000},{"ante":30000,"bigBlind":250000,"durationMinutes":6,"level":38,"smallBlind":125000},{"ante":30000,"bigBlind":300000,"durationMinutes":6,"level":39,"smallBlind":150000},{"ante":50000,"bigBlind":400000,"durationMinutes":6,"level":40,"smallBlind":200000}],"bounty_amount":0,"bubble_protection":false,"buy_in_amount":450,"buy_in_fee":50,"club_id":"002c2d27-9584-4e52-835a-bb2be148fc81","current_players":0,"early_bird_chips":0,"early_bird_enabled":false,"final_table_deal_enabled":false,"game_type":"NLH","guaranteed_prize":0,"hide_club_name":false,"is_bounty":false,"is_mystery_bounty":false,"is_pinned":false,"is_pko":false,"is_rebuy":false,"is_reentry":false,"is_turbo":false,"is_vip_only":false,"is_xmtt":false,"label_as_new":false,"late_reg_levels":9,"late_reg_mins":90,"max_players":500,"max_rebuys":null,"max_reentries":null,"min_players":4,"mystery_bounty_max":0,"mystery_bounty_min":0,"name":"Diamond Daily Deep Stack 500","payout_percent":10,"payout_structure":[{"percentage":30,"place":1},{"percentage":20,"place":2},{"percentage":15,"place":3},{"percentage":10,"place":4},{"percentage":8,"place":5},{"percentage":6,"place":6},{"percentage":5,"place":7},{"percentage":3.5,"place":8},{"percentage":2.5,"place":9}],"rebuy_chips":null,"rebuy_cost":null,"rebuy_levels":null,"restart_every_minutes":null,"satellite_seats":null,"satellite_target_id":null,"short_description":"500 Diamonds To Enter. No Guarantee.","starting_chips":30000,"status":"REGISTERING","synchronized_breaks":true,"table_size":9,"tournament_type":"MTT","union_id":null,"variant":"freezeout"}'::jsonb),
    ('Diamond Bounty Hunt 1000', '{"accelerated_mtt":false,"action_time_seconds":15,"add_on_available":false,"addon_break_minutes":1,"addon_chips":null,"addon_cost":null,"addon_levels":null,"all_in_or_fold":false,"authorized_to_register":false,"ban_chat":false,"big_blind_ante":true,"blind_speed":"standard","blind_structure":[{"ante":0,"bigBlind":50,"durationMinutes":10,"level":1,"smallBlind":25},{"ante":8,"bigBlind":60,"durationMinutes":10,"level":2,"smallBlind":30},{"ante":10,"bigBlind":80,"durationMinutes":10,"level":3,"smallBlind":40},{"ante":15,"bigBlind":100,"durationMinutes":9,"level":4,"smallBlind":50},{"ante":20,"bigBlind":150,"durationMinutes":9,"level":5,"smallBlind":75},{"ante":30,"bigBlind":200,"durationMinutes":9,"level":6,"smallBlind":100},{"ante":30,"bigBlind":300,"durationMinutes":8,"level":7,"smallBlind":150},{"ante":50,"bigBlind":400,"durationMinutes":8,"level":8,"smallBlind":200},{"ante":60,"bigBlind":500,"durationMinutes":8,"level":9,"smallBlind":250},{"ante":80,"bigBlind":600,"durationMinutes":7,"level":10,"smallBlind":300},{"ante":100,"bigBlind":800,"durationMinutes":7,"level":11,"smallBlind":400},{"ante":150,"bigBlind":1000,"durationMinutes":7,"level":12,"smallBlind":500},{"ante":200,"bigBlind":1500,"durationMinutes":6,"level":13,"smallBlind":750},{"ante":300,"bigBlind":2000,"durationMinutes":6,"level":14,"smallBlind":1000},{"ante":300,"bigBlind":3000,"durationMinutes":6,"level":15,"smallBlind":1500},{"ante":500,"bigBlind":4000,"durationMinutes":5,"level":16,"smallBlind":2000},{"ante":600,"bigBlind":5000,"durationMinutes":5,"level":17,"smallBlind":2500},{"ante":800,"bigBlind":6000,"durationMinutes":5,"level":18,"smallBlind":3000},{"ante":1000,"bigBlind":8000,"durationMinutes":5,"level":19,"smallBlind":4000},{"ante":1500,"bigBlind":10000,"durationMinutes":5,"level":20,"smallBlind":5000},{"ante":2000,"bigBlind":15000,"durationMinutes":5,"level":21,"smallBlind":7500},{"ante":3000,"bigBlind":20000,"durationMinutes":5,"level":22,"smallBlind":10000},{"ante":3000,"bigBlind":30000,"durationMinutes":5,"level":23,"smallBlind":15000},{"ante":5000,"bigBlind":40000,"durationMinutes":5,"level":24,"smallBlind":20000},{"ante":6000,"bigBlind":50000,"durationMinutes":5,"level":25,"smallBlind":25000},{"ante":8000,"bigBlind":60000,"durationMinutes":5,"level":26,"smallBlind":30000},{"ante":10000,"bigBlind":80000,"durationMinutes":5,"level":27,"smallBlind":40000},{"ante":15000,"bigBlind":100000,"durationMinutes":5,"level":28,"smallBlind":50000},{"ante":20000,"bigBlind":150000,"durationMinutes":5,"level":29,"smallBlind":75000},{"ante":30000,"bigBlind":200000,"durationMinutes":5,"level":30,"smallBlind":100000},{"ante":30000,"bigBlind":300000,"durationMinutes":5,"level":31,"smallBlind":150000},{"ante":50000,"bigBlind":400000,"durationMinutes":5,"level":32,"smallBlind":200000},{"ante":60000,"bigBlind":500000,"durationMinutes":5,"level":33,"smallBlind":250000},{"ante":80000,"bigBlind":600000,"durationMinutes":5,"level":34,"smallBlind":300000},{"ante":100000,"bigBlind":800000,"durationMinutes":5,"level":35,"smallBlind":400000},{"ante":150000,"bigBlind":1000000,"durationMinutes":5,"level":36,"smallBlind":500000},{"ante":200000,"bigBlind":1500000,"durationMinutes":5,"level":37,"smallBlind":750000},{"ante":300000,"bigBlind":2000000,"durationMinutes":5,"level":38,"smallBlind":1000000},{"ante":300000,"bigBlind":3000000,"durationMinutes":5,"level":39,"smallBlind":1500000},{"ante":500000,"bigBlind":4000000,"durationMinutes":5,"level":40,"smallBlind":2000000}],"bounty_amount":225,"bubble_protection":false,"buy_in_amount":900,"buy_in_fee":100,"club_id":"002c2d27-9584-4e52-835a-bb2be148fc81","current_players":0,"early_bird_chips":0,"early_bird_enabled":false,"final_table_deal_enabled":false,"game_type":"NLH","guaranteed_prize":0,"hide_club_name":false,"is_bounty":true,"is_mystery_bounty":false,"is_pinned":false,"is_pko":false,"is_rebuy":false,"is_reentry":false,"is_turbo":false,"is_vip_only":false,"is_xmtt":false,"label_as_new":false,"late_reg_levels":8,"late_reg_mins":73,"max_players":500,"max_rebuys":null,"max_reentries":null,"min_players":4,"mystery_bounty_max":0,"mystery_bounty_min":0,"name":"Diamond Bounty Hunt 1000","payout_percent":10,"payout_structure":[{"percentage":30,"place":1},{"percentage":20,"place":2},{"percentage":15,"place":3},{"percentage":10,"place":4},{"percentage":8,"place":5},{"percentage":6,"place":6},{"percentage":5,"place":7},{"percentage":3.5,"place":8},{"percentage":2.5,"place":9}],"rebuy_chips":null,"rebuy_cost":null,"rebuy_levels":null,"restart_every_minutes":null,"satellite_seats":null,"satellite_target_id":null,"short_description":"25% Of Each Entry Contribution Funds A Fixed Knockout Bounty. No Guarantee.","starting_chips":18000,"status":"REGISTERING","synchronized_breaks":true,"table_size":9,"tournament_type":"MTT","union_id":null,"variant":"bounty"}'::jsonb),
    ('Diamond Progressive Bounty 2000', '{"accelerated_mtt":false,"action_time_seconds":15,"add_on_available":false,"addon_break_minutes":1,"addon_chips":null,"addon_cost":null,"addon_levels":null,"all_in_or_fold":false,"authorized_to_register":false,"ban_chat":false,"big_blind_ante":true,"blind_speed":"turbo","blind_structure":[{"ante":6,"bigBlind":50,"durationMinutes":4,"level":1,"smallBlind":25},{"ante":8,"bigBlind":60,"durationMinutes":4,"level":2,"smallBlind":30},{"ante":15,"bigBlind":100,"durationMinutes":4,"level":3,"smallBlind":50},{"ante":20,"bigBlind":150,"durationMinutes":3,"level":4,"smallBlind":75},{"ante":30,"bigBlind":250,"durationMinutes":3,"level":5,"smallBlind":125},{"ante":50,"bigBlind":400,"durationMinutes":3,"level":6,"smallBlind":200},{"ante":80,"bigBlind":600,"durationMinutes":2,"level":7,"smallBlind":300},{"ante":150,"bigBlind":1000,"durationMinutes":2,"level":8,"smallBlind":500},{"ante":200,"bigBlind":1500,"durationMinutes":2,"level":9,"smallBlind":750},{"ante":300,"bigBlind":2500,"durationMinutes":2,"level":10,"smallBlind":1250},{"ante":500,"bigBlind":4000,"durationMinutes":2,"level":11,"smallBlind":2000},{"ante":800,"bigBlind":6000,"durationMinutes":2,"level":12,"smallBlind":3000},{"ante":1500,"bigBlind":10000,"durationMinutes":2,"level":13,"smallBlind":5000},{"ante":2000,"bigBlind":15000,"durationMinutes":2,"level":14,"smallBlind":7500},{"ante":3000,"bigBlind":25000,"durationMinutes":2,"level":15,"smallBlind":12500},{"ante":5000,"bigBlind":40000,"durationMinutes":2,"level":16,"smallBlind":20000},{"ante":8000,"bigBlind":60000,"durationMinutes":2,"level":17,"smallBlind":30000},{"ante":15000,"bigBlind":100000,"durationMinutes":2,"level":18,"smallBlind":50000},{"ante":20000,"bigBlind":150000,"durationMinutes":2,"level":19,"smallBlind":75000},{"ante":30000,"bigBlind":250000,"durationMinutes":2,"level":20,"smallBlind":125000},{"ante":50000,"bigBlind":400000,"durationMinutes":2,"level":21,"smallBlind":200000},{"ante":80000,"bigBlind":600000,"durationMinutes":2,"level":22,"smallBlind":300000},{"ante":150000,"bigBlind":1000000,"durationMinutes":2,"level":23,"smallBlind":500000},{"ante":200000,"bigBlind":1500000,"durationMinutes":2,"level":24,"smallBlind":750000}],"bounty_amount":900,"bubble_protection":false,"buy_in_amount":1800,"buy_in_fee":200,"club_id":"002c2d27-9584-4e52-835a-bb2be148fc81","current_players":0,"early_bird_chips":0,"early_bird_enabled":false,"final_table_deal_enabled":false,"game_type":"NLH","guaranteed_prize":0,"hide_club_name":false,"is_bounty":true,"is_mystery_bounty":false,"is_pinned":false,"is_pko":true,"is_rebuy":false,"is_reentry":false,"is_turbo":true,"is_vip_only":false,"is_xmtt":false,"label_as_new":false,"late_reg_levels":9,"late_reg_mins":27,"max_players":500,"max_rebuys":null,"max_reentries":null,"min_players":4,"mystery_bounty_max":0,"mystery_bounty_min":0,"name":"Diamond Progressive Bounty 2000","payout_percent":10,"payout_structure":[{"percentage":30,"place":1},{"percentage":20,"place":2},{"percentage":15,"place":3},{"percentage":10,"place":4},{"percentage":8,"place":5},{"percentage":6,"place":6},{"percentage":5,"place":7},{"percentage":3.5,"place":8},{"percentage":2.5,"place":9}],"rebuy_chips":null,"rebuy_cost":null,"rebuy_levels":null,"restart_every_minutes":null,"satellite_seats":null,"satellite_target_id":null,"short_description":"50% Of Each Entry Contribution Funds The Progressive Bounty. Half Of Each Knockout Pays Immediately, Half Rolls Into The Winner''s Bounty. No Guarantee.","starting_chips":22000,"status":"REGISTERING","synchronized_breaks":true,"table_size":9,"tournament_type":"MTT","union_id":null,"variant":"progressive_bounty"}'::jsonb)
  ) AS x(name, row);

  -- ── 1. ONE SPAWN CYCLE, AS THE ENGINE RUNS IT ─────────────────────────────
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  FOR s IN SELECT * FROM public.tournament_schedules
            WHERE club_id = c_arena AND active ORDER BY start_times_utc[1] LOOP
    v_tpl := v_templates -> s.name;
    IF v_tpl IS NULL THEN RAISE EXCEPTION 'no spawner row generated for %', s.name; END IF;
    -- spawnAheadMsFor: 6 days for a total of 200 or more, else 72 hours.
    v_ahead := CASE WHEN (s.config->>'buyIn')::numeric >= 200 THEN interval '6 days' ELSE interval '72 hours' END;
    v_n := 0;
    -- timedSpawnsDue, NULL time zone: day offsets -1 .. ceil(ahead/1 day).
    FOR d IN
      SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + make_interval(days => o)
              + (tm || ':00')::interval) AT TIME ZONE 'UTC' AS at, tm
        FROM generate_series(-1, ceil(extract(epoch FROM v_ahead) / 86400)::int) AS o,
             unnest(s.start_times_utc) AS tm
       WHERE extract(dow FROM (date_trunc('day', now() AT TIME ZONE 'UTC') + make_interval(days => o)))::int
             = ANY (s.days_of_week)
       ORDER BY 1
    LOOP
      CONTINUE WHEN d.at - now() < interval '-5 minutes' OR d.at - now() > v_ahead;
      -- claimSpawn: UNIQUE(spawn_key) is the claim.
      INSERT INTO public.tournament_schedule_spawns(schedule_id, spawn_key)
      VALUES (s.id, s.id::text || ':' || to_char(d.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' || d.tm);
      -- The insert: only the keys the engine sends.
      v_row := v_tpl || jsonb_build_object('schedule_id', s.id,
                 'start_time', to_char(d.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'));
      SELECT string_agg(quote_ident(k), ', ') INTO v_cols FROM jsonb_object_keys(v_row) AS k;
      EXECUTE format('INSERT INTO public.tournaments (%s) SELECT %s FROM jsonb_populate_record(NULL::public.tournaments, $1) RETURNING id',
                     v_cols, v_cols) INTO v_id USING v_row;
      UPDATE public.tournament_schedule_spawns SET tournament_id = v_id
       WHERE spawn_key = s.id::text || ':' || to_char(d.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ':' || d.tm;
      IF NOT FOUND THEN RAISE EXCEPTION 'spawn claim for % was not linked', s.name; END IF;
      v_n := v_n + 1;
    END LOOP;
    IF v_n = 0 THEN RAISE EXCEPTION 'the cycle spawned nothing for %', s.name; END IF;
    v_all := v_all + v_n;
  END LOOP;
  RESET ROLE;

  -- ── 2. EVERY SPAWNED EVENT IS ADMITTED AND WELL-FORMED ───────────────────
  FOR s IN SELECT * FROM public.tournament_schedules WHERE club_id = c_arena ORDER BY start_times_utc[1] LOOP
    v_total := (s.config->>'buyIn')::numeric;
    v_fee := floor(v_total * 0.10);
    v_bounty := COALESCE((s.config->>'bountyAmount')::numeric, 0);
    v_n := 0;
    FOR t IN SELECT * FROM public.tournaments WHERE schedule_id = s.id ORDER BY start_time LOOP
      v_n := v_n + 1;
      IF t.club_id IS DISTINCT FROM c_arena OR t.union_id IS NOT NULL OR t.is_xmtt THEN
        RAISE EXCEPTION '% (%): not the arena''s own event (club %, union %)', s.name, t.start_time, t.club_id, t.union_id;
      END IF;
      IF NOT public.fn_poker_diamond_tournament(t.id) OR public.fn_ca_tournament_unit_cents(t.id) <> 100 THEN
        RAISE EXCEPTION '% (%): not recognised as a Diamond event at the whole-Diamond unit', s.name, t.start_time;
      END IF;
      IF t.status IS DISTINCT FROM 'REGISTERING' OR t.start_time <= now() OR t.tournament_type IS DISTINCT FROM 'MTT' THEN
        RAISE EXCEPTION '% (%): status %, type %', s.name, t.start_time, t.status, t.tournament_type;
      END IF;
      IF t.buy_in_amount + t.buy_in_fee <> v_total OR t.buy_in_fee <> v_fee
         OR t.buy_in_amount <> trunc(t.buy_in_amount) OR t.buy_in_fee <> trunc(t.buy_in_fee) THEN
        RAISE EXCEPTION '% (%): priced % + % for an advertised % (fee should be %)', s.name, t.start_time, t.buy_in_amount, t.buy_in_fee, v_total, v_fee;
      END IF;
      IF COALESCE(t.bounty_amount, 0) <> v_bounty OR v_bounty <> trunc(v_bounty) OR v_bounty > t.buy_in_amount
         OR COALESCE(t.is_bounty, false) <> (v_bounty > 0)
         OR COALESCE(t.is_pko, false) <> (s.config->>'type' = 'progressive_bounty') THEN
        RAISE EXCEPTION '% (%): bounty % (bounty % pko %), expected %', s.name, t.start_time, t.bounty_amount, t.is_bounty, t.is_pko, v_bounty;
      END IF;
      IF COALESCE(t.guaranteed_prize, 0) <> 0 OR COALESCE(t.free_buy, false) OR COALESCE(t.is_rebuy, false)
         OR COALESCE(t.is_reentry, false) OR COALESCE(t.add_on_available, false) OR COALESCE(t.addon_from_start, false)
         OR t.satellite_target_id IS NOT NULL OR COALESCE(t.prize_pool, 0) <> 0 THEN
        RAISE EXCEPTION '% (%): carries a guarantee, free buy, rebuy, add-on, satellite or a prize pool before any entry', s.name, t.start_time;
      END IF;
    END LOOP;
    IF v_n = 0 THEN RAISE EXCEPTION '% has no spawned event to check', s.name; END IF;
    v_report := v_report || format('%s x%s at %s UTC (%s+%s%s); ', s.name, v_n, s.start_times_utc[1],
                 v_total - v_fee, v_fee, CASE WHEN v_bounty > 0 THEN ', bounty ' || v_bounty ELSE '' END);
  END LOOP;

  -- ── 3. THE REAL DOOR PRICES EACH EVENT THE SAME ───────────────────────────
  INSERT INTO auth.sessions(id, user_id, created_at, updated_at) VALUES (v_sid, c_staff, now(), now());
  UPDATE public.profiles SET role = 'admin' WHERE id = c_staff;
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', c_staff,
    'session_id', v_sid)::text, true);
  PERFORM set_config('request.jwt.claim.sub', c_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  FOR s IN SELECT * FROM public.tournament_schedules WHERE club_id = c_arena ORDER BY start_times_utc[1] LOOP
    SELECT * INTO t FROM public.tournaments WHERE schedule_id = s.id ORDER BY start_time LIMIT 1;
    v_door := public.fn_poker_diamond_create_tournament(jsonb_strip_nulls(jsonb_build_object(
      'name', s.name || ' (door rehearsal)', 'type', s.config->>'type', 'gameVariant', 'NLH',
      'buyIn', (s.config->>'buyIn')::numeric, 'bountyAmount', (s.config->>'bountyAmount')::numeric,
      'maxPlayers', (s.config->>'maxPlayers')::int, 'minPlayers', (s.config->>'minPlayers')::int,
      'tableSize', (s.config->>'tableSize')::int, 'startingStack', (s.config->>'startingStack')::int,
      'lateRegLevels', (s.config->>'lateRegistrationLevels')::int,
      'blindStructure', t.blind_structure::jsonb, 'payoutStructure', t.payout_structure::jsonb,
      'startTime', (t.start_time + interval '7 minutes')::text)));
    v_door_id := (v_door->>'tournamentId')::uuid;
    IF v_door_id IS NULL OR (v_door->>'success')::boolean IS NOT TRUE THEN
      RAISE EXCEPTION 'the real door did not admit %: %', s.name, v_door;
    END IF;
    SELECT * INTO dt FROM public.tournaments WHERE id = v_door_id;
    IF (dt.buy_in_amount, dt.buy_in_fee, COALESCE(dt.bounty_amount,0), COALESCE(dt.guaranteed_prize,0),
        COALESCE(dt.is_bounty,false), COALESCE(dt.is_pko,false), COALESCE(dt.is_mystery_bounty,false), dt.club_id, dt.union_id)
       IS DISTINCT FROM
       (t.buy_in_amount, t.buy_in_fee, COALESCE(t.bounty_amount,0), COALESCE(t.guaranteed_prize,0),
        COALESCE(t.is_bounty,false), COALESCE(t.is_pko,false), COALESCE(t.is_mystery_bounty,false), t.club_id, t.union_id)
       OR public.fn_ca_tournament_unit_cents(v_door_id) <> public.fn_ca_tournament_unit_cents(t.id) THEN
      RAISE EXCEPTION 'the real door prices % differently: door % + % bounty %, spawner % + % bounty %',
        s.name, dt.buy_in_amount, dt.buy_in_fee, dt.bounty_amount, t.buy_in_amount, t.buy_in_fee, t.bounty_amount;
    END IF;
  END LOOP;

  -- ── 4. THE FREEROLL THIS BOARD LEAVES OUT IS A REFUSAL AT THE DOOR ────────
  v_err := NULL;
  BEGIN
    PERFORM public.fn_poker_diamond_create_tournament(jsonb_build_object(
      'name', 'Diamond Freeroll (door rehearsal)', 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 0,
      'maxPlayers', 500, 'minPlayers', 4, 'startingStack', 5000,
      'blindStructure', t.blind_structure::jsonb, 'payoutStructure', t.payout_structure::jsonb,
      'startTime', (now() + interval '2 days')::text));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'diamond_tournament_requires_a_whole_positive_buy_in' THEN
    RAISE EXCEPTION 'the real door did not refuse a zero buy-in as expected: %', COALESCE(v_err, 'it was ADMITTED');
  END IF;

  RAISE EXCEPTION 'REHEARSAL OK: one spawn cycle created % events, every one admitted and priced as the real door prices it; % the door refuses the freeroll (%)',
    v_all, v_report, v_err;
END $rehearsal$;
