-- ============================================================================
-- THE DIAMOND ARENA'S SCHEDULED TOURNAMENTS: THE MONEY CASES
-- ============================================================================
-- PRIVATE ISOLATED FIXTURE ONLY. Run by run-diamond-scheduled-tournaments.py
-- after migration 20261007000010 has been applied verbatim to a cluster that
-- run creates, owns and destroys. Every Diamond below moves in that throwaway
-- cluster and nowhere else. The players are the concurrency scene's synthetic
-- accounts (500 Diamonds each from the real signup path); the house is funded
-- here by a fixture register row so it has something to set aside.
-- Every amount is a fixture amount except the fee and overlay arithmetic,
-- which is the doors' own.
-- ============================================================================
DO $guard$ BEGIN
  IF current_database() <> 'diamond_concurrency' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'isolated Diamond scheduled-tournament fixture only';
  END IF;
END $guard$;

CREATE SCHEMA sched;
GRANT USAGE ON SCHEMA sched TO PUBLIC;
CREATE TABLE sched.ids (k text PRIMARY KEY, v uuid);
CREATE TABLE sched.res (k text PRIMARY KEY, v jsonb);
GRANT ALL ON sched.ids, sched.res TO PUBLIC;

CREATE FUNCTION sched.ok(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', p_label; END IF;
  RAISE NOTICE 'PASS: %', p_label;
END $$;
CREATE FUNCTION sched.p(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('10000000-0000-0000-0000-0000000000' || lpad(to_hex(n), 2, '0'))::uuid $$;
CREATE FUNCTION sched.id(p_k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM sched.ids WHERE k = p_k $$;
CREATE FUNCTION sched.r(p_k text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT v FROM sched.res WHERE k = p_k $$;
-- Contexts, as PostgREST would set them.
CREATE FUNCTION sched.as_user(u uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('role','authenticated','sub',u,
           'session_id',uuid_in(md5('concurrency-session:'||u)::cstring))::text, false),
         set_config('request.jwt.claim.sub', u::text, false),
         set_config('request.jwt.claim.role', 'authenticated', false),
         set_config('request.headers', '{}', false) $$;
CREATE FUNCTION sched.as_service() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false),
         set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.role', 'service_role', false),
         set_config('request.headers', '{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}', false) $$;
-- The books are whole: the supply identity closes and every Diamond event's
-- banks equal its custody.
CREATE FUNCTION sched.whole() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) = 0
     AND NOT EXISTS (
       SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id AND c.asset = 'diamonds'
        WHERE (SELECT e.prize_balance + e.bounty_balance + e.fee_balance
                 FROM public.fn_poker_diamond_tournament_escrow(t.id) e)
              IS DISTINCT FROM public.fn_poker_diamond_tournament_custody(t.id)::numeric) $$;
CREATE FUNCTION sched.house() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT balance FROM public.ca_diamond_house WHERE id = 1 $$;
CREATE FUNCTION sched.open(p_t uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT public.fn_ca_diamond_earmark_open('guarantee:' || p_t::text) $$;
CREATE FUNCTION sched.cfg(p_extra jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'name', 'Scheduled', 'type', 'mtt', 'gameVariant', 'nlh', 'buyIn', 10,
    'maxPlayers', 500, 'minPlayers', 2, 'startingStack', 10000, 'horsesToRegister', 0,
    'blindStructure', '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure', '[{"place":1,"percentage":60},{"place":2,"percentage":40}]'::jsonb) || p_extra $$;
-- The engine's start: the atomic launch's receipt and its transaction marker,
-- then the REGISTERING -> RUNNING write the lock trigger fires on.
CREATE FUNCTION sched.lock(p_t uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_launch uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.tournament_launch_receipts(tournament_id, launch_id, started_at) VALUES (p_t, v_launch, now());
  PERFORM set_config('app.atomic_tournament_launch', p_t::text || ':' || v_launch::text, true);
  UPDATE public.tournaments SET status = 'RUNNING', started_at = now() WHERE id = p_t;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sched TO PUBLIC;

-- ── THE SCENE ──────────────────────────────────────────────────────────────
-- The house holds 100,000 Diamonds, registered as a Mint issuance so the
-- supply identity closes. One schedule row for the arena, one for a chip club.
INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
DO $$
DECLARE v_supply numeric; v_before numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_supply
    FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  SELECT balance INTO v_before FROM public.ca_diamond_house WHERE id = 1;
  UPDATE public.ca_diamond_house SET balance = balance + 100000 WHERE id = 1;
  INSERT INTO public.ca_mint_ledger (op_id, action, asset, holder_type, holder_id, holder_label, amount,
    balance_before, balance_after, supply_after, reason)
  VALUES ('fixture-house-funding', 'mint', 'diamonds', 'house', '00000000-0000-0000-0000-00000000d1a0',
    'the house', 100000, v_before, v_before + 100000, v_supply + 100000, 'fixture: the owner funds the house');
END $$;
INSERT INTO sched.ids VALUES
  ('arena', '002c2d27-9584-4e52-835a-bb2be148fc81'),
  ('horse', sched.p(48));
WITH s AS (INSERT INTO public.tournament_schedules
  (union_id, club_id, name, description, active, days_of_week, start_times_utc, config)
  VALUES (NULL, '002c2d27-9584-4e52-835a-bb2be148fc81', 'Fixture Diamond Board', 'fixture', true,
          ARRAY[0,1,2,3,4,5,6], ARRAY['14:00'], '{}'::jsonb) RETURNING id)
INSERT INTO sched.ids SELECT 'sched', id FROM s;
-- One fixture player is a horse. Its Diamonds are its own (A18, own_balance).
UPDATE public.profiles SET is_horse = true WHERE id = sched.id('horse');
SELECT sched.ok((SELECT is_horse FROM public.profiles WHERE id = sched.id('horse'))
  AND sched.whole() AND sched.house() = 100000,
  'scene: the house holds 100,000, one fixture player is a horse, the books are whole');

-- ── 1. NOBODY BUT THE SERVICE ROLE SPAWNS ──────────────────────────────────
SELECT sched.as_user(sched.p(1));
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.fn_poker_diamond_spawn_scheduled_tournament(sched.id('sched'), now() + interval '1 day', sched.cfg('{}'));
  RAISE EXCEPTION 'FAIL: a signed-in player reached the scheduled door';
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM sched.ok(true, 'a signed-in player is refused at the door (no EXECUTE)');
END $$;
RESET ROLE;
-- Even from inside a definer path, a non-service JWT is answered with the refusal.
INSERT INTO sched.res SELECT 'not_service',
  public.fn_poker_diamond_spawn_scheduled_tournament(sched.id('sched'), now() + interval '1 day', sched.cfg('{}'));
SELECT sched.ok(sched.r('not_service') = '{"ok": false, "reason": "service_role_only"}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM public.tournaments WHERE schedule_id = sched.id('sched')),
  'a caller whose JWT is not service_role gets {ok:false, reason:service_role_only} and nothing is created');

-- ── 2. A SPAWN IS PRICED AS MIDWAY PRICES (10%, 5% at a 2-seat cap, floored) ─
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'p10', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '1 day', sched.cfg('{"name":"Turbo 10","buyIn":10}'));
INSERT INTO sched.res SELECT 'p5', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '1 day 1 hour', sched.cfg('{"name":"Turbo 5","buyIn":5}'));
INSERT INTO sched.res SELECT 'p3', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '1 day 2 hours', sched.cfg('{"name":"Turbo 3","buyIn":3}'));
INSERT INTO sched.res SELECT 'hu', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '1 day 3 hours',
  sched.cfg('{"name":"Duel 100","type":"sng","buyIn":100,"maxPlayers":2,"payoutStructure":[{"place":1,"percentage":100}]}'));
RESET ROLE;
INSERT INTO sched.ids SELECT k, (v->>'tournament_id')::uuid FROM sched.res WHERE k IN ('p10','p5','p3','hu');
SELECT sched.ok((SELECT buy_in_amount = 9 AND buy_in_fee = 1 AND guaranteed_prize = 0 AND union_id IS NULL
                   AND schedule_id = sched.id('sched') AND public.fn_poker_diamond_tournament(id)
                   FROM public.tournaments WHERE id = sched.id('p10')),
  'a 10 Diamond entry spawns as 9 to the pool + 1 fee (10%), union_id NULL, schedule recorded, a Diamond event');
SELECT sched.ok((SELECT buy_in_amount = 5 AND buy_in_fee = 0 FROM public.tournaments WHERE id = sched.id('p5'))
            AND (SELECT buy_in_amount = 3 AND buy_in_fee = 0 FROM public.tournaments WHERE id = sched.id('p3')),
  'a 5 and a 3 Diamond entry pay no fee: 10% floored to a whole Diamond is 0, Midway''s price is kept');
SELECT sched.ok((SELECT buy_in_amount = 95 AND buy_in_fee = 5 FROM public.tournaments WHERE id = sched.id('hu')),
  'a field capped at 2 pays 5%: 100 spawns as 95 + 5');

-- ── 3. A REPLAY MOVES NOTHING ──────────────────────────────────────────────
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'p10_again', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '1 day', sched.cfg('{"name":"Turbo 10","buyIn":10}'));
RESET ROLE;
SELECT sched.ok(sched.r('p10_again') = jsonb_build_object('ok', true, 'tournament_id', sched.id('p10'), 'replayed', true)
  AND (SELECT count(*) FROM public.tournaments WHERE schedule_id = sched.id('sched')) = 4
  AND (SELECT count(*) FROM public.ca_diamond_scheduled_spawns) = 4,
  'the same (schedule, start) again returns the same tournament with replayed:true and creates nothing');

-- ── 4. A GUARANTEE IS SET ASIDE AT CREATION; THE CAPS REFUSE BY NAME ─────────
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'g', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '2 days',
  sched.cfg('{"name":"Guaranteed 100","buyIn":10,"guaranteedPrize":100}'));
INSERT INTO sched.res SELECT 'over_house', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '2 days 2 hours',
  sched.cfg('{"name":"Unfunded","buyIn":10,"guaranteedPrize":200000}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'g', (sched.r('g')->>'tournament_id')::uuid;
SELECT sched.ok((SELECT guaranteed_prize = 100 FROM public.tournaments WHERE id = sched.id('g'))
  AND sched.open(sched.id('g')) = 100 AND public.fn_ca_diamond_house_available() = 99900
  AND sched.house() = 100000 AND sched.whole(),
  'a 100 guarantee opens a 100 earmark on the house at creation: available falls to 99,900, no Diamond moves, books whole');
-- The house is topped up past the per-event cap, so the cap and not the
-- balance is what refuses the next one.
DO $$
DECLARE v_supply numeric; v_before numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_supply
    FROM public.ca_mint_ledger WHERE asset = 'diamonds';
  SELECT balance INTO v_before FROM public.ca_diamond_house WHERE id = 1;
  UPDATE public.ca_diamond_house SET balance = balance + 1000000 WHERE id = 1;
  INSERT INTO public.ca_mint_ledger (op_id, action, asset, holder_type, holder_id, holder_label, amount,
    balance_before, balance_after, supply_after, reason)
  VALUES ('fixture-house-funding-2', 'mint', 'diamonds', 'house', '00000000-0000-0000-0000-00000000d1a0',
    'the house', 1000000, v_before, v_before + 1000000, v_supply + 1000000, 'fixture: the owner funds the house again');
END $$;
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'over_cap', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '2 days 1 hour',
  sched.cfg('{"name":"Too Big","buyIn":10,"guaranteedPrize":1000001}'));
RESET ROLE;
SELECT sched.ok(sched.r('over_cap')->>'reason' = 'diamond_guarantee_over_per_event_cap'
  AND sched.r('over_house')->>'reason' = 'diamond_house_cannot_set_aside'
  AND NOT EXISTS (SELECT 1 FROM public.tournaments WHERE name IN ('Too Big','Unfunded'))
  AND (SELECT count(*) FROM public.ca_diamond_house_earmarks) = 1,
  'over the 1,000,000 per-event cap, and over what the house has available, the spawn is refused by name and writes nothing');

-- ── 5. A HUMAN AND A HORSE REGISTER THROUGH THE SAME DOOR ───────────────────
SELECT sched.as_user(sched.p(1));
SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_a', public.fn_register_for_tournament_request(sched.id('g'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_user(sched.p(2));
SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_b', public.fn_register_for_tournament_request(sched.id('g'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'reg_h', public.fn_register_horse_for_tournament(sched.id('g'), sched.id('horse'), true);
RESET ROLE;
SELECT sched.ok((sched.r('reg_a')->>'ok')::boolean AND (sched.r('reg_b')->>'ok')::boolean AND (sched.r('reg_h')->>'ok')::boolean
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.p(1)) = 490
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.id('horse')) = 490
  AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger l
        WHERE l.tournament_id = sched.id('g') AND l.kind = 'entry' AND l.amount = 10
          AND l.prize_part = 9 AND l.fee_part = 1) = 3
  AND (SELECT prize_pool FROM public.tournaments WHERE id = sched.id('g')) = 27 AND sched.whole(),
  'two humans and a horse each pay 10 from their own wallet into custody (9 pool + 1 fee), identical ledger rows (CLAUDE.md 10.5)');

-- ── 6. AT LOCK THE HOUSE PAYS THE OVERLAY INTO CUSTODY ──────────────────────
SELECT sched.as_service();
SELECT sched.lock(sched.id('g'));
SELECT sched.ok((SELECT status = 'RUNNING' AND prize_pool = 100 FROM public.tournaments WHERE id = sched.id('g'))
  AND (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(sched.id('g'))) = 100
  AND (SELECT overlay_in FROM public.fn_poker_diamond_tournament_escrow(sched.id('g'))) = 73
  AND public.fn_poker_diamond_tournament_custody(sched.id('g')) = 103
  AND sched.house() = 1100000 - 73
  AND (SELECT array_agg(amount ORDER BY amount DESC) FROM public.poker_diamond_tournament_ledger
        WHERE tournament_id = sched.id('g') AND kind = 'overlay') = ARRAY[25,24,24]::bigint[]
  AND sched.whole(),
  'at lock the 73 shortfall moves house -> custody (25/24/24 across the three entries), pool 100, custody 103 = banks, identity whole');
SELECT sched.ok(sched.open(sched.id('g')) = 0
  AND (SELECT array_agg(entry || ':' || amount ORDER BY id) FROM public.ca_diamond_house_earmarks
        WHERE earmark_key = 'guarantee:' || sched.id('g')) = ARRAY['open:100','pay:73','release:27']
  AND public.fn_ca_diamond_house_available() = 1100000 - 73,
  'the earmark records pay 73 and releases the unused 27 at lock; available is the house balance again');
SELECT sched.ok((SELECT count(*) FROM public.ca_mint_ledger m
                  WHERE m.diamond_tx_id IN (SELECT wallet_journal_id FROM public.poker_diamond_tournament_ledger
                                             WHERE tournament_id = sched.id('g') AND kind = 'overlay')
                    AND m.action = 'mint' AND m.holder_type = 'player') = 3
  AND (SELECT amount FROM public.ca_mint_ledger WHERE op_id = 'poker-guarantee-overlay:' || sched.id('g') || ':lock') = 73,
  'the crossing is a registered pair: one house burn of 73, three player-side credits that never touch a wallet');

-- ── 7. THE HUMAN AND THE HORSE ARE PAID IDENTICALLY ────────────────────────
SELECT sched.as_service();
INSERT INTO sched.res SELECT 'pay_1', to_jsonb(public.fn_poker_diamond_tournament_pay(sched.p(1), 50, 'fx-g-1', 'prize', sched.id('g'), 'first'));
INSERT INTO sched.res SELECT 'pay_2', to_jsonb(public.fn_poker_diamond_tournament_pay(sched.id('horse'), 50, 'fx-g-2', 'prize', sched.id('g'), 'second'));
SELECT sched.ok(sched.r('pay_1') = 'true'::jsonb AND sched.r('pay_2') = 'true'::jsonb,
  'the pay door pays a human 50 and a horse 50 from the guaranteed pool');
SELECT sched.ok((SELECT diamonds FROM public.profiles WHERE id = sched.p(1)) = 540
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.id('horse')) = 540
  AND (SELECT count(DISTINCT (t.type, t.amount, t.issuance_class)) FROM public.diamond_transactions t
        WHERE t.reference_id IN ('poker-tournament-pay:fx-g-1','poker-tournament-pay:fx-g-2')) = 1
  AND (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(sched.id('g'))) = 0 AND sched.whole(),
  'human and horse each hold 540, by the same journal type and class; the prize bank is spent and the books are whole');

-- ── 8. COMPLETION SETTLES THE FEE AND CLOSES CUSTODY AND THE PROMISE ────────
INSERT INTO sched.res SELECT 'g_fee', public.fn_poker_diamond_tournament_settle_fee(sched.id('g'), 'fixture');
INSERT INTO sched.res SELECT 'g_close', public.fn_poker_diamond_tournament_close_custody(sched.id('g'));
SELECT sched.ok((sched.r('g_fee')->>'amount')::numeric = 3
  AND (sched.r('g_close')->>'closed')::int = 3
  AND sched.open(sched.id('g')) = 0 AND sched.house() = 1100000 - 73 + 3 AND sched.whole(),
  'at completion the 3 fees reach the house, all three custody rows close and the guarantee holds nothing open');

-- ── 9. A CANCELLED GUARANTEED EVENT RELEASES ITS EARMARK ───────────────────
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'gc', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '3 days',
  sched.cfg('{"name":"Cancelled 500","buyIn":20,"guaranteedPrize":500}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'gc', (sched.r('gc')->>'tournament_id')::uuid;
SELECT sched.as_user(sched.p(3));
SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_c', public.fn_register_for_tournament_request(sched.id('gc'), gen_random_uuid());
RESET ROLE;
SELECT sched.ok(sched.open(sched.id('gc')) = 500 AND (SELECT diamonds FROM public.profiles WHERE id = sched.p(3)) = 480,
  'a second guaranteed event earmarks 500 and takes a 20 entry');
SELECT sched.as_service();
INSERT INTO sched.res SELECT 'gc_cancel', public.fn_poker_diamond_tournament_cancel(sched.id('gc'), NULL);
SELECT sched.ok((sched.r('gc_cancel')->>'ok')::boolean
  AND sched.open(sched.id('gc')) = 0
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.p(3)) = 500
  AND (SELECT entry FROM public.ca_diamond_house_earmarks WHERE earmark_key = 'guarantee:' || sched.id('gc')
        ORDER BY id DESC LIMIT 1) = 'release'
  AND sched.whole(),
  'cancelling it refunds the 20 whole and releases the 500 earmark; no Diamond left the house');

-- ── 10. THE POOL CLOSE RETURNS OVERLAY THE ENTRIES MADE UNNECESSARY ─────────
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'gx', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '4 days',
  sched.cfg('{"name":"Floor 30","buyIn":10,"guaranteedPrize":30,"isRebuy":true,"rebuyCost":10}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'gx', (sched.r('gx')->>'tournament_id')::uuid;
SELECT sched.as_user(sched.p(4)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_x1', public.fn_register_for_tournament_request(sched.id('gx'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_user(sched.p(5)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_x2', public.fn_register_for_tournament_request(sched.id('gx'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_service();
SELECT sched.lock(sched.id('gx'));
SELECT sched.ok((SELECT prize_pool FROM public.tournaments WHERE id = sched.id('gx')) = 30
  AND (SELECT overlay_in FROM public.fn_poker_diamond_tournament_escrow(sched.id('gx'))) = 12 AND sched.whole(),
  'a 30 guarantee over two 9-Diamond prize parts is topped up by 12 at lock');
-- A rebuy after lock through the Diamond money door adds 9 to the pool.
INSERT INTO sched.res SELECT 'gx_rebuy', public.fn_poker_diamond_tournament_charge(sched.p(4), sched.id('gx'), 'rebuy', 10, 9, 0, 1,
  (SELECT id FROM public.tournament_players WHERE tournament_id = sched.id('gx') AND user_id = sched.p(4)), 'fx-gx-rebuy');
SELECT sched.ok((sched.r('gx_rebuy')->>'success')::boolean,
  'a 10 Diamond rebuy after lock enters custody (9 pool + 1 fee)');
UPDATE public.tournaments SET prize_pool = prize_pool + 9, total_rake = total_rake + 1 WHERE id = sched.id('gx');
INSERT INTO sched.res SELECT 'gx_close', public.fn_apply_prize_guarantee(sched.id('gx'), 'fixture');
SELECT sched.ok((sched.r('gx_close')->>'ok')::boolean
  AND (SELECT prize_pool FROM public.tournaments WHERE id = sched.id('gx')) = 30
  AND (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(sched.id('gx'))) = 30
  AND (SELECT sum(amount) FROM public.poker_diamond_tournament_ledger WHERE tournament_id = sched.id('gx') AND kind = 'overlay_return') = 9
  AND sched.house() = 1100000 - 73 + 3 - 12 + 9 AND sched.whole(),
  'when the pool closes, collected 27 against a 30 floor needs only 3 of the 12 overlay: 9 returns custody -> house, pool 30, books whole');

-- ── 11. A FREEROLL: FREE TO ENTER, 1-DIAMOND REBUY AND ADD-ON, ALL TO THE POOL ─
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'fr', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '5 days',
  sched.cfg('{"name":"Freeroll 100","buyIn":0,"guaranteedPrize":100,"isRebuy":true,"rebuyCost":1,"addOnAvailable":true,"addonCost":1,"rebuyChips":5000,"addonChips":10000}'));
INSERT INTO sched.res SELECT 'fr_no_g', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '5 days 1 hour',
  sched.cfg('{"name":"Freeroll Nothing","buyIn":0}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'fr', (sched.r('fr')->>'tournament_id')::uuid;
SELECT sched.ok((SELECT buy_in_amount = 0 AND buy_in_fee = 0 AND is_rebuy AND add_on_available
                   AND rebuy_cost = 1 AND addon_cost = 1 AND rebuy_chips = 5000 AND addon_chips = 10000
                   AND guaranteed_prize = 100 FROM public.tournaments WHERE id = sched.id('fr'))
  AND sched.open(sched.id('fr')) = 100
  AND sched.r('fr_no_g')->>'reason' = 'diamond_freeroll_requires_a_guarantee',
  'a freeroll spawns free with 1-Diamond rebuy and add-on and its 100 guarantee set aside; one with no guarantee is refused');
SELECT sched.as_user(sched.p(6)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'fr_a', public.fn_register_for_tournament_request(sched.id('fr'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_service(); SET ROLE service_role;
INSERT INTO sched.res SELECT 'fr_h', public.fn_register_horse_for_tournament(sched.id('fr'), sched.id('horse'), true);
RESET ROLE;
SELECT sched.ok((sched.r('fr_a')->>'ok')::boolean AND (sched.r('fr_h')->>'ok')::boolean
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.p(6)) = 500
  AND (SELECT count(*) FROM public.poker_diamond_custody c WHERE c.target_id = sched.id('fr')
        AND c.purpose = 'tournament_entry' AND c.state = 'active' AND c.balance = 0) = 2
  AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE tournament_id = sched.id('fr')),
  'a human and a horse enter the freeroll for nothing: each holds an active entry at zero, no ledger row, no wallet moved');
-- Withdrawing a free entry releases it at zero.
SELECT sched.as_user(sched.p(6)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'fr_un', public.fn_unregister_from_tournament(sched.id('fr'), gen_random_uuid());
RESET ROLE;
SELECT sched.ok((sched.r('fr_un')->>'ok')::boolean AND (sched.r('fr_un')->>'refunded_diamonds')::numeric = 0
  AND NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id = sched.id('fr') AND user_id = sched.p(6)),
  'a free entry is withdrawn at zero');
SELECT sched.as_user(sched.p(6)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'fr_a2', public.fn_register_for_tournament_request(sched.id('fr'), gen_random_uuid());
RESET ROLE;
SELECT sched.as_service();
SELECT sched.lock(sched.id('fr'));
SELECT sched.ok((sched.r('fr_a2')->>'ok')::boolean
  AND (SELECT prize_pool FROM public.tournaments WHERE id = sched.id('fr')) = 100
  AND (SELECT array_agg(amount ORDER BY amount) FROM public.poker_diamond_tournament_ledger
        WHERE tournament_id = sched.id('fr') AND kind = 'overlay') = ARRAY[50,50]::bigint[]
  AND sched.whole(),
  'at lock the whole 100 guarantee moves from the house into the two free entries, 50 each');
-- The rebuy and add-on price, as the purchase door computes it for this event.
SELECT sched.ok(public.fn_ca_recovery_fee_cents(100, public.fn_ca_tournament_fee_ratio(0, 0),
                  public.fn_ca_tournament_unit_cents(sched.id('fr'))) = 0,
  'the purchase door''s fee on a 1 Diamond freeroll rebuy is 0: the whole Diamond goes to the pool');
INSERT INTO sched.res SELECT 'fr_rebuy', public.fn_poker_diamond_tournament_charge(sched.p(6), sched.id('fr'), 'rebuy', 1, 1, 0, 0,
  (SELECT id FROM public.tournament_players WHERE tournament_id = sched.id('fr') AND user_id = sched.p(6)), 'fx-fr-rebuy');
INSERT INTO sched.res SELECT 'fr_addon', public.fn_poker_diamond_tournament_charge(sched.id('horse'), sched.id('fr'), 'addon', 1, 1, 0, 0,
  (SELECT id FROM public.tournament_players WHERE tournament_id = sched.id('fr') AND user_id = sched.id('horse')), 'fx-fr-addon');
SELECT sched.ok((sched.r('fr_rebuy')->>'success')::boolean AND (sched.r('fr_addon')->>'success')::boolean
  AND (SELECT diamonds FROM public.profiles WHERE id = sched.p(6)) = 499
  AND (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(sched.id('fr'))) = 102
  AND sched.whole(),
  'a 1 Diamond rebuy (human) and a 1 Diamond add-on (horse) land in the free entries and lift the pool to 102');

-- ── 12. A FRACTIONAL BOUNTY ROUNDS DOWN; THE REMAINDER STAYS IN THE POOL ────
SELECT sched.as_service();
SET ROLE service_role;
INSERT INTO sched.res SELECT 'bty', public.fn_poker_diamond_spawn_scheduled_tournament(
  sched.id('sched'), date_trunc('hour', now()) + interval '6 days',
  sched.cfg('{"name":"Bounty 10","type":"bounty","buyIn":10,"bountyAmount":2.5}'));
RESET ROLE;
INSERT INTO sched.ids SELECT 'bty', (sched.r('bty')->>'tournament_id')::uuid;
SELECT sched.as_user(sched.p(7)); SET ROLE authenticated;
INSERT INTO sched.res SELECT 'reg_bty', public.fn_register_for_tournament_request(sched.id('bty'), gen_random_uuid());
RESET ROLE;
SELECT sched.ok((SELECT bounty_amount = 2 AND buy_in_amount = 9 AND buy_in_fee = 1 FROM public.tournaments WHERE id = sched.id('bty'))
  AND (SELECT prize_part = 7 AND bounty_part = 2 AND fee_part = 1 FROM public.poker_diamond_tournament_ledger
        WHERE tournament_id = sched.id('bty') AND kind = 'entry') AND sched.whole(),
  'Midway''s 2.5 bounty becomes 2 whole Diamonds; the half goes to the pool: an entry of 10 is 7 pool + 2 bounty + 1 fee');

-- ── 13. THE STAFF DOOR STILL REQUIRES STAFF ────────────────────────────────
SELECT sched.as_user(sched.p(8));
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.fn_poker_diamond_create_tournament(sched.cfg('{"name":"Not Staff","guaranteedPrize":100}'));
  RAISE EXCEPTION 'FAIL: a player created a Diamond tournament';
EXCEPTION WHEN insufficient_privilege THEN
  PERFORM sched.ok(SQLERRM = 'diamond_tournament_staff_only', 'the staff door still refuses a player: diamond_tournament_staff_only');
END $$;
RESET ROLE;

SELECT sched.ok(sched.whole(), 'the cases end with the supply identity whole and every Diamond event''s banks equal to its custody');
