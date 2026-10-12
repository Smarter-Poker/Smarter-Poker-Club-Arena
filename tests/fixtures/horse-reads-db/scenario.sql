-- A treasury-funded seat reads as a Club Bank send (migration 20261012040542).
-- Run by scripts/ci/test-horse-reads-db-postgres.py as the session user
-- authenticator (as PostgREST calls it): once with production's live reads
-- (fn_club_trade_ledger as 20261010005048 leaves it), where exactly the twelve
-- assertions the harness names must FAIL, and once after the migration, where
-- all eighteen must PASS.
--
-- Club u(100): u(1) owns it, u(2) is a super agent, u(10) an agent whose
-- downline is u(21) (a person, alias Kingfish) and u(25) (a horse, alias
-- Quiet Rider). Receipts:
--   9101  the owner's Club Bank send of 40 to u(21)'s player wallet (stock note)
--   9102  the treasury funds u(25)'s seat, 60 (horse_treasury_funding)
--   9103  the treasury funds u(25)'s rebuy shortfall, 25 (horse_treasury_funding)
--   9104  the super agent's Club Bank send of 100 to u(10)'s agent wallet,
--         with a typed reason
--   9105  a peer transfer, 9106 a treasury mint whose note mentions horses,
--   9107  a Club Bank claim back from u(10)'s agent wallet
-- Treasury journal legs: 8101 and 8102 fund the two seats (horse_funding),
-- 8103 pays a commission, 8104 mints into the treasury.
CREATE TEMP TABLE scenario_result(name text, ok boolean);

CREATE FUNCTION pg_temp.check(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO scenario_result VALUES (name, coalesce(ok, false));
  IF coalesce(ok, false) THEN RAISE NOTICE 'PASS: %', name; ELSE RAISE NOTICE 'FAIL: %', name; END IF;
END $$;

-- Each viewer's Trade record, keyed by the receipt's last four digits.
CREATE FUNCTION pg_temp.trade(viewer int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(jsonb_object_agg(right(l.id::text, 4), to_jsonb(l)), '{}'::jsonb)
    INTO r FROM public.fn_club_trade_ledger(public.u(100), 251, 0) l;
  RESET ROLE;
  RETURN r;
END $$;

-- The Club Bank ledger's whole answer, optionally filtered by kind.
CREATE FUNCTION pg_temp.bank(viewer int, kinds text[] DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  r := public.fn_club_bank_ledger(public.u(100), 200, 0, kinds);
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.bank_rows(viewer int, kinds text[] DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(right(e->>'id', 4), e), '{}'::jsonb)
    FROM jsonb_array_elements(pg_temp.bank(viewer, kinds)->'rows') e
$$;

-- The treasury statement, both doors, keyed by the leg's last four digits.
CREATE FUNCTION pg_temp.treasury(viewer int, paged boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  IF paged THEN
    r := public.fn_ca_chip_statement_page('club_treasury', public.u(100), NULL, 50);
  ELSE
    r := public.fn_ca_chip_statement('club_treasury', public.u(100), NULL, 50);
  END IF;
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.legs(viewer int, paged boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(right(e->>'id', 4), e), '{}'::jsonb)
    FROM jsonb_array_elements(pg_temp.treasury(viewer, paged)->'legs') e
$$;

-- Everything a row says, less what makes it this row: its id, time, amount and
-- recipient (and, in the bank ledger, the bank balance after it).
CREATE FUNCTION pg_temp.shape(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT j - ARRAY['id', 'created_at', 'amount', 'to_user_id', 'to_name', 'balance_after']
$$;

SELECT pg_temp.check(pg_temp.trade(1) #>> '{9102,transaction_type}' = 'club_bank_send'
                 AND pg_temp.trade(1) #>> '{9103,transaction_type}' = 'club_bank_send',
  'a treasury-funded seat is a Club Bank send in the Trade record');
-- u(2) is not a party to the owner's send 9101, so it reads both as a third party.
SELECT pg_temp.check(pg_temp.shape(pg_temp.trade(2) -> '9102') = pg_temp.shape(pg_temp.trade(2) -> '9101')
                 AND pg_temp.shape(pg_temp.trade(2) -> '9103') = pg_temp.shape(pg_temp.trade(2) -> '9101'),
  'a funded seat and a person''s Club Bank send carry the same kind, sender, note and fields');
SELECT pg_temp.check(pg_temp.trade(1)::text !~* 'horse' AND pg_temp.trade(2)::text !~* 'horse' AND pg_temp.trade(10)::text !~* 'horse',
  'no Trade record row says horse, for the owner, a super agent or an agent');
SELECT pg_temp.check(pg_temp.trade(1) #>> '{9102,to_name}' = 'Quiet Rider' AND pg_temp.trade(1) #>> '{9101,to_name}' = 'Kingfish',
  'the recipient is printed by the arena name, a horse like a person');
SELECT pg_temp.check(pg_temp.trade(2) -> '9101' -> 'from_user_id' = 'null'::jsonb AND pg_temp.trade(2) -> '9101' -> 'from_name' = 'null'::jsonb
                 AND pg_temp.trade(10) -> '9101' -> 'from_user_id' = 'null'::jsonb AND pg_temp.trade(10) -> '9101' -> 'from_name' = 'null'::jsonb
                 AND pg_temp.trade(1) -> '9104' -> 'from_user_id' = 'null'::jsonb AND pg_temp.trade(1) -> '9104' -> 'from_name' = 'null'::jsonb
                 AND pg_temp.bank_rows(2) -> '9101' -> 'from_user_id' = 'null'::jsonb AND pg_temp.bank_rows(1) -> '9104' -> 'from_name' = 'null'::jsonb,
  'the Club Bank is the sender of every Club Bank send, never the operator who pressed Send');
-- Lead decision 2: the operator's own view and the paid member's view are
-- unchanged, so the operator's Trade record still counts the send as Out.
SELECT pg_temp.check(pg_temp.trade(1) #>> '{9101,from_user_id}' = public.u(1)::text AND pg_temp.trade(1) #>> '{9101,from_name}' = 'TheHouse'
                 AND pg_temp.trade(21) #>> '{9101,from_user_id}' = public.u(1)::text AND pg_temp.trade(21) #>> '{9101,from_name}' = 'TheHouse'
                 AND pg_temp.trade(2) #>> '{9104,from_user_id}' = public.u(2)::text AND pg_temp.trade(10) #>> '{9104,from_name}' = 'BigBoss'
                 AND pg_temp.bank_rows(1) #>> '{9101,from_user_id}' = public.u(1)::text AND pg_temp.bank_rows(2) #>> '{9104,from_name}' = 'BigBoss',
  'a Club Bank send still names its operator to the operator and to the member paid');
SELECT pg_temp.check((SELECT bool_and(pg_temp.trade(v) -> r -> 'from_user_id' = 'null'::jsonb AND pg_temp.trade(v) -> r -> 'from_name' = 'null'::jsonb)
                        FROM unnest(ARRAY[1, 2, 10]) v, unnest(ARRAY['9102', '9103']) r)
                 AND (SELECT bool_and(pg_temp.bank_rows(v) -> r -> 'from_user_id' = 'null'::jsonb AND pg_temp.bank_rows(v) -> r -> 'from_name' = 'null'::jsonb)
                        FROM unnest(ARRAY[1, 2]) v, unnest(ARRAY['9102', '9103']) r),
  'a funded seat names no sender to anyone');
SELECT pg_temp.check(pg_temp.trade(1) #>> '{9104,notes}' = 'float for the weekend',
  'a reason the sender typed is kept');
SELECT pg_temp.check(pg_temp.shape(pg_temp.trade(10) -> '9102') = pg_temp.shape(pg_temp.trade(10) -> '9101'),
  'an agent reads a funded seat in the downline exactly as a person''s send');
SELECT pg_temp.check(pg_temp.trade(1) -> '9104' -> 'metadata' = '{"destination": "agent_wallet"}'::jsonb
                 AND pg_temp.trade(1) -> '9102' -> 'metadata' = '{"destination": "player_wallet"}'::jsonb,
  'a Club Bank send carries only where its chips went');

SELECT pg_temp.check(NOT (pg_temp.bank(1) -> 'types' ? 'horse_treasury_funding') AND pg_temp.bank(1) -> 'types' ? 'club_bank_send',
  'the Club Bank ledger offers no horse kind to filter by');
SELECT pg_temp.check((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.bank_rows(1, ARRAY['club_bank_send'])) k) = ARRAY['9101', '9102', '9103', '9104']
                 AND (pg_temp.bank(1, ARRAY['club_bank_send']) ->> 'total')::int = 4,
  'filtering Club Bank sends lists the funded seats with the rest, and the count agrees');
SELECT pg_temp.check(pg_temp.shape(pg_temp.bank_rows(2) -> '9102') = pg_temp.shape(pg_temp.bank_rows(2) -> '9101')
                 AND pg_temp.shape(pg_temp.bank_rows(2) -> '9103') = pg_temp.shape(pg_temp.bank_rows(2) -> '9101'),
  'a funded seat and a person''s Club Bank send carry the same fields in the Club Bank ledger');
SELECT pg_temp.check(pg_temp.bank(1)::text !~* 'horse' AND pg_temp.bank(2)::text !~* 'horse',
  'no Club Bank ledger answer says horse');
SELECT pg_temp.check(pg_temp.bank(1) -> 'totals' = '{"into_bank": 30.00, "out_of_bank": 140.00, "net": -110.00}'::jsonb
                 AND (pg_temp.bank(1) ->> 'total')::int = 7,
  'the bank''s figures and its row count are what they were');

SELECT pg_temp.check(pg_temp.treasury(1, true)::text !~* 'horse' AND pg_temp.treasury(1, false)::text !~* 'horse',
  'the treasury statement names no horse, on either door');
SELECT pg_temp.check(pg_temp.legs(1, true) #>> '{8101,category}' = 'table_funding' AND pg_temp.legs(1, true) -> '8101' -> 'description' = 'null'::jsonb
                 AND pg_temp.legs(1, false) #>> '{8102,category}' = 'table_funding' AND pg_temp.legs(1, false) -> '8102' -> 'description' = 'null'::jsonb,
  'the funded seat''s leg reads as table funding with no description');
SELECT pg_temp.check(pg_temp.legs(1, true) #>> '{8103,description}' = 'Weekly commission through recorded earning hierarchy'
                 AND pg_temp.legs(1, true) #>> '{8104,category}' = 'mint' AND pg_temp.legs(1, false) #>> '{8103,category}' = 'commission',
  'every other treasury leg is untouched');

SELECT CASE WHEN count(*) FILTER (WHERE NOT ok) = 0 THEN 'SCENARIO PASSED ' || count(*)
            ELSE 'SCENARIO FAILED ' || count(*) FILTER (WHERE NOT ok) || ' OF ' || count(*) END
  FROM scenario_result;
