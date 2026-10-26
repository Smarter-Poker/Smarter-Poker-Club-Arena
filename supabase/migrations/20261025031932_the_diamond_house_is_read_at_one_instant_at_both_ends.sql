-- ===========================================================================
--  THE DIAMOND HOUSE IS READ AT ONE INSTANT AT BOTH ENDS
-- ===========================================================================
--
-- Two DR11:trial_balance_break incidents on the diamond_house row, neither of
-- them money:
--
--   920238  2026-10-24 23:20:00 UTC  critical  difference -16400
--           window from snapshot 1321 (23:10:00.29). balance_delta 1678,
--           house ledger 0, mint_net 18078.
--   912029  2026-10-20 01:20:00 UTC  warning   difference +655
--           window from snapshot 1203 (01:10:00.62). balance_delta 1584,
--           house ledger 0, mint_net 929.
--
-- Both auto-resolved the next hour, because nothing was missing.
--
-- WHY. fn_ca_diamond_trial_balance reads ca_diamond_house.balance inside its
-- "ONE statement, ONE snapshot" SELECT ... INTO with the register, but then
-- sums the house ledger (ca_diamond_house_ledger.delta, at >= w0 AND at <
-- now()) and the house Mint rows (ca_mint_ledger, holder_type 'house',
-- created_at >= w0 AND created_at < now()) in two LATER statements, each with
-- a fresh read-committed snapshot. And a Mint row's created_at is the writing
-- transaction's START time (now()), not its commit time. So the balance and
-- the windowed sums are read at different instants and bucket a row by a
-- different clock, at BOTH ends of the window:
--
--   * the END (920238). The :20 watch started 23:20:00.677 and its first
--     statement ran 78 s. poker-guarantee-overlay-return:c4d5bb13...:finalize
--     (mint 16400, created_at 23:20:00.073) committed while that statement
--     ran: the balance (2925317 = 2923639 + the 23:14 rake sweep of 1678) did
--     not see it, the later windowed SUM did. 1678 - 0 - 18078 = -16400.
--   * the START (912029). poker-tournament-fee:2c9b3e8f... (mint 655,
--     created_at 01:09:55.98) committed after the 01:10:00.62 snapshot read
--     house_balance 2391065. The window starts at the snapshot's taken_at, so
--     the row's created_at put it BEFORE the window while its balance landed
--     AFTER the snapshot: +655. Snapshot 1203 is the only one of the 715
--     snapshots of the 30 days to 2026-10-25 whose house_balance differs from
--     the house register netted by created_at < taken_at (2391065 against
--     2391720).
--
-- The player branch does not break because it already compares stored figures
-- (register_supply, register_fixture) read in the snapshot's own statement
-- with figures read in the trial balance's own statement.
--
-- WHAT CHANGES. The house row now does the same:
--   1. ca_diamond_snapshots gains two nullable columns, house_register (the
--      house holders' Diamond Mint net) and house_ledger_total (the
--      cumulative house ledger), stored by fn_ca_diamond_snapshot from the
--      SAME statement that reads house_balance.
--   2. fn_ca_diamond_trial_balance reads the same two figures in its existing
--      single statement (the house Mint net was already there as
--      v_reg_house; the house ledger total is added), and the house row's
--      mint_net and journal_net are end minus start of those figures. Each
--      end of the window is now one instant.
--   3. A window snapshot taken before this migration stores neither column,
--      so for it the trial balance keeps the old windowed SUMs, unchanged, and
--      the note says so. The first snapshot after install (:10) stores both,
--      and every :20 watch from then on reads stored figures.
--
--   Every other row is computed exactly as before. The watch, its DR11
--   threshold and its auto-resolve are untouched: an account that reads 0 is
--   still resolved by fn_ca_diamond_trial_balance_watch. Nothing is
--   scheduled, retried, backfilled, silenced or deleted. No index, no grant,
--   owner or setting moves. No incident row is written or edited.
--
-- HOW. Exact substitution through a pg_temp helper (as in 20261004231413):
-- pinned preimages, each anchor exactly once, pinned postimages, owner,
-- security, settings and grants unmoved. fn_ca_diamond_snapshot is on
-- fn_ca_guard_watchlist() and is declared. ca_diamond_snapshots is written
-- once an hour at :10 and read by the Diamond books; adding two nullable
-- columns with no default rewrites nothing.
-- ===========================================================================
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure)) = 'aa1954aa21ebf672e454fba810d89e8d' AND md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure)) = '563dd56e2ad4d1275f12b4c1654412d3')
-- @live-proof: (SELECT count(*) = 2 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ca_diamond_snapshots' AND column_name IN ('house_register', 'house_ledger_total') AND is_nullable = 'YES')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. THE TWO STORED FIGURES
-- ---------------------------------------------------------------------------
ALTER TABLE public.ca_diamond_snapshots
  ADD COLUMN IF NOT EXISTS house_register numeric,
  ADD COLUMN IF NOT EXISTS house_ledger_total numeric;

COMMENT ON COLUMN public.ca_diamond_snapshots.house_register IS
  'Net Diamond Mint register of house holders (mint minus burn), read in the same statement as house_balance. fn_ca_diamond_trial_balance measures the house Mint movement as its own reading minus this figure. NULL on snapshots taken before 2026-10-25.';
COMMENT ON COLUMN public.ca_diamond_snapshots.house_ledger_total IS
  'Cumulative sum of ca_diamond_house_ledger.delta, read in the same statement as house_balance. fn_ca_diamond_trial_balance measures the house ledger movement as its own reading minus this figure. NULL on snapshots taken before 2026-10-25.';

-- ---------------------------------------------------------------------------
-- 1. THE SUBSTITUTION HELPER (temporary; ends with this session)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

-- ---------------------------------------------------------------------------
-- 2. THE SNAPSHOT STORES THE HOUSE REGISTER AND LEDGER WITH THE HOUSE BALANCE
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_snapshot()',
  '2419d7a9c757d9a0135b8fec75edd2c8', 'aa1954aa21ebf672e454fba810d89e8d',
  ARRAY[$o$  v_mirror_bad bigint := 0;
$o$, $o$
    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix;
$o$, $o$     register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds)
$o$, $o$     v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix);
$o$],
  ARRAY[$n$  v_mirror_bad bigint := 0;
  v_house_reg numeric; v_house_ledger_total numeric;
$n$, $n$,
         -- THE HOUSE IS READ AT ONE INSTANT (2026-10-25): the house holders' Mint
         -- net and the cumulative house ledger are stored beside house_balance,
         -- from this same statement, so the trial balance measures the house
         -- movement and what explains it at one instant at each end instead of
         -- windowing rows by created_at, which is a transaction's START time.
         (SELECT COALESCE(SUM(CASE WHEN h.action = 'mint' THEN h.amount ELSE -h.amount END), 0)
            FROM public.ca_mint_ledger h WHERE h.asset = 'diamonds' AND h.holder_type = 'house'),
         (SELECT COALESCE(SUM(hl.delta), 0) FROM public.ca_diamond_house_ledger hl)
    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix,
         v_house_reg, v_house_ledger_total;
$n$, $n$     register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds,
     house_register, house_ledger_total)
$n$, $n$     v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix,
     v_house_reg, v_house_ledger_total);
$n$]);

DO $declare$
BEGIN
  IF 'fn_ca_diamond_snapshot' = ANY (public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_snapshot',
      'migration 20261025031932_the_diamond_house_is_read_at_one_instant_at_both_ends');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 3. THE TRIAL BALANCE MEASURES THE HOUSE ON STORED FIGURES
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_diamond_trial_balance(timestamp with time zone)',
  '70f9022bd9944863dd7390f03e869c8b', '563dd56e2ad4d1275f12b4c1654412d3',
  ARRAY[$o$  v_house_ledger numeric;
$o$, $o$
    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix;
$o$, $o$  -- diamond_house
  SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
    FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
$o$, $o$ and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.';
$o$],
  ARRAY[$n$  v_house_ledger numeric; v_house_ledger_total numeric;
$n$, $n$,
         -- The cumulative house ledger, read with the house balance (2026-10-25):
         -- see the diamond_house row below.
         (SELECT COALESCE(SUM(hl.delta), 0) FROM public.ca_diamond_house_ledger hl)
    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix,
         v_house_ledger_total;
$n$, $n$  -- diamond_house
  -- THE HOUSE IS READ AT ONE INSTANT AT BOTH ENDS (2026-10-25). The house balance
  -- is read in the single statement above; the Mint and the house ledger used to be
  -- summed over the window in two LATER statements, each a fresh read-committed
  -- snapshot, bucketed by created_at / at, which is the writing transaction's START
  -- time. A house mint that committed while the single statement ran was in the sum
  -- and not in the balance (2026-10-24 23:20 UTC, -16400: an overlay return started
  -- 23:20:00.073 and committed during the 78 s statement), and one that started
  -- before the window snapshot and committed after it was in the balance and not in
  -- the sum (2026-10-20 01:20 UTC, +655). Like the player row, the house row now
  -- compares figures the snapshot stored from the statement that read house_balance
  -- with figures read in the single statement above. A window snapshot taken before
  -- house_register existed keeps the windowed sums, and the note says so.
  IF s0.id IS NOT NULL AND s0.house_register IS NOT NULL THEN
    v_mint := v_reg_house - s0.house_register;
  ELSE
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
  END IF;
  IF s0.id IS NOT NULL AND s0.house_ledger_total IS NOT NULL THEN
    v_house_ledger := v_house_ledger_total - s0.house_ledger_total;
  ELSE
    SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  END IF;
$n$, $n$ and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.'
      || CASE WHEN s0.house_register IS NOT NULL AND s0.house_ledger_total IS NOT NULL
              THEN ' Both ends are stored figures, each read in one statement with its house balance (no window skew).'
              ELSE ' The window snapshot predates house_register, so the Mint and the house ledger are windowed by created_at (boundary skew possible).' END;
$n$]);

DO $declare$
BEGIN
  IF 'fn_ca_diamond_trial_balance' = ANY (public.fn_ca_guard_watchlist()) THEN
    PERFORM public.fn_ca_declare_guard_redefinition('fn_ca_diamond_trial_balance',
      'migration 20261025031932_the_diamond_house_is_read_at_one_instant_at_both_ends');
  END IF;
END $declare$;

-- ---------------------------------------------------------------------------
-- 4. WHAT MUST NOW BE TRUE
-- ---------------------------------------------------------------------------
DO $after$
DECLARE v_snap text; v_tb text;
BEGIN
  v_snap := pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure);
  v_tb   := pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure);
  IF position('house_register, house_ledger_total)' IN v_snap) = 0 THEN
    RAISE EXCEPTION 'the snapshot does not store the house register and ledger';
  END IF;
  IF position('v_mint := v_reg_house - s0.house_register;' IN v_tb) = 0
     OR position('v_house_ledger := v_house_ledger_total - s0.house_ledger_total;' IN v_tb) = 0 THEN
    RAISE EXCEPTION 'the trial balance does not measure the house on stored figures';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_diamond_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_snapshot()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_ca_diamond_trial_balance(timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_ca_diamond_trial_balance(timestamp with time zone)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute a Diamond book';
  END IF;
END $after$;

-- pg_temp.ca_audit_subst is a temporary object and ends with this session.

COMMIT;
