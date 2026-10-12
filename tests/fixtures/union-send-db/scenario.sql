-- A union admin sends the same amount to two members inside 20 seconds
-- (migration 20261010004314). Run by scripts/ci/test-union-send-db-postgres.py
-- in autocommit, one send per transaction as in production, on production's
-- live fn_union_send_to_member and its core (where it must FAIL) and after the
-- migration (where every assertion must PASS).
--
-- Union u(950) holds 1,000 chips and 1,000 promo; u(1) manages it; u(20) and
-- u(21) are players of its club u(100).
CREATE FUNCTION pg_temp.send(target int, kind text, amount numeric) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM public.as_user(1);
  SET LOCAL ROLE authenticated;
  r := public.fn_union_send_to_member(public.u(950), public.u(target), kind, amount, 'chips', NULL, NULL);
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.balance(member int) RETURNS numeric LANGUAGE sql AS $$
  SELECT chip_balance FROM public.club_members WHERE club_id = public.u(100) AND user_id = public.u(member)
$$;

SELECT assert_true(pg_temp.send(20, 'chips', 100) @> '{"success":true,"kind":"chips"}' AND pg_temp.balance(20) = 100,
  'the first send pays the first member');
SELECT assert_true(NOT (pg_temp.send(21, 'chips', 100) ? 'duplicate_suppressed') AND pg_temp.balance(21) = 100,
  'a send of the same amount to another member seconds later is paid, not suppressed');
SELECT assert_true(pg_temp.send(20, 'chips', 100) @> '{"success":true,"duplicate_suppressed":true}' AND pg_temp.balance(20) = 100,
  'the same send to the same member seconds later is still a retry: nothing moves twice');
SELECT assert_true(NOT (pg_temp.send(20, 'promo', 100) ? 'duplicate_suppressed') AND pg_temp.balance(20) = 200,
  'a promo send of the same amount to the same member is the other kind, and is paid');
SELECT assert_true((SELECT chip_balance FROM public.union_wallets WHERE union_id = public.u(950)) = 800
               AND (SELECT promo_wallet FROM public.union_wallets WHERE union_id = public.u(950)) = 900,
  'the union paid exactly the three sends it made');
