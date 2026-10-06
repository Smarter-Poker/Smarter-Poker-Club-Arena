-- ============================================================================
-- THE CHIP CIRCULATION PROOF READS ONE SNAPSHOT
-- ============================================================================
--
-- This carries the whole of
-- 20261004124546_the_chip_circulation_marks_count_no_diamond.sql, which is
-- merged on main and CANNOT APPLY. That file is marked SUPERSEDED BY this one
-- and must never run. Nothing about the substance it changed is weakened here:
-- the same three readers, the same three md5 pins, the same clause-occurrence
-- counts, the same reverse-substitution checks, the same refusals and the same
-- closing block. The one thing that changes is HOW the migration proves that
-- no chip figure moves, and the new proof is stronger, not looser.
--
-- WHY THE FIRST FILE REFUSED ITSELF, TWICE, VERBATIM:
--
--   attempt 1 (run 37210153821):
--     ERROR P0001: the chip member wallet total moved:
--                  174066724.55 -> 174066739.55
--   attempt 2 (run 37210433597):
--     ERROR P0001: the chip supply measurement moved:
--                  club 174066957.78 -> 174066957.78, cash 86094.98 -> 86094.98,
--                  tourney 8039400.00 -> 8039400.00, seats 1632 -> 1631
--
-- Attempt 2 is the diagnosis. Every money figure held identical to the cent.
-- The only thing that changed was seats 1632 -> 1631: one player stood up
-- during the 334 ms the transaction was open. The migration was correct and
-- its assertion was wrong.
--
-- THE CAUSE, named in one sentence. Its section 0 captured absolute figures
-- into a temp table and its section 4 re-read the same figures AFTER the
-- substitutions and required equality. Those are two statements at two
-- instants, and at the default READ COMMITTED each statement takes a new
-- snapshot, so the assertion conflated two different claims:
--
--   the claim that matters:  applying the Diamond exclusion changes no chip
--                            figure;
--   the claim it tested:     no unrelated player did anything anywhere on the
--                            platform while my transaction was open.
--
-- The second can essentially never hold on a live floor where horses sit,
-- stand and rebuy continuously. 1632 live seats were on the felt when it ran.
--
-- THE FIX. Compare the filtered figure against the unfiltered figure INSIDE A
-- SINGLE SQL STATEMENT. One statement is evaluated against one snapshot even
-- at READ COMMITTED, so "raw" and "filtered" computed as subqueries of one
-- SELECT are immune to concurrent churn and together prove exactly the claim:
-- that turning the Diamond exclusion on changes the number by nothing. Where
-- the substituted function can be called it IS called, in that same statement,
-- so the new text is exercised rather than assumed:
--
--   * fn_ca_circulation_total() is STABLE, so a call inside the comparison
--     statement uses the CALLING statement's snapshot. Section 4a reads its
--     three outputs and the three unfiltered expressions it was built from in
--     one SELECT, and requires each pair equal.
--   * fn_club_chip_circulation() is STABLE too. Section 4c FULL JOINs its rows
--     against the per-club aggregates computed raw, in one statement, and
--     requires every chip club's four figures identical, no chip club missing,
--     no row without a club and no diamonds club present. That is strictly
--     more than the first file asserted, which only counted the rows.
--   * fn_snapshot_chip_supply() is VOLATILE and WRITES a snapshot row, so it
--     is still not called (CLAUDE.md 11.5: never probe a money path in a way
--     that commits). Section 4b instead reads its four measurements both ways
--     - unfiltered as the pinned text had them, filtered as the substituted
--     text has them - as eight subqueries of ONE statement. The function's own
--     new text is executed for real in the isolated fixture, not here.
--
-- Because both sides of every comparison are read at the same instant, a
-- player standing up no longer answers for the Diamond filter. The seat count
-- is still compared; it is simply compared against itself rather than against
-- a number taken 300 ms earlier.
--
-- WHY NOT REPEATABLE READ, MEASURED AND NOT ASSUMED. The obvious alternative
-- is SET TRANSACTION ISOLATION LEVEL REPEATABLE READ as the first statement
-- after BEGIN. Two things were measured on an isolated PostgreSQL 17 before
-- choosing:
--
--   1. It WOULD take effect. scripts/ci/apply-recorded-migration.mjs sends the
--      whole file as one simple query (client.query(sql)) and does NOT wrap it
--      in a transaction of its own, so this file's own BEGIN is the real
--      transaction start. Sending "BEGIN; SET TRANSACTION ISOLATION LEVEL
--      REPEATABLE READ; ..." as one multi-statement simple query reports
--      transaction_isolation = repeatable read. After any real query it fails
--      with "SET TRANSACTION ISOLATION LEVEL must be called before any query",
--      which is why it would have to be first.
--   2. It would introduce a NEW false refusal here. Under REPEATABLE READ the
--      DATA snapshot is pinned at the first statement while CATALOG lookups
--      stay current. Measured: inside one REPEATABLE READ transaction, a
--      second session replaced a function and updated the table row holding
--      its hash; the transaction then read the OLD stored hash and the NEW
--      pg_get_functiondef text, disagreeing with each other while the two
--      agreed in reality. Section 5 compares ca_guard_defs.def_hash (data)
--      against live pg_get_functiondef (catalog) for every watched guard. On
--      this estate other lanes apply guard migrations continuously, so
--      REPEATABLE READ would make a concurrent lane's correctly-paired
--      redefinition read as "watched guards off their baseline" and abort this
--      file for something nobody did wrong. That is the same class of defect
--      as the one being fixed - an assertion that answers about someone else's
--      work - so it is not added.
--
-- The single-statement comparison needs no isolation level, is unaffected by
-- how the applier transmits the file, and proves the narrower, true claim.
-- Section 4 therefore asserts the property it rests on instead of trusting it:
-- it refuses if either called reader is not STABLE (CLAUDE.md 10.86).
--
-- ---------------------------------------------------------------------------
-- WHAT IS WRONG, and it is unchanged from the superseded file. Read from
-- production on 2026-10-04 (every figure a SELECT through the Supabase MCP
-- inside BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; nothing
-- written, nothing rehearsed against production):
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
--      moved at all.
--
--   2. fn_snapshot_chip_supply() (md5 450da5111403dde7283f46499ad8ef8a)
--      measures the same two pools with no asset filter, writes them into
--      chip_supply_snapshots as club_wallets_total, table_stacks and
--      tournament_stacks, and computes holdings, delta_holdings and
--      unexplained_delta against the previous row. A Diamond seat's stack
--      would enter table_stacks and then unexplained_delta as unexplained
--      CHIPS. No cron.job names this function; its hourly caller is outside
--      the database.
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
-- migration, which section 4 asserts rather than asserts about. That is also
-- why this belongs before the cash switch and not after it: applied after the
-- first Diamond seat, the change would itself show up as a step in
-- table_stacks and a one-off unexplained_delta.
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
-- PINNED LIVE md5(pg_get_functiondef(oid)), re-read 2026-10-04 19:29 UTC and
-- unchanged from the superseded file:
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
-- Changelog: docs/changelog/2026-10-04-the-chip-circulation-proof-reads-one-snapshot.md
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. NOTHING IS OPEN
-- ---------------------------------------------------------------------------
-- Every refusal the superseded file carried, unchanged. What is GONE is the
-- ca_p9b_before temp table it also built here: capturing absolute figures at
-- this instant to compare at a later one is exactly the defect, and section 4
-- now reads both sides of every comparison together instead.
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
-- Every comparison below reads BOTH SIDES IN ONE STATEMENT - the figure with
-- the Diamond exclusion on and the figure with it off - so the equality it
-- requires is a statement about this migration's filter and about nothing
-- else. The superseded file compared a figure measured after the substitution
-- against one measured before it, and a player standing up in between answered
-- for the filter. On production that is what happened: three money figures
-- identical to the cent and seats 1632 -> 1631.

-- 4a. The property the whole section rests on, named rather than assumed
-- (CLAUDE.md 10.86 rule 1). A single SQL statement sees a single snapshot even
-- at READ COMMITTED, and a STABLE function called inside that statement uses
-- the CALLING statement's snapshot. A VOLATILE one would take a fresh snapshot
-- per statement in its body, which would put the comparison back across two
-- instants - the exact defect this file corrects. So if either reader stops
-- being STABLE, this refuses rather than quietly proving less than it says.
DO $m$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN SELECT p.proname, p.provolatile FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_circulation_total','fn_club_chip_circulation')
  LOOP
    IF r.provolatile <> 's' THEN
      RAISE EXCEPTION '% is not STABLE (provolatile %), so calling it cannot share the snapshot of the statement that compares it', r.proname, r.provolatile;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 STABLE readers to compare in one statement, found %', v_n;
  END IF;
END $m$;

-- 4b. The freeze mark's circulation total. The substituted function is CALLED,
-- and the three unfiltered expressions its pinned text was built from are read
-- as subqueries of the same SELECT. Equality of each pair is the claim.
DO $m$
DECLARE
  v_w numeric; v_f numeric; v_t numeric;
  v_raw_w numeric; v_raw_f numeric; v_raw_t numeric;
BEGIN
  SELECT ct.member_wallets, ct.on_the_felt, ct.total,
         COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric,
         COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric,
         COALESCE((SELECT sum(chip_balance) FROM public.club_members), 0)::numeric
           + COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric
    INTO v_w, v_f, v_t, v_raw_w, v_raw_f, v_raw_t
    FROM public.fn_ca_circulation_total() ct;

  -- A figure that could not be read is not a figure that did not move.
  IF v_w IS NULL OR v_f IS NULL OR v_t IS NULL
     OR v_raw_w IS NULL OR v_raw_f IS NULL OR v_raw_t IS NULL THEN
    RAISE EXCEPTION 'a chip circulation figure read as NULL, which is not a measurement';
  END IF;

  IF v_w IS DISTINCT FROM v_raw_w THEN
    RAISE EXCEPTION 'the chip member wallet total moved: % -> % (one snapshot, Diamond filter off then on)', v_raw_w, v_w;
  END IF;
  IF v_f IS DISTINCT FROM v_raw_f THEN
    RAISE EXCEPTION 'the chip felt total moved: % -> % (one snapshot, Diamond filter off then on)', v_raw_f, v_f;
  END IF;
  IF v_t IS DISTINCT FROM v_raw_t THEN
    RAISE EXCEPTION 'the chip circulation total moved: % -> % (one snapshot, Diamond filter off then on)', v_raw_t, v_t;
  END IF;
END $m$;

-- 4c. The chip supply snapshot's four measurements. fn_snapshot_chip_supply
-- is VOLATILE and writes a row, so it is not called (CLAUDE.md 11.5); its
-- measurements are read directly, unfiltered exactly as the pinned text had
-- them and filtered exactly as the substituted text has them, as eight
-- subqueries of ONE statement. The seat count is compared too - against
-- itself at the same instant, which is the comparison the superseded file
-- meant to make.
DO $m$
DECLARE
  v_raw_club numeric; v_raw_cash numeric; v_raw_tourney numeric; v_raw_seats bigint;
  v_club numeric; v_cash numeric; v_tourney numeric; v_seats bigint;
BEGIN
  SELECT
    (SELECT COALESCE(sum(COALESCE(chip_balance,0)), 0) FROM public.club_members),
    (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL), 0)
       FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL),
    (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL), 0)
       FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL),
    (SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL),
    (SELECT COALESCE(sum(COALESCE(cm.chip_balance,0)), 0) FROM public.club_members cm
      WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = cm.club_id AND dc.asset = 'diamonds')),
    (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL), 0)
       FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds')),
    (SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NOT NULL), 0)
       FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds')),
    (SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
      WHERE ts.left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds'))
    INTO v_raw_club, v_raw_cash, v_raw_tourney, v_raw_seats,
         v_club, v_cash, v_tourney, v_seats;

  IF v_raw_club IS NULL OR v_raw_cash IS NULL OR v_raw_tourney IS NULL OR v_raw_seats IS NULL
     OR v_club IS NULL OR v_cash IS NULL OR v_tourney IS NULL OR v_seats IS NULL THEN
    RAISE EXCEPTION 'a chip supply measurement read as NULL, which is not a measurement';
  END IF;

  IF v_club IS DISTINCT FROM v_raw_club OR v_cash IS DISTINCT FROM v_raw_cash
     OR v_tourney IS DISTINCT FROM v_raw_tourney OR v_seats IS DISTINCT FROM v_raw_seats THEN
    RAISE EXCEPTION 'the chip supply measurement moved: club % -> %, cash % -> %, tourney % -> %, seats % -> % (one snapshot, Diamond filter off then on)',
      v_raw_club, v_club, v_raw_cash, v_cash, v_raw_tourney, v_tourney, v_raw_seats, v_seats;
  END IF;
END $m$;

-- 4d. The chip circulation report. The substituted function is CALLED and its
-- rows are FULL JOINed, in one statement, against the per-club aggregates
-- computed raw from the same snapshot. This is strictly more than the
-- superseded file asserted: it counted the rows, and this compares every chip
-- club's name and all four of its figures as well.
DO $m$
DECLARE
  v_reported_without_a_club bigint;
  v_chip_club_missing bigint;
  v_diamond_club_reported bigint;
  v_figure_changed bigint;
  v_chip_clubs bigint;
  v_reported bigint;
BEGIN
  SELECT count(*) FILTER (WHERE x.reported AND NOT x.a_club),
         count(*) FILTER (WHERE x.a_club AND x.asset <> 'diamonds' AND NOT x.reported),
         count(*) FILTER (WHERE x.a_club AND x.asset = 'diamonds' AND x.reported),
         count(*) FILTER (WHERE x.reported AND x.a_club AND x.changed),
         count(*) FILTER (WHERE x.a_club AND x.asset <> 'diamonds'),
         count(*) FILTER (WHERE x.reported)
    INTO v_reported_without_a_club, v_chip_club_missing, v_diamond_club_reported,
         v_figure_changed, v_chip_clubs, v_reported
    FROM (
      SELECT (r.club_id IS NOT NULL) AS reported,
             (c.id IS NOT NULL)      AS a_club,
             c.asset                 AS asset,
             (r.club_name      IS DISTINCT FROM c.name
           OR r.member_wallets IS DISTINCT FROM
                COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                           WHERE cm.club_id = c.id), 0)
           OR r.on_the_felt    IS DISTINCT FROM
                COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                           WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0)
           OR r.treasury       IS DISTINCT FROM COALESCE(c.chip_pool, 0)
           OR r.total          IS DISTINCT FROM
                COALESCE((SELECT SUM(cm.chip_balance) FROM public.club_members cm
                           WHERE cm.club_id = c.id), 0)
              + COALESCE((SELECT SUM(ts.stack) FROM public.table_seats ts
                           WHERE ts.club_id = c.id AND ts.left_at IS NULL), 0)
              + COALESCE(c.chip_pool, 0)) AS changed
        FROM public.clubs c
        FULL JOIN public.fn_club_chip_circulation() r ON r.club_id = c.id
    ) x;

  IF v_reported_without_a_club <> 0 THEN
    RAISE EXCEPTION 'the chip circulation report lists % row(s) for a club that does not exist', v_reported_without_a_club;
  END IF;
  -- And every chip club still has its row in the chip circulation report.
  IF v_chip_club_missing <> 0 OR v_reported IS DISTINCT FROM v_chip_clubs THEN
    RAISE EXCEPTION 'the chip circulation report lost or gained a chip club: % chip clubs, % rows, % chip club(s) missing',
      v_chip_clubs, v_reported, v_chip_club_missing;
  END IF;
  IF v_diamond_club_reported <> 0 THEN
    RAISE EXCEPTION 'the chip circulation report still lists a diamonds club';
  END IF;
  IF v_figure_changed <> 0 THEN
    RAISE EXCEPTION 'the chip circulation report changed a chip club: % club(s) differ from the raw per-club aggregate read in the same statement', v_figure_changed;
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

  RAISE NOTICE 'the chip circulation marks count no Diamond: the freeze mark total, the chip supply snapshot and the club chip circulation report each exclude a known diamonds pool, and every chip figure they publish today is unchanged - each one proved by reading the filtered and unfiltered figure in a single statement, so no concurrent seat can answer for the filter';
END $m$;

COMMIT;
