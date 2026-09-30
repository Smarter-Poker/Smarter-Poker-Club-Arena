-- ============================================================================
-- THE SCENE FOR THE DIAMOND CONCURRENCY CASES
-- ============================================================================
-- PRIVATE ISOLATED FIXTURE ONLY. Loaded by run-diamond-concurrency.py into a
-- cluster that run creates, owns and destroys. Every row here is synthetic and
-- every account is on the estate's reserved @smarter-poker.invalid fixture
-- domain, which the real signup triggers recognise as certification equipment.
--
-- THE ARENA CARRIES PRODUCTION'S OWN ID. tables_cash_needs_a_game, the CHECK
-- production holds on public.tables, admits a cash table without a cluster
-- only inside the club it names - 002c2d27-9584-4e52-835a-bb2be148fc81, the
-- Diamond Arena. The staff door that opens a Diamond cash table relies on that
-- exemption, so the fixture's one Diamond arena has that id. It has no owner
-- and no membership row, for the reason diamond-tournament-lifecycle-seed.sql
-- gives: the arena's membership guard refuses every membership INSERT, and
-- fn_club_owner_has_a_player_wallet returns on its first line with no owner.
--
-- WHAT THIS SCENE OPENS, AND WHERE. The money doors refuse a closed arena: the
-- cash buy-in and top-up raise diamond_cash_not_open and the tournament
-- reserve raises diamond_tournaments_not_open. A race nobody can enter proves
-- nothing, so this scene opens cash_games_enabled and tournaments_enabled IN
-- THIS PRIVATE CLUSTER ONLY - as poker-diamond-cash-admission-setup.sql opens
-- the cash switch in its own isolated fixture. Production's switches are
-- Dan's; the guard below refuses to run anywhere but the private socket.
--
-- NOTHING HERE IS A PRICE ANYONE APPROVED. The feature prices, the settlement
-- window and the MTT admission ABI are production's own rows, read read-only on
-- 2026-09-30. The mint policy is a synthetic finite bound for the signup path.
-- The table stakes and the event's buy-in are fixture inputs, chosen so that
-- the spenders in a race cannot all be paid from one 500-Diamond signup grant.
-- ============================================================================
DO $guard$ BEGIN
  IF current_database() <> 'diamond_concurrency'
     OR inet_server_addr() IS NOT NULL
     OR current_setting('port') <> '55734' THEN
    RAISE EXCEPTION 'isolated Diamond concurrency fixture only';
  END IF;
END $guard$;

CREATE SCHEMA concurrency_fixture;
CREATE FUNCTION concurrency_fixture.ok(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label; END $$;

-- The signup path needs a bounded mint policy and a current financial epoch.
INSERT INTO public.ca_mint_policy
 (id, per_operation_cap_chips, rolling_24h_cap_chips,
  per_operation_cap_diamonds, rolling_24h_cap_diamonds, note)
VALUES (1, 100000, 100000, 5000, 200000,
        'Synthetic bounded concurrency fixture policy; no production policy claim');
INSERT INTO public.ca_financial_epochs(name, description, is_current)
VALUES ('diamond-concurrency', 'Synthetic local epoch; no copied financial rows', true);

SELECT set_config('request.jwt.claim.role', 'service_role', false);

-- The staff account and 200 players through the real signup path:
-- each profile and its 500-Diamond signup grant are written by production's
-- own signup triggers, which journal the grant and register it with the mint.
-- Every case draws fresh players from this pool, so no case inherits another's
-- balances.
INSERT INTO auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
                       email_confirmed_at, created_at, updated_at, is_super_admin)
SELECT ('10000000-0000-0000-0000-0000000000' || x)::uuid, 'authenticated', 'authenticated',
       CASE WHEN x = 'ff' THEN 'diamondconcstaff' ELSE 'diamondconcp' || x END || '@smarter-poker.invalid',
       '{"provider":"email","providers":["email"]}',
       jsonb_build_object('full_name', 'Diamond Concurrency Fixture ' || x,
                          'poker_alias', 'ConcFx' || x),
       now(), now(), now(), false
  FROM (SELECT lpad(to_hex(n), 2, '0') AS x FROM generate_series(1, 200) AS n
        UNION ALL SELECT 'ff') AS ids;
SELECT concurrency_fixture.ok((SELECT count(*) = 201 FROM public.profiles WHERE diamonds = 500
                                AND COALESCE(is_horse, false) = false)
                           AND (SELECT count(*) = 0 FROM public.signup_errors),
 'the real signup path made 201 synthetic profiles, each holding its signup grant');

-- The platform operator. fn_is_platform_admin reads profiles.role.
UPDATE public.profiles SET role = 'god' WHERE id = '10000000-0000-0000-0000-0000000000ff';

-- A live session for every account: fn_caller_session_is_live reads auth.sessions.
INSERT INTO auth.sessions(id, user_id, created_at, updated_at)
SELECT uuid_in(md5('concurrency-session:' || p.id::text)::cstring), p.id, now(), now()
  FROM public.profiles p;

-- The Diamond arena, platform-owned, in no union, holding no chips.
SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000000ff', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated',
  'sub', '10000000-0000-0000-0000-0000000000ff',
  'session_id', uuid_in(md5('concurrency-session:10000000-0000-0000-0000-0000000000ff')::cstring))::text, false);
INSERT INTO public.clubs(id, name, slug, asset, is_platform, is_union, owner_id, chip_treasury,
                         description, tagline, is_public)
VALUES ('002c2d27-9584-4e52-835a-bb2be148fc81', 'Diamond Arena', 'diamond-arena', 'diamonds',
        true, false, NULL, 0,
        'The synthetic concurrency fixture arena. Every game inside it plays in Diamonds.',
        'Play Your Diamonds', true);
-- The arena's settings row as production holds it, both switches closed.
INSERT INTO public.ca_arena_settings(id, club_id, settlement_window_days, note)
VALUES (1, '002c2d27-9584-4e52-835a-bb2be148fc81', 14, 'synthetic concurrency fixture');
UPDATE public.ca_mtt_admission_contract SET abi = 'unlimited-mtt-v2' WHERE singleton;
SELECT concurrency_fixture.ok((SELECT count(*) = 1 FROM public.clubs
                                WHERE asset = 'diamonds' AND is_platform IS TRUE AND union_id IS NULL)
                           AND (SELECT count(*) = 0 FROM public.club_members),
 'exactly one Diamond arena, platform-owned, in no union and with no membership row');

-- Every pair of players are accepted friends: the transfer door re-checks the
-- friendship at the writer.
INSERT INTO public.friendships(user_id, friend_id, status)
SELECT a.id, b.id, 'accepted'
  FROM public.profiles a JOIN public.profiles b ON a.id < b.id
 WHERE a.id <> '10000000-0000-0000-0000-0000000000ff'
   AND b.id <> '10000000-0000-0000-0000-0000000000ff';

-- Four of production's feature prices, copied as production holds them.
INSERT INTO public.feature_pricing(feature, diamond_cost, usage_type, description, vip_tiers_included) VALUES
  ('rabbit_hunt', 5, 'per_use', 'See the cards that would have come', ARRAY['bronze','silver','gold']),
  ('card_back_neon', 75, 'permanent', 'Neon card back', ARRAY[]::text[]),
  ('card_back_dragon', 125, 'permanent', 'Dragon card back', ARRAY[]::text[]),
  ('card_back_gold', 150, 'permanent', 'Premium Gold card back', ARRAY[]::text[]);

-- Local-only certification opens its own fixture arena. Never run on production.
UPDATE public.ca_arena_settings SET cash_games_enabled = true, tournaments_enabled = true
 WHERE id = 1 AND club_id = '002c2d27-9584-4e52-835a-bb2be148fc81';

-- Everything the staff account opens, it opens through its own door.
CREATE TABLE concurrency_fixture.targets(name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO concurrency_fixture.targets
SELECT 'cash_' || n, public.fn_poker_diamond_open_cash_table('Concurrency ' || n, 1, 2, 40, 200, 6, 'nlh')
  FROM generate_series(1, 16) AS n;
INSERT INTO concurrency_fixture.targets
SELECT 'mtt_' || k, (public.fn_poker_diamond_create_tournament(jsonb_build_object(
  'name', 'Concurrency MTT ' || k, 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 25,
  'maxPlayers', 60, 'minPlayers', 2, 'startingStack', 10000,
  'rebuy', true, 'rebuyCost', 25, 'maxRebuys', 5,
  'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
  'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
  'startTime', (now() + interval '1 hour')::text))->>'tournamentId')::uuid
  FROM unnest(ARRAY['race', 'replay', 'pay', 'reg', 'rebuy', 'crash']) AS k;
SELECT concurrency_fixture.ok((SELECT count(*) = 22 FROM concurrency_fixture.targets),
 'the staff doors opened sixteen Diamond cash tables and six Diamond MTTs with rebuys');

-- One chip club and one chip freeroll. A player's Diamond doors and the same
-- player's chip registration share two per-player locks - the table-cap lock
-- and the Daily Missions lock on the profile row, which for a Diamond player is
-- the wallet - so the races include a chip entry. The freeroll charges nothing:
-- the chip wallet is not what is under test, the lock order is. The club row is
-- written as the staff account (the chip autoledger names its actor), and the
-- event is opened through the chip create door, as the club's owner.
INSERT INTO public.clubs(id, name, slug, asset, is_platform, is_union, owner_id, chip_treasury,
                         description, tagline, is_public)
VALUES ('c0000000-0000-0000-0000-0000000000c1', 'Concurrency Chip Club', 'concurrency-chip-club', 'chips',
        false, false, '10000000-0000-0000-0000-0000000000ff', 0,
        'A synthetic chip club: one player''s chip entry meets the same player''s Diamond doors.',
        'Chips', true);
INSERT INTO concurrency_fixture.targets
VALUES ('chip_club', 'c0000000-0000-0000-0000-0000000000c1'),
       ('mtt_chip', (public.fn_create_tournament('c0000000-0000-0000-0000-0000000000c1', jsonb_build_object(
          'name', 'Concurrency Chip Freeroll', 'type', 'mtt', 'gameVariant', 'NLH', 'buyIn', 0,
          'maxPlayers', 60, 'minPlayers', 2, 'startingStack', 10000,
          'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
          'payoutStructure', '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
          'startTime', (now() + interval '1 hour')::text))->>'tournament_id')::uuid);
SELECT concurrency_fixture.ok((SELECT count(*) = 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
                                WHERE c.asset = 'chips' AND t.buy_in_amount = 0
                                  AND t.id = (SELECT id FROM concurrency_fixture.targets WHERE name = 'mtt_chip')),
 'the chip create door opened one chip freeroll in a chip club the staff account owns');

-- ============================================================================
-- THE HARNESS. Everything below lives in schema concurrency_fixture and is
-- never a money door: it reads the money state, and it can pause a door at a
-- named point so a controller session can kill it there.
-- ============================================================================
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false), set_config('request.jwt.claim.sub', '', false),
       set_config('request.jwt.claim.role', '', false);

-- Every invariant the cases require after every interleaving, crash and retry.
CREATE FUNCTION concurrency_fixture.invariants()
RETURNS TABLE(name text, ok boolean, detail text) LANGUAGE sql STABLE AS $f$
  SELECT 'no wallet below zero',
         NOT EXISTS (SELECT 1 FROM public.profiles WHERE diamonds < 0),
         (SELECT string_agg(id::text || '=' || diamonds, ', ') FROM public.profiles WHERE diamonds < 0)
  UNION ALL
  SELECT 'every wallet equals its journal',
         NOT EXISTS (SELECT 1 FROM public.profiles p
                      WHERE p.diamonds <> COALESCE((SELECT sum(t.amount) FROM public.diamond_transactions t
                                                     WHERE t.user_id = p.id), 0)),
         (SELECT string_agg(p.id::text, ', ') FROM public.profiles p
           WHERE p.diamonds <> COALESCE((SELECT sum(t.amount) FROM public.diamond_transactions t
                                          WHERE t.user_id = p.id), 0))
  UNION ALL
  SELECT 'every custody row equals its movements',
         NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                      WHERE c.balance <> COALESCE((SELECT sum(CASE WHEN m.action = 'reserve' THEN m.amount ELSE -m.amount END)
                                                     FROM public.poker_diamond_movements m WHERE m.custody_id = c.id), 0)),
         (SELECT string_agg(c.id::text, ', ') FROM public.poker_diamond_custody c
           WHERE c.balance <> COALESCE((SELECT sum(CASE WHEN m.action = 'reserve' THEN m.amount ELSE -m.amount END)
                                          FROM public.poker_diamond_movements m WHERE m.custody_id = c.id), 0))
  UNION ALL
  SELECT 'every movement names a journal row that exists',
         NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m
                      WHERE m.wallet_journal_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions t WHERE t.id = m.wallet_journal_id)),
         NULL
  UNION ALL
  SELECT 'every arena journal row names its movement or its ledger row',
         NOT EXISTS (SELECT 1 FROM public.diamond_transactions t
                      WHERE (t.source = 'poker_arena' OR t.type IN ('arena_deposit', 'arena_withdraw'))
                        AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m WHERE m.wallet_journal_id = t.id)
                        AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.wallet_journal_id = t.id)),
         (SELECT string_agg(t.id::text || ':' || t.type, ', ') FROM public.diamond_transactions t
           WHERE (t.source = 'poker_arena' OR t.type IN ('arena_deposit', 'arena_withdraw'))
             AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m WHERE m.wallet_journal_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.wallet_journal_id = t.id))
  UNION ALL
  SELECT 'every tournament ledger row names a journal row that exists',
         NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                      WHERE l.wallet_journal_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions t WHERE t.id = l.wallet_journal_id)),
         NULL
  UNION ALL
  SELECT 'no claimed purchase receipt is left without its response',
         NOT EXISTS (SELECT 1 FROM public.entry_purchase_idempotency_receipts WHERE response IS NULL),
         (SELECT string_agg(key_domain || ':' || idempotency_key, ', ') FROM public.entry_purchase_idempotency_receipts
           WHERE response IS NULL)
  UNION ALL
  SELECT 'every live Diamond seat holds exactly its own custody, and every seat custody has its seat',
         NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                       JOIN public.clubs c ON c.id = t.club_id AND c.asset = 'diamonds'
                      WHERE s.left_at IS NULL AND t.tournament_id IS NULL
                        AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody d
                                         WHERE d.seat_id = s.id AND d.occupancy_id = s.occupancy_id
                                           AND d.state = 'active' AND d.balance = s.stack))
         AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody d
                          WHERE d.purpose = 'cash_seat' AND d.state <> 'released'
                            AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                                             WHERE s.id = d.seat_id AND s.occupancy_id = d.occupancy_id
                                               AND s.left_at IS NULL)),
         NULL
  UNION ALL
  SELECT 'every wallet transfer carries both journal legs',
         NOT EXISTS (SELECT 1 FROM public.diamond_wallet_transfers w
                      WHERE NOT EXISTS (SELECT 1 FROM public.diamond_transactions t WHERE t.id = w.sender_journal_id
                                          AND t.user_id = w.sender_id AND t.amount = -w.amount)
                         OR NOT EXISTS (SELECT 1 FROM public.diamond_transactions t WHERE t.id = w.recipient_journal_id
                                          AND t.user_id = w.recipient_id AND t.amount = w.amount)),
         NULL
  UNION ALL
  SELECT 'every transfer journal row belongs to a transfer',
         NOT EXISTS (SELECT 1 FROM public.diamond_transactions t
                      WHERE t.source = 'wallet_diamond_transfer'
                        AND NOT EXISTS (SELECT 1 FROM public.diamond_wallet_transfers w
                                         WHERE t.id IN (w.sender_journal_id, w.recipient_journal_id))),
         NULL
  UNION ALL
  SELECT 'every store debit has exactly one purchase receipt, and every granted receipt one debit',
         NOT EXISTS (SELECT 1 FROM public.diamond_transactions t
                      WHERE t.reference_id LIKE 'feat\_%'
                        AND NOT EXISTS (SELECT 1 FROM public.digital_purchase_receipts r
                                         WHERE t.reference_id = 'feat_' || r.user_id || '_' || r.request_id))
         AND NOT EXISTS (SELECT 1 FROM public.digital_purchase_receipts r
                          WHERE (r.result->>'granted')::boolean
                            AND (SELECT count(*) FROM public.diamond_transactions t
                                  WHERE t.user_id = r.user_id AND t.reference_id = 'feat_' || r.user_id || '_' || r.request_id) <> 1),
         NULL
  UNION ALL
  SELECT 'every cash-out receipt released exactly the custody of its occupancy',
         NOT EXISTS (SELECT 1 FROM public.seat_cashout_receipts r
                      WHERE r.receipt->>'asset' = 'diamonds'
                        AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody d
                                         WHERE d.occupancy_id = r.occupancy_id AND d.state = 'released'
                                           AND d.balance = 0)),
         NULL
  UNION ALL
  SELECT 'every Diamond tournament escrow equals its custody',
         NOT EXISTS (SELECT 1 FROM public.tournaments tt JOIN public.clubs c ON c.id = tt.club_id AND c.asset = 'diamonds'
                      WHERE (SELECT e.prize_balance + e.bounty_balance + e.fee_balance
                               FROM public.fn_poker_diamond_tournament_escrow(tt.id) e)
                            IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(tt.id)::numeric),
         NULL
  UNION ALL
  SELECT 'the supply identity is whole: players + house + custody = register',
         (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) = 0,
         (SELECT to_jsonb(r)::text FROM public.fn_ca_diamond_register_vs_supply() r);
$f$;

-- The money a set of players holds or has moved, as one comparable document.
CREATE FUNCTION concurrency_fixture.money(p_users uuid[]) RETURNS jsonb LANGUAGE sql STABLE AS $f$
  SELECT jsonb_build_object(
    'wallets', (SELECT jsonb_object_agg(id, diamonds) FROM public.profiles WHERE id = ANY(p_users)),
    'custody', (SELECT COALESCE(sum(balance), 0) FROM public.poker_diamond_custody WHERE user_id = ANY(p_users)),
    'custody_rows', (SELECT count(*) FROM public.poker_diamond_custody WHERE user_id = ANY(p_users)),
    'journal_rows', (SELECT count(*) FROM public.diamond_transactions WHERE user_id = ANY(p_users)),
    'movements', (SELECT count(*) FROM public.poker_diamond_movements WHERE user_id = ANY(p_users)),
    'ledger_rows', (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE user_id = ANY(p_users)),
    'transfers', (SELECT count(*) FROM public.diamond_wallet_transfers WHERE sender_id = ANY(p_users) OR recipient_id = ANY(p_users)),
    'purchases', (SELECT count(*) FROM public.digital_purchase_receipts WHERE user_id = ANY(p_users)),
    'grants', (SELECT count(*) FROM public.feature_purchases WHERE user_id = ANY(p_users)),
    'live_seats', (SELECT count(*) FROM public.table_seats WHERE user_id = ANY(p_users) AND left_at IS NULL),
    'seat_rows', (SELECT count(*) FROM public.table_seats WHERE user_id = ANY(p_users)),
    'cashout_receipts', (SELECT count(*) FROM public.seat_cashout_receipts WHERE user_id = ANY(p_users)),
    'roster', (SELECT COALESCE(jsonb_agg(jsonb_build_array(tournament_id, status, chips, rebuys) ORDER BY tournament_id, user_id), '[]')
                 FROM public.tournament_players WHERE user_id = ANY(p_users)),
    'credit_keys', (SELECT count(*) FROM public.wallet_credit_idempotency WHERE user_id = ANY(p_users)),
    'entry_receipts', (SELECT count(*) FROM public.entry_purchase_idempotency_receipts
                        WHERE request->>'user_id' = ANY(p_users::text[])));
$f$;

-- A pause gate: an AFTER trigger that waits on an advisory lock when the
-- session has asked to be paused at this point. The controller holds the lock,
-- proves the door is waiting on it, and kills the session there.
CREATE FUNCTION concurrency_fixture.gate() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF current_setting('concurrency.pause_at', true) = TG_ARGV[0] THEN
    PERFORM set_config('concurrency.pause_at', '', true);
    PERFORM pg_advisory_xact_lock(hashtext('concurrency-gate:' ||
      COALESCE(NULLIF(current_setting('concurrency.pause_lock', true), ''), TG_ARGV[0])));
  ELSIF current_setting('concurrency.trace', true) = 'on' THEN
    RAISE NOTICE 'GATE %', TG_ARGV[0];
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END $f$;
-- A gate fires AFTER the row its door wrote, last of that row's triggers, so a
-- door paused there has done that write. roster_entry is the one BEFORE gate:
-- it fires as the roster row goes in, after the entry gate and before the
-- roster trigger takes the player's table-cap lock (trg_enforce_booking_game_cap),
-- which is the point a registration holds the profile row and not yet the cap.
CREATE TABLE concurrency_fixture.gate_points(name text PRIMARY KEY, relation regclass NOT NULL, event text NOT NULL,
                                             timing text NOT NULL DEFAULT 'AFTER');
INSERT INTO concurrency_fixture.gate_points VALUES
  ('claim', 'public.entry_purchase_idempotency_receipts', 'INSERT'),
  ('receipt', 'public.entry_purchase_idempotency_receipts', 'UPDATE'),
  ('custody', 'public.poker_diamond_custody', 'INSERT'),
  ('custody_update', 'public.poker_diamond_custody', 'UPDATE'),
  ('journal', 'public.diamond_transactions', 'INSERT'),
  ('wallet', 'public.profiles', 'UPDATE'),
  ('movement', 'public.poker_diamond_movements', 'INSERT'),
  ('seat', 'public.table_seats', 'INSERT'),
  ('seat_update', 'public.table_seats', 'UPDATE'),
  ('transfer_row', 'public.diamond_wallet_transfers', 'INSERT'),
  ('grant', 'public.feature_purchases', 'INSERT'),
  ('purchase_row', 'public.digital_purchase_receipts', 'INSERT'),
  ('cashout_receipt', 'public.seat_cashout_receipts', 'INSERT'),
  ('roster', 'public.tournament_players', 'INSERT'),
  ('roster_entry', 'public.tournament_players', 'INSERT'),
  ('roster_update', 'public.tournament_players', 'UPDATE'),
  ('ledger', 'public.poker_diamond_tournament_ledger', 'INSERT'),
  ('credit_key', 'public.wallet_credit_idempotency', 'INSERT');
UPDATE concurrency_fixture.gate_points SET timing = 'BEFORE' WHERE name = 'roster_entry';
CREATE FUNCTION concurrency_fixture.install_gates(p_on boolean) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE r record; n integer := 0;
BEGIN
  PERFORM set_config('client_min_messages', 'warning', true);
  FOR r IN SELECT g.*, CASE g.timing WHEN 'BEFORE' THEN 'trg_d_concurrency_gate_'
                                    ELSE 'zzzzzzzz_concurrency_gate_' END || g.name AS tg
             FROM concurrency_fixture.gate_points g LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', r.tg, r.relation);
    IF p_on THEN
      EXECUTE format('CREATE TRIGGER %I %s %s ON %s FOR EACH ROW EXECUTE FUNCTION concurrency_fixture.gate(%L)',
                     r.tg, r.timing, r.event, r.relation, r.name);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $f$;
GRANT USAGE ON SCHEMA concurrency_fixture TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION concurrency_fixture.gate() TO authenticated, service_role;
SELECT concurrency_fixture.ok((SELECT bool_and(ok) FROM concurrency_fixture.invariants()),
 'the scene starts with every invariant holding and the supply identity whole');
