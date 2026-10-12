-- SUPERSEDED BY 20261004194622 (the_chip_circulation_proof_reads_one_snapshot)
-- THIS FILE MUST NEVER RUN. It is correct in substance and cannot apply.
--
-- It was dispatched twice through apply-merged-migration.yml and refused
-- ITSELF both times, its own section 4 post-image assertion firing, and
-- rolled back cleanly. Verbatim:
--
--   attempt 1 (run 37210153821):
--     ERROR P0001: the chip member wallet total moved:
--                  174066724.55 -> 174066739.55
--   attempt 2 (run 37210433597):
--     ERROR P0001: the chip supply measurement moved:
--                  club 174066957.78 -> 174066957.78, cash 86094.98 -> 86094.98,
--                  tourney 8039400.00 -> 8039400.00, seats 1632 -> 1631
--
-- Attempt 2 is the diagnosis. Every money figure held identical to the cent;
-- the only thing that changed was seats 1632 -> 1631, one player standing up
-- during the 334 ms the transaction was open. Section 0 below captures
-- absolute figures into ca_p9b_before and section 4 re-reads them AFTER the
-- substitutions and requires equality - two statements, two instants, and at
-- the default READ COMMITTED two snapshots. So it asserts "applying the
-- Diamond exclusion changes no chip figure" AND "no unrelated player did
-- anything while I was open", and the second can essentially never hold on a
-- live floor with 1632 seats on the felt.
--
-- The successor carries every line of substance here unchanged - the same
-- three readers, md5 pins, clause-occurrence counts, reverse-substitution
-- checks, refusals and closing block - and replaces section 0's capture and
-- section 4's comparison with comparisons that read the filtered and the
-- unfiltered figure IN ONE STATEMENT, which is one snapshot even at READ
-- COMMITTED. No money comparison is loosened and none gains a tolerance; the
-- chip circulation report is now compared figure by figure instead of only by
-- row count. See the successor's header and
-- docs/changelog/2026-10-04-the-chip-circulation-proof-reads-one-snapshot.md.
--
-- History is never deleted, so this file stays exactly as it merged below.
-- ============================================================================
-- THE CHIP CIRCULATION MARKS COUNT NO DIAMOND
-- ============================================================================
--
-- Phase 9 of the Diamond Arena programme, the line "Remove every inherited
-- union/agent distribution and chip treasury dependency", and the
-- cross-format conservation line beside it. It continues step 0 of
-- docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 4, which taught the
-- hourly chip supply meter (fn_ca_supply_snapshot) to count no Diamond seat,
-- no Diamond pending add-on and no Diamond event. Step 0 fixed that one
-- meter. It did not fix the three other readers that measure the same two
-- pools, and one of them decides whether the platform freeze conserved.
--
-- WHAT IS WRONG, read from production on 2026-10-04 (every figure below is a
-- SELECT through the Supabase MCP inside BEGIN TRANSACTION ISOLATION LEVEL
-- REPEATABLE READ READ ONLY; nothing was written and nothing was rehearsed
-- against production):
--
--   1. fn_ca_circulation_total() (md5 f4a6ddceec4e02cffd220c0db26d1019) is
--      sum(club_members.chip_balance) + sum(table_seats.stack WHERE left_at
--      IS NULL), with NO asset filter on either pool. Its one caller is
--      fn_ca_capture_freeze_mark(text) (md5 fdc0550ae20fd6b10979858c7608a1ec),
--      which two active cron jobs run every hour - ca-freeze-mark-pre at :55
--      and ca-freeze-mark-post at :00 - and which writes member_wallets,
--      on_the_felt and total into ca_freeze_circulation_marks. The hourly
--      break scorecard then reads those marks:
--
--          SELECT total INTO v_pre  ... kind='pre';
--          SELECT total INTO v_post ... kind='post';
--          v_delta := v_post - v_pre;
--          v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre,0) * 1e-7));
--
--      (fn_ca_record_break_scorecard(timestamptz), md5
--      0d9eb4d63244cfc69879f87596439c99, read and NOT changed here.) So the
--      platform's own conservation verdict for the maintenance break is
--      computed from one number that adds a Diamond figure to a chip figure.
--      The moment cash_games_enabled opens, a Diamond player taking or
--      leaving a seat between :55 and :00 moves on_the_felt in Diamonds, the
--      delta is compared against a chip tolerance of max(1.0, chips * 1e-7),
--      and the break is recorded as not having conserved chips when no chip
--      moved at all. Diamond stacks would be summed with 174,126,305.73 chips
--      in member wallets and 5,842,340.25 chips on the felt (read 2026-10-04
--      12:52 UTC; both move with live chip play).
--
--   2. fn_snapshot_chip_supply() (md5 450da5111403dde7283f46499ad8ef8a)
--      measures the same two pools with no asset filter, writes them into
--      chip_supply_snapshots as club_wallets_total, table_stacks and
--      tournament_stacks, and computes holdings as wallets + club wallets +
--      cash table stacks, then delta_holdings and unexplained_delta against
--      the previous row. chip_supply_snapshots took 23 rows in the 24 hours
--      before this was written, so it runs; the latest row is table_stacks
--      89,586.84, tournament_stacks 5,340,900.00, unexplained_delta 10,383.99.
--      A Diamond seat's stack would enter table_stacks and then
--      unexplained_delta as unexplained CHIPS. No cron.job names this
--      function; its hourly caller is outside the database.
--
--   3. fn_club_chip_circulation(uuid) (md5 f71a1a5f26ffc70cc639777b232635cd)
--      lists every club's member wallets, felt and treasury as chips. It is
--      per club, so it mixes nothing between assets, but it would report a
--      diamonds club's Diamond seat stacks in a column headed chip
--      circulation, under a chip total. CLAUDE.md 11.5 cites this function as
--      the one that prints the two pools reconciliation had never looked at.
--
-- WHAT THIS CHANGES. All three readers exclude a pool that is KNOWN to be
-- Diamond, using the shape step 0 established: NOT EXISTS (... clubs c WHERE
-- c.id = ... AND c.asset = 'diamonds'). Only what is known Diamond is
-- excluded, so a seat whose table row is missing, or a membership whose club
-- row is missing, stays counted exactly as it is counted today. clubs.asset
-- is NOT NULL with a CHECK of ('chips','diamonds') and a default of 'chips',
-- so there is no third value and no NULL to fall through.
--
-- The Diamond is not dropped from the books by being dropped from the chip
-- books. A Diamond cash seat's stack decomposes the custody row that funded
-- it, and the Diamond Money Contract says a decomposition is counted once:
-- fn_ca_arena_diamonds() (md5 86863a1208455e92803777829bc9a668) counts
-- poker_diamond_custody, the trial balance reads that float through
-- fn_ca_diamond_offledger_float(), and the identity
-- fn_ca_diamond_register_vs_supply() closes on it. Counting the same Diamond
-- a second time in a chip figure is what this removes.
--
-- WHY NOW, AND WHY NOTHING MOVES. Measured on production 2026-10-04:
-- poker_diamond_custody holds 0 rows, 0 live seats sit in a diamonds club, 0
-- club_members row in a diamonds club carries a non-zero chip or promo
-- balance (CHECK poker_arena_diamond_identity already forbids the club
-- itself any chip treasury, chip pool, promo or insurance balance), both
-- ca_arena_settings switches are false, and there is exactly one diamonds
-- club (002c2d27-9584-4e52-835a-bb2be148fc81, Diamond Arena, is_platform).
-- So every figure these three readers return is bit-for-bit unchanged by this
-- migration, which is asserted below rather than asserted about: section 5
-- reads each pool both ways in this transaction and refuses the migration if
-- any of them differs. That is also why this belongs before the cash switch
-- and not after it: applied after the first Diamond seat, the change would
-- itself show up as a step in table_stacks and a one-off unexplained_delta.
--
-- NOT A WATCHER AND NOT A REPAIR (CLAUDE.md 10.11, 10.12). Nothing is swept,
-- backfilled or reconciled. The lines that produced the wrong figure are the
-- three aggregate expressions, and those lines are what change. No existing
-- row is rewritten: the chip snapshots and freeze marks already taken were
-- taken when no Diamond seat existed, so they are correct as they stand.
--
-- HOW EACH FUNCTION CHANGES. By asserted substitution, the way step 0 did it:
-- the live md5 is pinned, each old clause is counted and must occur the exact
-- number of times stated, and the reverse substitution must reproduce the
-- pinned text. A drifted function aborts the whole migration rather than
-- being rewritten from this file's idea of it.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-04:
--   fn_ca_circulation_total        f4a6ddceec4e02cffd220c0db26d1019
--   fn_snapshot_chip_supply        450da5111403dde7283f46499ad8ef8a
--   fn_club_chip_circulation       f71a1a5f26ffc70cc639777b232635cd
--   fn_ca_capture_freeze_mark      fdc0550ae20fd6b10979858c7608a1ec  (read, not changed)
--   fn_ca_record_break_scorecard   0d9eb4d63244cfc69879f87596439c99  (read, not changed; not
--                                  pinned at run time: it reads the marks rather than calling
--                                  anything this file changes, and pinning it would put half
--                                  the chip estate inside the isolated fixture that proves
--                                  this file. Its text above is the verdict this file was
--                                  written against.)
--   fn_ca_arena_diamonds           86863a1208455e92803777829bc9a668  (read, not changed)
--   fn_ca_supply_snapshot          6d816523832309ffda1e16ea0ce163a7  (read, not changed; step 0 left it here)
-- None of the three changed functions is on fn_ca_guard_watchlist(), so none
-- needs fn_ca_declare_guard_redefinition; the watchlist is still checked
-- whole at the end.
--
-- This migration creates no object of its own, so it states how to see it live:
-- @live-proof: position('DIAMOND PHASE 9: a Diamond seat holds Diamonds' in pg_get_functiondef('public.fn_ca_circulation_total()'::regprocedure)) > 0
-- @live-proof: position('DIAMOND PHASE 9: a Diamond seat holds Diamonds' in pg_get_functiondef('public.fn_snapshot_chip_supply()'::regprocedure)) > 0
-- @live-proof: position('DIAMOND PHASE 9: a diamonds club has no chip circulation' in pg_get_functiondef('public.fn_club_chip_circulation(uuid)'::regprocedure)) > 0
--
-- Proof: tests/sql/run-diamond-cross-format-conservation.py reproduces each
-- of the three defects on an isolated PostgreSQL 17 with the installed
-- function text, applies THIS FILE, and proves the same figures afterwards.
-- Law: tests/no-chip-reader-sums-a-diamond.law.test.ts, docs/laws.d/.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. NOTHING IS OPEN, AND WHAT THE FIGURES ARE BEFORE THIS TRANSACTION
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ca_p9b_before ON COMMIT DROP AS
SELECT
  (SELECT COALESCE(sum(chip_balance),0) FROM public.club_members)                             AS member_wallets,
  (SELECT COALESCE(sum(stack),0) FROM public.table_seats WHERE left_at IS NULL)               AS felt,
  (SELECT COALESCE(sum(COALESCE(chip_balance,0)),0) FROM public.club_members)                 AS snap_club,
  (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL),0)
     FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL)                                                                 AS snap_cash,
  (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL),0)
     FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL)                                                                 AS snap_tourney,
  (SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
    WHERE ts.left_at IS NULL)                                                                 AS snap_seats;

DO $m$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'a Diamond switch is already on somewhere; this migration expects both closed';
  END IF;
  -- A filter is not put over a pool that is already mixed: if a Diamond seat
  -- or a Diamond-club chip balance already exists, the figures these readers
  -- have been publishing are already wrong and that is a leak to report, not
  -- to quietly correct inside a definition change.
  IF EXISTS (SELECT 1 FROM public.table_seats ts
              JOIN public.tables t ON t.id = ts.table_id
              JOIN public.clubs c ON c.id = t.club_id
             WHERE ts.left_at IS NULL AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'a live Diamond seat already exists; the chip figures already published are wrong and this change would hide the step';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members cm JOIN public.clubs c ON c.id = cm.club_id
             WHERE c.asset = 'diamonds' AND COALESCE(cm.chip_balance,0) <> 0) THEN
    RAISE EXCEPTION 'a diamonds club membership already carries a chip balance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clubs WHERE asset = 'diamonds') THEN
    RAISE EXCEPTION 'no diamonds club exists; this migration expects the arena identity row';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 1. THE FREEZE MARK'S CIRCULATION TOTAL COUNTS NO DIAMOND
-- ---------------------------------------------------------------------------
-- Both pools appear twice in this one SELECT (once as a column, once inside
-- the total), so both occurrences of each are substituted and the count is
-- asserted at two.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old_w text; v_new_w text; v_old_f text; v_new_f text;
BEGIN
  v_oid := to_regprocedure('public.fn_ca_circulation_total()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'f4a6ddceec4e02cffd220c0db26d1019' THEN
    RAISE EXCEPTION 'fn_ca_circulation_total is not the pinned text (md5 %)', md5(v_def);
  END IF;

  v_old_w := '(SELECT sum(chip_balance) FROM public.club_members)';
  v_new_w := E'(SELECT sum(cm.chip_balance) FROM public.club_members cm\n'
          || E'               /* DIAMOND PHASE 9: a Diamond membership is not a chip wallet.\n'
          || E'                  Only a KNOWN diamonds club is excluded, so a membership whose\n'
          || E'                  club row is missing stays counted exactly as before. */\n'
          || E'               WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc\n'
          || E'                                  WHERE dc.id = cm.club_id AND dc.asset = ''diamonds''))';
  v_old_f := '(SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL)';
  v_new_f := E'(SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL\n'
          || E'               /* DIAMOND PHASE 9: a Diamond seat holds Diamonds. Counted in this\n'
          || E'                  total it is added to chips and the hourly freeze mark''s\n'
          || E'                  conservation verdict compares the sum against a chip tolerance.\n'
          || E'                  The Diamond is not lost: its custody row is inside\n'
          || E'                  fn_ca_arena_diamonds(), which the Diamond identity closes on. */\n'
          || E'               AND NOT EXISTS (SELECT 1 FROM public.tables dt\n'
          || E'                                JOIN public.clubs dc ON dc.id = dt.club_id\n'
          || E'                               WHERE dt.id = table_seats.table_id AND dc.asset = ''diamonds''))';

  v_n := (length(v_def) - length(replace(v_def, v_old_w, ''))) / length(v_old_w);
  IF v_n <> 2 THEN RAISE EXCEPTION 'circulation: the member wallet clause occurs % times, expected 2', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old_f, ''))) / length(v_old_f);
  IF v_n <> 2 THEN RAISE EXCEPTION 'circulation: the felt clause occurs % times, expected 2', v_n; END IF;

  EXECUTE replace(replace(v_def, v_old_w, v_new_w), v_old_f, v_new_f);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new_f, v_old_f), v_new_w, v_old_w))
     <> 'f4a6ddceec4e02cffd220c0db26d1019' THEN
    RAISE EXCEPTION 'circulation: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 2. THE CHIP SUPPLY SNAPSHOT COUNTS NO DIAMOND
-- ---------------------------------------------------------------------------
-- The seat measurement already inner-joins tables, so an orphan seat is
-- already outside it and the added clause changes nothing for one. The
-- member wallet measurement has no join and uses NOT EXISTS for that reason.
DO $m$
DECLARE
  v_oid oid; v_def text; v_n integer;
  v_old_w text; v_new_w text; v_old_s text; v_new_s text;
BEGIN
  v_oid := to_regprocedure('public.fn_snapshot_chip_supply()');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '450da5111403dde7283f46499ad8ef8a' THEN
    RAISE EXCEPTION 'fn_snapshot_chip_supply is not the pinned text (md5 %)', md5(v_def);
  END IF;

  v_old_w := '  SELECT COALESCE(sum(COALESCE(chip_balance,0)), 0) INTO v_club FROM public.club_members;';
  v_new_w := E'  /* DIAMOND PHASE 9: a Diamond membership is not a chip wallet. */\n'
          || E'  SELECT COALESCE(sum(COALESCE(cm.chip_balance,0)), 0) INTO v_club FROM public.club_members cm\n'
          || E'   WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc\n'
          || E'                      WHERE dc.id = cm.club_id AND dc.asset = ''diamonds'');';
  v_old_s := '    INTO v_cash, v_tourney, v_sc FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id WHERE ts.left_at IS NULL;';
  v_new_s := E'    INTO v_cash, v_tourney, v_sc FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id WHERE ts.left_at IS NULL\n'
          || E'     /* DIAMOND PHASE 9: a Diamond seat holds Diamonds that no wallet_transactions\n'
          || E'        row moves, so counted here it reads as unexplained chip supply. Its custody\n'
          || E'        row is counted by fn_ca_arena_diamonds() instead. */\n'
          || E'     AND NOT EXISTS (SELECT 1 FROM public.clubs dc\n'
          || E'                      WHERE dc.id = t.club_id AND dc.asset = ''diamonds'');';

  v_n := (length(v_def) - length(replace(v_def, v_old_w, ''))) / length(v_old_w);
  IF v_n <> 1 THEN RAISE EXCEPTION 'snapshot: the member wallet line occurs % times, expected 1', v_n; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old_s, ''))) / length(v_old_s);
  IF v_n <> 1 THEN RAISE EXCEPTION 'snapshot: the seat measurement line occurs % times, expected 1', v_n; END IF;

  EXECUTE replace(replace(v_def, v_old_w, v_new_w), v_old_s, v_new_s);
  IF md5(replace(replace(pg_get_functiondef(v_oid), v_new_s, v_old_s), v_new_w, v_old_w))
     <> '450da5111403dde7283f46499ad8ef8a' THEN
    RAISE EXCEPTION 'snapshot: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. A DIAMONDS CLUB IS NOT A ROW IN THE CHIP CIRCULATION REPORT
-- ---------------------------------------------------------------------------
-- Its member wallets, treasury and chip pool are all held at zero by CHECK
-- poker_arena_diamond_identity and the membership guard, so the only figure
-- it could ever contribute is a Diamond seat stack under a chip heading. The
-- club keeps its own report: the Diamond statement and fn_ca_arena_diamonds().
DO $m$
DECLARE v_oid oid; v_def text; v_n integer; v_old text; v_new text;
BEGIN
  v_oid := to_regprocedure('public.fn_club_chip_circulation(uuid)');
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'f71a1a5f26ffc70cc639777b232635cd' THEN
    RAISE EXCEPTION 'fn_club_chip_circulation is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := '  WHERE p_club_id IS NULL OR c.id = p_club_id';
  v_new := E'  WHERE (p_club_id IS NULL OR c.id = p_club_id)\n'
        || E'    /* DIAMOND PHASE 9: a diamonds club has no chip circulation. Its felt\n'
        || E'       holds Diamonds, and clubs.asset is NOT NULL and CHECKed to\n'
        || E'       (''chips'',''diamonds''), so this excludes exactly the arena. */\n'
        || E'    AND c.asset <> ''diamonds''';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'club circulation: the filter line occurs % times, expected 1', v_n; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'f71a1a5f26ffc70cc639777b232635cd' THEN
    RAISE EXCEPTION 'club circulation: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 4. NOTHING THE CHIP BOOKS PUBLISH TODAY MOVES BY ONE CHIP
-- ---------------------------------------------------------------------------
-- The three readers are measured again, after the substitutions, against the
-- values taken at the top of this transaction. Equality is the whole claim of
-- this migration: it removes a Diamond that is not there yet, and changes no
-- chip figure. fn_snapshot_chip_supply is NOT called - calling it would write
-- a snapshot row - so its two measurements are read directly instead.
DO $m$
DECLARE b record; v_w numeric; v_f numeric; v_club numeric;
        v_cash numeric; v_tourney numeric; v_seats integer;
BEGIN
  SELECT * INTO b FROM ca_p9b_before;
  SELECT member_wallets, on_the_felt INTO v_w, v_f FROM public.fn_ca_circulation_total();
  IF v_w IS DISTINCT FROM b.member_wallets THEN
    RAISE EXCEPTION 'the chip member wallet total moved: % -> %', b.member_wallets, v_w;
  END IF;
  IF v_f IS DISTINCT FROM b.felt THEN
    RAISE EXCEPTION 'the chip felt total moved: % -> %', b.felt, v_f;
  END IF;

  SELECT COALESCE(sum(COALESCE(cm.chip_balance,0)),0) INTO v_club FROM public.club_members cm
   WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = cm.club_id AND dc.asset = 'diamonds');
  SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL),0),
         COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL),0), count(*)
    INTO v_cash, v_tourney, v_seats
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds');
  IF v_club IS DISTINCT FROM b.snap_club OR v_cash IS DISTINCT FROM b.snap_cash
     OR v_tourney IS DISTINCT FROM b.snap_tourney OR v_seats IS DISTINCT FROM b.snap_seats THEN
    RAISE EXCEPTION 'the chip supply measurement moved: club % -> %, cash % -> %, tourney % -> %, seats % -> %',
      b.snap_club, v_club, b.snap_cash, v_cash, b.snap_tourney, v_tourney, b.snap_seats, v_seats;
  END IF;

  -- And every chip club still has its row in the chip circulation report.
  IF (SELECT count(*) FROM public.fn_club_chip_circulation())
     IS DISTINCT FROM (SELECT count(*) FROM public.clubs WHERE asset <> 'diamonds') THEN
    RAISE EXCEPTION 'the chip circulation report lost or gained a chip club';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_club_chip_circulation() r
              JOIN public.clubs c ON c.id = r.club_id WHERE c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'the chip circulation report still lists a diamonds club';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 5. EVERY EDIT LANDED, AND NOTHING ELSE DID
-- ---------------------------------------------------------------------------
DO $m$
DECLARE r record; v_txt text; v_bad text;
BEGIN
  v_txt := pg_get_functiondef('public.fn_ca_circulation_total()'::regprocedure);
  IF position('DIAMOND PHASE 9: a Diamond seat holds Diamonds' IN v_txt) = 0
     OR position('DIAMOND PHASE 9: a Diamond membership is not a chip wallet' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the freeze mark total does not carry both Diamond exclusions';
  END IF;
  v_txt := pg_get_functiondef('public.fn_snapshot_chip_supply()'::regprocedure);
  IF position('DIAMOND PHASE 9: a Diamond seat holds Diamonds' IN v_txt) = 0
     OR position('DIAMOND PHASE 9: a Diamond membership is not a chip wallet' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip supply snapshot does not carry both Diamond exclusions';
  END IF;
  v_txt := pg_get_functiondef('public.fn_club_chip_circulation(uuid)'::regprocedure);
  IF position('DIAMOND PHASE 9: a diamonds club has no chip circulation' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the chip circulation report does not exclude a diamonds club';
  END IF;

  -- The caller of what changed is untouched, and is the reason this matters.
  -- If it has drifted, say so rather than claim this fixed it.
  IF md5(pg_get_functiondef('public.fn_ca_capture_freeze_mark(text)'::regprocedure))
     <> 'fdc0550ae20fd6b10979858c7608a1ec' THEN
    RAISE EXCEPTION 'fn_ca_capture_freeze_mark is not the caller this migration measured';
  END IF;
  IF md5(pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure))
     <> '86863a1208455e92803777829bc9a668' THEN
    RAISE EXCEPTION 'fn_ca_arena_diamonds is not the float this migration leans on';
  END IF;

  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_circulation_total','fn_snapshot_chip_supply','fn_club_chip_circulation')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable without an account', r.proname;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser', r.proname;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena door';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;

  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;

  RAISE NOTICE 'the chip circulation marks count no Diamond: the freeze mark total, the chip supply snapshot and the club chip circulation report each exclude a known diamonds pool, and every chip figure they publish today is unchanged';
END $m$;

COMMIT;
