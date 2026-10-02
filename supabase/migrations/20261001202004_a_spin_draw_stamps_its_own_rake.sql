-- A Spin draw stamps its own rake.
--
-- Supersedes PR #5495 (held since 2026-09-27; its preimage guard names a
-- function body production no longer runs, so it could never apply).
--
-- public.fn_spin_draw_and_settle_atomic books the three entries, draws the
-- multiplier and settles the funded prize in one launch transaction, then
-- stamps the tournament row from what it just booked: spin_multiplier,
-- prize_pool, spin_locked_tiers, blind_structure, payout_structure. It never
-- stamps total_rake, although the same transaction's v_settle
-- (fn_spin_settle_game) carries the exact rake as house_rake and
-- fn_spin_book_entry has already written that rake to rake_records and
-- tournament_escrow.fee_balance.
--
-- Read live 2026-10-01: every one of the 1,886 Spins completed in the six
-- hours before 20:00 UTC has total_rake 0.00 while its escrow fee_out holds
-- the real rake (12.00 on a 50 buy-in, 8% of three entries). Sit & Gos carry
-- it correctly (0 mismatches). The cache is not decorative:
-- atomic_cancel_tournament refuses any tournament whose total_rake differs
-- from tournament_escrow.fee_balance or from its rake_records, so a drawn Spin
-- that has to be cancelled is refused by the platform's own authority.
--
-- The UPDATE now stamps total_rake from v_settle's house_rake, and the
-- function's exact read-back verifies it with its four siblings. Only the
-- 'at_draw' branch runs that UPDATE; the legacy_projection branch is
-- unchanged. No row is back-filled: completed Spins are immutable by
-- receipted_tournament_is_immutable, and the thirteen 2026-09-08 rows are
-- owned by the archived-Spin recovery path, which binds their state as found.
--
-- Preimage-guarded on the exact live body, owner, ACL, settings, security
-- and volatility read 2026-10-01; the replacement is applied to
-- pg_get_functiondef text, so every one of those is carried over unchanged
-- and asserted afterwards.
-- @live-proof: (SELECT md5(prosrc)='ca8efa14ebf6652efb417bb7cc549986' AND md5(pg_get_functiondef(oid))='eefd093eef7326765d0176809666a14a' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure)
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $mig$
DECLARE
  s regprocedure := 'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure;
  d text;
  x text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = s
       AND md5(p.prosrc) = '82ad42a0f71a0cdca23ccdcf65fafe7d'
       AND md5(pg_get_functiondef(p.oid)) = 'bbbb1f3d3c221060860384b557bd0472'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public, extensions, pg_temp', 'statement_timeout=30s']
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'SPIN_DRAW_RAKE_PREIMAGE: fn_spin_draw_and_settle_atomic is not the body read 2026-10-01';
  END IF;

  d := pg_get_functiondef(s);
  x := replace(d,
    E'    UPDATE public.tournaments\n       SET spin_multiplier   = v_multiplier,\n           prize_pool        = v_prize,\n           spin_locked_tiers = v_locked,',
    E'    UPDATE public.tournaments\n       SET spin_multiplier   = v_multiplier,\n           prize_pool        = v_prize,\n           total_rake        = round((v_settle->>''house_rake'')::numeric, 2),\n           spin_locked_tiers = v_locked,');
  x := replace(x,
    E'            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked) THEN',
    E'            AND t.spin_locked_tiers IS NOT DISTINCT FROM v_locked\n            AND t.total_rake IS NOT DISTINCT FROM round((v_settle->>''house_rake'')::numeric, 2)) THEN');
  IF md5(x) <> 'eefd093eef7326765d0176809666a14a' THEN
    RAISE EXCEPTION 'SPIN_DRAW_RAKE_TRANSFORM: expected eefd093eef7326765d0176809666a14a, got %', md5(x);
  END IF;
  EXECUTE x;
END
$mig$;

REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure
       AND md5(p.prosrc) = 'ca8efa14ebf6652efb417bb7cc549986'
       AND md5(pg_get_functiondef(p.oid)) = 'eefd093eef7326765d0176809666a14a'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig = ARRAY['search_path=public, extensions, pg_temp', 'statement_timeout=30s']
       AND p.prosecdef
       AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'SPIN_DRAW_RAKE_POSTIMAGE: fn_spin_draw_and_settle_atomic did not land as intended';
  END IF;
END
$post$;

COMMIT;
