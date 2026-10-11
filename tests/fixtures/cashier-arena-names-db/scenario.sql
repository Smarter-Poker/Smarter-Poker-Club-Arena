-- How the two cashier lists name a member (migration 20261010005048).
-- Run by scripts/ci/test-cashier-arena-names-db-postgres.py once on
-- production's live fn_club_trade_ledger and fn_agent_wallet_reversible
-- (where exactly the seven assertions the harness names must FAIL) and once
-- after the migration (where all eleven must PASS).
--
-- Club u(100): u(1) owns it; u(10) is an agent whose downline is u(20)..u(24);
-- u(30) is a member outside that downline. The people:
--   u(20) alias Kingfish, display name = real name Dan Bekavac
--   u(21) no alias, username jsmith, display name = real name John Smith
--   u(22) no profile row at all
--   u(23) a profile with no name in it
--   u(24) alias RiverRat, a World Hub display name River Hub Name
-- Rows 9001..9005 are the agent's sends still inside their claim-back window,
-- 9008 is a send whose window closed, 9006 a Club Bank send to u(21) and 9007
-- a claim from u(30) back to the Club Bank.
RESET ROLE;
CREATE TEMP TABLE scenario_result(name text, ok boolean);
GRANT ALL ON scenario_result TO PUBLIC;

CREATE FUNCTION pg_temp.check(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO scenario_result VALUES (name, coalesce(ok, false));
  IF coalesce(ok, false) THEN RAISE NOTICE 'PASS: %', name; ELSE RAISE NOTICE 'FAIL: %', name; END IF;
END $$;

-- What each viewer's Trade record says, keyed by the row's last four digits:
-- {"9001": [from_name, to_name], ...}
CREATE FUNCTION pg_temp.ledger(viewer int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(jsonb_object_agg(right(l.id::text, 4), jsonb_build_array(l.from_name, l.to_name)), '{}'::jsonb)
    INTO r FROM public.fn_club_trade_ledger(public.u(100), 251, 0) l;
  RESET ROLE;
  RETURN r;
END $$;

-- What the agent's claim-back list says: {"9001": {"name": ..., "amount": ..., ...}}
CREATE FUNCTION pg_temp.reversible(viewer int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  SELECT coalesce(jsonb_object_agg(right(v.transaction_id::text, 4),
           jsonb_build_object('name', v.to_name, 'amount', v.amount, 'remaining', v.remaining,
                              'live', v.seconds_left BETWEEN 1 AND 600)), '{}'::jsonb)
    INTO r FROM public.fn_agent_wallet_reversible(public.u(100)) v;
  RESET ROLE;
  RETURN r;
END $$;

SELECT pg_temp.check(pg_temp.reversible(10) #>> '{9001,name}' = 'Kingfish'
                 AND pg_temp.reversible(10) #>> '{9005,name}' = 'RiverRat',
  'the claim-back list names a recipient by the poker alias, never the World Hub name first');
SELECT pg_temp.check(pg_temp.reversible(10) #>> '{9002,name}' = 'jsmith',
  'a recipient with no alias is named by the username, not the real name');
SELECT pg_temp.check(pg_temp.reversible(10) #>> '{9003,name}' = 'Member',
  'a recipient with no profile is still a Member');
SELECT pg_temp.check(pg_temp.reversible(10) #>> '{9004,name}' = 'Player',
  'a profile with no name in it reads Player, the arena fallback');
SELECT pg_temp.check(
  (SELECT jsonb_object_agg(k, v - 'name') FROM jsonb_each(pg_temp.reversible(10)) AS e(k, v))
    = '{"9001": {"amount": 100, "remaining": 100, "live": true},
        "9002": {"amount": 50, "remaining": 50, "live": true},
        "9003": {"amount": 25, "remaining": 25, "live": true},
        "9004": {"amount": 10, "remaining": 6, "live": true},
        "9005": {"amount": 5, "remaining": 5, "live": true}}'::jsonb
  AND pg_temp.reversible(1) = '{}'::jsonb,
  'the claim-back list keeps exactly its rows, amounts and countdowns, and only for the sender');
SELECT pg_temp.check(pg_temp.ledger(1) =
  '{"9001": ["SharkTank", "Kingfish"], "9002": ["SharkTank", "jsmith"], "9003": ["SharkTank", null],
    "9004": ["SharkTank", "Player"], "9005": ["SharkTank", "RiverRat"], "9006": [null, "jsmith"],
    "9007": ["Outsider", null], "9008": ["SharkTank", "Kingfish"]}'::jsonb,
  'the owner''s Trade record names every side by the arena name');
SELECT pg_temp.check(pg_temp.ledger(1) -> '9006' -> 0 = 'null'::jsonb
                 AND pg_temp.ledger(1) -> '9007' -> 1 = 'null'::jsonb
                 AND pg_temp.ledger(1) -> '9003' -> 1 = 'null'::jsonb,
  'a Club Bank side, and a side with no profile, stay unnamed for the screen to word');
SELECT pg_temp.check(pg_temp.ledger(10) =
  '{"9001": ["SharkTank", "Kingfish"], "9002": ["SharkTank", "jsmith"], "9003": ["SharkTank", null],
    "9004": ["SharkTank", "Player"], "9005": ["SharkTank", "RiverRat"], "9006": [null, "jsmith"],
    "9008": ["SharkTank", "Kingfish"]}'::jsonb,
  'the agent''s Trade record is its downline, named by the arena name');
SELECT pg_temp.check(pg_temp.ledger(21) = '{"9002": ["SharkTank", "jsmith"], "9006": [null, "jsmith"]}'::jsonb,
  'a member''s Trade record is only their own rows, named by the arena name');
SELECT pg_temp.check(pg_temp.ledger(30) = '{"9007": ["Outsider", null]}'::jsonb,
  'a member outside the downline sees only their own row');
SELECT pg_temp.check(NOT EXISTS (
    SELECT 1
      FROM (SELECT pg_temp.ledger(1) AS j UNION ALL SELECT pg_temp.ledger(10) UNION ALL
            SELECT pg_temp.ledger(21) UNION ALL SELECT pg_temp.ledger(30) UNION ALL
            SELECT pg_temp.reversible(10)) views,
           LATERAL jsonb_path_query(views.j, 'strict $.**') AS leaf(v)
     WHERE jsonb_typeof(leaf.v) = 'string'
       AND leaf.v #>> '{}' IN ('Dan Bekavac', 'John Smith', 'Olivia Owner', 'Arthur Agent', 'Olga Outsider', 'River Hub Name')),
  'no cashier list prints a real name or a World Hub name');

RESET ROLE;
SELECT CASE WHEN count(*) FILTER (WHERE NOT ok) = 0 THEN 'SCENARIO PASSED ' || count(*)
            ELSE 'SCENARIO FAILED ' || count(*) FILTER (WHERE NOT ok) || ' OF ' || count(*) END
  FROM scenario_result;
