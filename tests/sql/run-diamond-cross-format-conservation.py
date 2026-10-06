#!/usr/bin/env python3
"""Prove, on an isolated PostgreSQL 17, that no chip reader adds a Diamond to a chip.

Never connects to production and needs no credential. This starts a cluster of
its own inside a temporary directory it creates and destroys, with
listen_addresses empty and a socket nobody else can name, so there is no
environment variable that could point it at a real database. PG_BIN selects
which PostgreSQL 17 binaries run and is the only thing it reads from the
environment.

WHAT THIS IS FOR. Phase 9's cross-format conservation line. A prior lane
certified the statistics dimension: run-diamond-stats-asset-dimension.py
reproduces "250 chips and 7 diamonds summed to 257.00 in one figure" in the
per-hand facts and then the fix. This is the same defect class in the
CONSERVATION readers, which is where it costs more: one of them decides whether
the hourly platform freeze conserved.

  * fn_ca_circulation_total() is member wallets plus every live seat's stack,
    with no asset filter. Two active cron jobs (ca-freeze-mark-pre at :55,
    ca-freeze-mark-post at :00) call fn_ca_capture_freeze_mark, which writes
    that figure into ca_freeze_circulation_marks, and
    fn_ca_record_break_scorecard then reads the pre and post totals of one
    window and decides v_conserved from their difference against a chip
    tolerance. A Diamond seat inside that figure makes the break report that
    chips did not conserve when no chip moved.
  * fn_snapshot_chip_supply() measures the same pools, writes table_stacks and
    club_wallets_total, and turns their movement into unexplained_delta.
  * fn_club_chip_circulation() reports a diamonds club's Diamond felt under a
    chip total.

Step 0 of the destinations design (migrations 20260929160000 and 160100) fixed
the hourly chip supply METER, fn_ca_supply_snapshot, for exactly this reason.
These three are its siblings and were not fixed.

HOW IT PROVES IT. The six readers are loaded from
poker-diamond-cross-format-conservation-doors.sql, which is production's own
pg_get_functiondef text, and every one of them is checked against the md5
pinned for it in diamond-cross-format-conservation-doors.manifest.json before a
single case runs. The BEFORE cases then reproduce each defect as an assertion
that PASSES on the installed text - a regression that only ever passes proves
nothing about the bug it claims to fix. The runner then applies
supabase/migrations/20261004194622_the_chip_circulation_proof_reads_one_snapshot.sql,
the real file, verbatim, including its own md5 pins and its closing assertions,
and proves the same figures afterwards. That file supersedes
20261004124546_the_chip_circulation_marks_count_no_diamond.sql, which merged,
refused itself twice on apply and must never run; this runner checks the
superseded file still says so and never applies it.

The last section walks a Diamond through every format the arena deals and
asserts, after each movement, that the Diamond identity still closes, that the
Diamond float moved by exactly the amount, and that not one chip figure moved.
Those movements are written in the shape the installed doors write them and
each one names its door; this runner does not execute the doors themselves -
run-diamond-tournament-lifecycle.py and run-diamond-concurrency.py do that. The
claim here is about the two sides of the books agreeing across formats, and
about no chip reader seeing any of it.

Every amount below is a fixture amount chosen to be legible (7, 90, 1000). None
of them is a rate, a price, a fee or a guarantee, and nothing here approves one:
the Diamond economics are Dan's, unset, and refuse by name.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / 'tests' / 'sql'
DOORS = SQL_DIR / 'poker-diamond-cross-format-conservation-doors.sql'
SCHEMA = SQL_DIR / 'poker-diamond-cross-format-conservation-schema.sql'
MANIFEST = SQL_DIR / 'diamond-cross-format-conservation-doors.manifest.json'
# The applied file is the SUCCESSOR. 20261004124546 merged, refused itself
# twice on apply (its section 4 compared a figure measured after the
# substitutions against one measured before them, so a player standing up
# mid-transaction answered for the Diamond filter) and is marked SUPERSEDED
# BY 20261004194622, which carries the same substance and proves it by
# reading the filtered and unfiltered figure in one statement.
MIGRATION = ROOT / 'supabase' / 'migrations' / \
    '20261004194622_the_chip_circulation_proof_reads_one_snapshot.sql'
SUPERSEDED = ROOT / 'supabase' / 'migrations' / \
    '20261004124546_the_chip_circulation_marks_count_no_diamond.sql'

# PG_BIN names the PostgreSQL 17 BINARIES and never a server. Default is the
# owner's Homebrew path; bin_path falls back to the packaged Linux locations
# and then to PATH, so a CI box with no Homebrew resolves the tools without a
# second variable to keep in step with this one.
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
PACKAGED_BINDIRS = ('/usr/lib/postgresql/17/bin', '/usr/pgsql-17/bin')

# macOS: the postmaster refuses to start under a locale it has to resolve
# through the system framework. A plain C locale is also what makes the
# fixture's text comparisons deterministic wherever it runs.
ENV = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}

ARENA = '002c2d27-9584-4e52-835a-bb2be148fc81'   # the Diamond Arena, as production has it
CHIP_CLUB = '00000000-0000-0000-0000-0000000000c1'
P_CHIP = '00000000-0000-0000-0000-0000000000a1'
P_DIA = '00000000-0000-0000-0000-0000000000a2'
T_CHIP = '00000000-0000-0000-0000-0000000000b1'
T_DIA = '00000000-0000-0000-0000-0000000000b2'


def bin_path(name: str) -> str:
    for bindir in (PG_BIN,) + PACKAGED_BINDIRS:
        candidate = pathlib.Path(bindir) / name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if not found:
        raise SystemExit(f'PostgreSQL 17 tool not found: {name} (set PG_BIN)')
    return found


# ---------------------------------------------------------------------------
# The fixture world. One chip club with a chip player, and the Diamond Arena
# with a Diamond player whose buy-in sits in custody, which is the shape
# fn_poker_diamond_buyin leaves: the wallet paid, the custody row holds it,
# and the seat's stack is that custody decomposed onto the felt.
# ---------------------------------------------------------------------------
SEED = f"""
INSERT INTO public.ca_arena_settings(id, club_id, cash_games_enabled, tournaments_enabled, note)
VALUES (1, '{ARENA}', false, false, 'the fixture never opens a door');

INSERT INTO public.clubs(id, name, asset, is_platform) VALUES
  ('{CHIP_CLUB}', 'Fixture Chip Club', 'chips', false),
  ('{ARENA}',     'Diamond Arena',     'diamonds', true);

INSERT INTO public.club_members(club_id, user_id, chip_balance) VALUES
  ('{CHIP_CLUB}', '{P_CHIP}', 250.00),
  -- Automatic Diamond membership, and the membership guard holds it at zero
  -- chips. It is here because the readers sum club_members with no filter.
  ('{ARENA}',     '{P_DIA}',  0.00);

INSERT INTO public.tables(id, club_id, name) VALUES
  ('{T_CHIP}', '{CHIP_CLUB}', 'Chip NLH 1/2'),
  ('{T_DIA}',  '{ARENA}',     'Diamond NLH 1/2');

INSERT INTO public.table_seats(table_id, club_id, user_id, stack) VALUES
  ('{T_CHIP}', '{CHIP_CLUB}', '{P_CHIP}', 900.00),
  ('{T_DIA}',  '{ARENA}',     '{P_DIA}',    7.00);

INSERT INTO public.wallets(user_id, balance) VALUES ('{P_CHIP}', 1000.00);
INSERT INTO public.wallet_transactions(type, category, amount) VALUES ('credit','deposit',1000.00);

-- The Diamond side. The register issued 107 to the player; 100 is still in
-- his wallet and 7 is the custody row behind his seat, so
-- players + house + fn_ca_arena_diamonds() = register, exactly.
INSERT INTO public.profiles(id, diamonds) VALUES ('{P_DIA}', 100);
INSERT INTO public.ca_diamond_house(id, balance) VALUES (1, 0);
INSERT INTO public.ca_mint_ledger
  (op_id, action, asset, holder_type, holder_id, holder_label, amount,
   balance_before, balance_after, supply_after, reason)
VALUES ('fixture:issue', 'mint', 'diamonds', 'player', '{P_DIA}', 'the diamond player',
        107, 0, 107, 107, 'fixture issuance so the identity closes');
INSERT INTO public.poker_diamond_custody
  (user_id, arena_id, purpose, target_id, entry_key, balance, state)
VALUES ('{P_DIA}', '{ARENA}', 'cash_seat', '{T_DIA}', 'fixture:cash_seat', 7, 'ACTIVE');
"""

# Production's grant posture, set once the readers exist. A fresh cluster
# leaves a new function's ACL at the built-in default, which grants EXECUTE to
# PUBLIC; production has revoked that and these three readers are service_role
# only. The migration's closing block refuses to commit if any of them is
# reachable by anon or authenticated, so the fixture has to hold production's
# posture or that check would fire on the difference between an empty cluster
# and production rather than on anything the migration did. CREATE OR REPLACE
# keeps an existing ACL, so this holds across the migration.
GRANT_POSTURE = """
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('fn_ca_circulation_total','fn_snapshot_chip_supply','fn_club_chip_circulation')
  LOOP
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'the fixture did not reach production''s grant posture for %', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not reachable by the role production runs it as', r.proname;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS: the three readers are service_role only, as production has them';
END $$;
"""

PINS = """
DO $$
DECLARE r record; v_got text; n int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES __VALUES__) AS t(sig, want) LOOP
    v_got := md5(pg_get_functiondef(r.sig::regprocedure));
    IF v_got <> r.want THEN
      RAISE EXCEPTION 'loaded % is not production''s text: md5 % expected %', r.sig, v_got, r.want;
    END IF;
    n := n + 1;
  END LOOP;
  IF n <> __COUNT__ THEN RAISE EXCEPTION 'expected __COUNT__ pinned readers, checked %', n; END IF;
  RAISE NOTICE 'PASS: all __COUNT__ readers are byte-for-byte the text production runs';
END $$;
"""

IDENTITY_IS_WHOLE = """
DO $$
DECLARE d numeric; m numeric; f numeric;
BEGIN
  SELECT difference, meter_total INTO d, m FROM public.fn_ca_diamond_register_vs_supply();
  f := public.fn_ca_arena_diamonds();
  IF d <> 0 THEN RAISE EXCEPTION 'the fixture does not close the Diamond identity (difference %)', d; END IF;
  IF m <> 107 THEN RAISE EXCEPTION 'the fixture meter is % and not 107', m; END IF;
  IF f <> 7 THEN RAISE EXCEPTION 'the arena float is % and not the 7 in custody', f; END IF;
  RAISE NOTICE 'PASS: the fixture closes - register 107 = wallet 100 + house 0 + arena float 7';
END $$;
"""

# ---------------------------------------------------------------------------
# BEFORE. Each of these PASSES against the installed text.
# ---------------------------------------------------------------------------
BEFORE = """
DO $$
DECLARE m numeric; f numeric; t numeric; r record;
BEGIN
  -- 1. The freeze mark's own writer, the one the two crons call.
  PERFORM public.fn_ca_capture_freeze_mark('pre');
  SELECT member_wallets, on_the_felt, total INTO m, f, t
    FROM public.ca_freeze_circulation_marks WHERE kind = 'pre';
  IF f <> 907.00 THEN RAISE EXCEPTION 'expected the defect on the felt (907.00), got %', f; END IF;
  IF t <> 1157.00 THEN RAISE EXCEPTION 'expected the defect in the total (1157.00), got %', t; END IF;
  RAISE NOTICE 'PASS: reproduced - 900 chips and 7 diamonds on the felt summed to 907.00 in the freeze mark';
  RAISE NOTICE 'PASS: and the mark total 1157.00 is 250 chip wallet + 900 chips + 7 diamonds, in one number';

  -- 2. Nothing in the row can take it apart again. The mark carries no asset.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'ca_freeze_circulation_marks'
                AND column_name IN ('asset', 'club_id', 'diamond_felt')) THEN
    RAISE EXCEPTION 'fixture wrong: the mark already carries a dimension';
  END IF;
  RAISE NOTICE 'PASS: the mark carries no asset or club column to separate them afterwards';

  -- 3. The two crons pair a :55 pre with a :00 post in ONE window, which is
  --    what makes the scorecard's subtraction meaningful. Pure arithmetic from
  --    fn_ca_capture_freeze_mark, checked rather than assumed.
  IF date_trunc('hour', '2026-10-04 11:55:00+00'::timestamptz) + interval '1 hour'
     IS DISTINCT FROM date_trunc('hour', '2026-10-04 12:00:00+00'::timestamptz + interval '2 minutes') THEN
    RAISE EXCEPTION 'the pre and post marks of one break do not share a window_hour';
  END IF;
  RAISE NOTICE 'PASS: the :55 pre mark and the :00 post mark land on one window_hour';
END $$;
"""

BEFORE_VERDICT = """
-- The Diamond player stands up. His 7 Diamonds leave the felt and go back to
-- his wallet: the custody row is released, which is what fn_poker_diamond_release
-- does, and the Diamonds are conserved to the Diamond. No chip moved, and no
-- wallet_transactions row exists, because a Diamond cash-out is not a chip
-- journal entry.
DO $$
DECLARE v_pre numeric; v_post numeric; v_delta numeric; v_conserved boolean;
BEGIN
  SELECT total INTO v_pre FROM public.ca_freeze_circulation_marks WHERE kind = 'pre';

  UPDATE public.table_seats SET left_at = now(), stack = 0
   WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED'
   WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds + 7 WHERE id = '__P_DIA__';

  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond did not conserve across the cash-out';
  END IF;
  IF public.fn_ca_arena_diamonds() <> 0 THEN
    RAISE EXCEPTION 'the arena float still holds the released Diamond';
  END IF;

  SELECT total INTO v_post FROM (SELECT total FROM public.fn_ca_circulation_total()) s;

  -- fn_ca_record_break_scorecard, verbatim:
  --     v_delta := v_post - v_pre;
  --     v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  v_delta := v_post - v_pre;
  v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  IF v_delta <> -7.00 THEN RAISE EXCEPTION 'expected the defect delta (-7.00), got %', v_delta; END IF;
  IF v_conserved IS NOT FALSE THEN
    RAISE EXCEPTION 'expected the break to read as not conserved, got %', v_conserved;
  END IF;
  RAISE NOTICE 'PASS: reproduced - 7 diamonds leaving the felt makes the break verdict say chips did not conserve (delta -7.00 against a tolerance of 1.0)';

  -- Put the seat back, so the AFTER cases measure the same world.
  UPDATE public.table_seats SET left_at = NULL, stack = 7.00 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 7, state = 'ACTIVE' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds - 7 WHERE id = '__P_DIA__';
  DELETE FROM public.ca_freeze_circulation_marks;
END $$;
""".replace('__T_DIA__', T_DIA).replace('__P_DIA__', P_DIA)

BEFORE_SNAPSHOT = """
DO $$
DECLARE a jsonb; b jsonb;
BEGIN
  a := public.fn_snapshot_chip_supply();
  IF (a->>'cash_table_stacks')::numeric <> 907.00 THEN
    RAISE EXCEPTION 'expected the defect in table_stacks (907.00), got %', a->>'cash_table_stacks';
  END IF;
  RAISE NOTICE 'PASS: reproduced - the chip supply snapshot records 907.00 on cash tables, 7 of them Diamonds';

  -- The Diamond leaves the felt, and nothing chip-denominated explains it.
  UPDATE public.table_seats SET left_at = now(), stack = 0 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds + 7 WHERE id = '__P_DIA__';

  b := public.fn_snapshot_chip_supply();
  IF (b->>'unexplained_delta')::numeric <> -7.00 THEN
    RAISE EXCEPTION 'expected the defect in unexplained_delta (-7.00), got %', b->>'unexplained_delta';
  END IF;
  RAISE NOTICE 'PASS: reproduced - and the next snapshot files that Diamond as -7.00 of UNEXPLAINED CHIP supply';

  UPDATE public.table_seats SET left_at = NULL, stack = 7.00 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 7, state = 'ACTIVE' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds - 7 WHERE id = '__P_DIA__';
  DELETE FROM public.chip_supply_snapshots;
END $$;
""".replace('__T_DIA__', T_DIA).replace('__P_DIA__', P_DIA)

BEFORE_CLUB_REPORT = """
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.fn_club_chip_circulation('__ARENA__');
  IF r.club_id IS NULL THEN RAISE EXCEPTION 'fixture wrong: the arena has no row to find'; END IF;
  IF r.on_the_felt <> 7.00 OR r.total <> 7.00 THEN
    RAISE EXCEPTION 'expected the defect (7.00 of Diamond felt under a chip total), got felt % total %',
      r.on_the_felt, r.total;
  END IF;
  IF r.member_wallets <> 0 OR r.treasury <> 0 THEN
    RAISE EXCEPTION 'the arena is not supposed to be able to hold a chip wallet or treasury';
  END IF;
  RAISE NOTICE 'PASS: reproduced - the chip circulation report gives the Diamond Arena a chip total of 7.00, which is 7 Diamonds';
END $$;
""".replace('__ARENA__', ARENA)

# The migration refuses to apply while a Diamond seat is live: with one
# already on the felt, the chip figures it corrects have ALREADY been
# published wrong, and quietly changing the definition would hide the step
# instead of reporting it. Production has no Diamond seat and cannot have one
# while cash_games_enabled is false, which is why this belongs before the
# switch. An error is the success case here.
REFUSES_OVER_A_LIVE_SEAT_MESSAGE = 'a live Diamond seat already exists'

STAND_THE_DIAMOND_PLAYER_UP = """
-- Production's state, which is where this migration is meant to be applied:
-- poker_diamond_custody holds nothing and no seat in a diamonds club is live.
UPDATE public.table_seats SET left_at = now(), stack = 0 WHERE table_id = '__T_DIA__';
UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED' WHERE entry_key = 'fixture:cash_seat';
UPDATE public.profiles SET diamonds = diamonds + 7 WHERE id = '__P_DIA__';
DELETE FROM public.ca_freeze_circulation_marks;
DELETE FROM public.chip_supply_snapshots;
DO $$
BEGIN
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond did not conserve on the way to production''s state';
  END IF;
  IF public.fn_ca_arena_diamonds() <> 0 THEN RAISE EXCEPTION 'the arena float is not empty'; END IF;
  RAISE NOTICE 'PASS: the fixture is now in production''s state - 0 custody rows funded, no live Diamond seat, identity whole';
END $$;
""".replace('__T_DIA__', T_DIA).replace('__P_DIA__', P_DIA)

SEAT_THE_DIAMOND_PLAYER_AGAIN = """
-- The same buy-in again, through the same shape fn_poker_diamond_buyin leaves,
-- so the AFTER cases measure a funded Diamond seat against the chip baseline.
UPDATE public.profiles SET diamonds = diamonds - 7 WHERE id = '__P_DIA__';
UPDATE public.poker_diamond_custody SET balance = 7, state = 'ACTIVE' WHERE entry_key = 'fixture:cash_seat';
UPDATE public.table_seats SET left_at = NULL, stack = 7.00 WHERE table_id = '__T_DIA__';
DO $$
BEGIN
  IF public.fn_ca_arena_diamonds() <> 7 THEN RAISE EXCEPTION 'the re-seated Diamond is not in the float'; END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond did not conserve across the re-seating';
  END IF;
END $$;
""".replace('__T_DIA__', T_DIA).replace('__P_DIA__', P_DIA)

CHIP_BASELINE = """
CREATE TABLE fixture_chip_baseline AS
SELECT
  (SELECT member_wallets FROM public.fn_ca_circulation_total()) AS member_wallets,
  (SELECT on_the_felt    FROM public.fn_ca_circulation_total()) AS on_the_felt,
  (SELECT total          FROM public.fn_ca_circulation_total()) AS total,
  (SELECT COALESCE(sum(ts.stack),0) FROM public.table_seats ts
     JOIN public.tables t ON t.id = ts.table_id
     JOIN public.clubs c ON c.id = t.club_id
    WHERE ts.left_at IS NULL AND c.asset = 'chips')            AS chip_felt_only,
  (SELECT COALESCE(sum(cm.chip_balance),0) FROM public.club_members cm
     JOIN public.clubs c ON c.id = cm.club_id WHERE c.asset = 'chips') AS chip_wallets_only;
"""

# ---------------------------------------------------------------------------
# AFTER the migration.
# ---------------------------------------------------------------------------
AFTER = """
DO $$
DECLARE m numeric; f numeric; t numeric; b record; r record; a jsonb; v_rows int;
        v_pre numeric; v_post numeric; v_delta numeric; v_conserved boolean;
BEGIN
  SELECT * INTO b FROM fixture_chip_baseline;

  -- 1. The freeze mark is chips, and it is the CHIP figure, not a reduced one.
  PERFORM public.fn_ca_capture_freeze_mark('pre');
  SELECT member_wallets, on_the_felt, total INTO m, f, t
    FROM public.ca_freeze_circulation_marks WHERE kind = 'pre';
  IF f <> b.chip_felt_only OR f <> 900.00 THEN
    RAISE EXCEPTION 'the mark felt is % and not the 900.00 of chips', f;
  END IF;
  IF m <> b.chip_wallets_only OR m <> 250.00 THEN
    RAISE EXCEPTION 'the mark member wallets are % and not the 250.00 of chips', m;
  END IF;
  IF t <> 1150.00 THEN RAISE EXCEPTION 'the mark total is % and not 1150.00', t; END IF;
  RAISE NOTICE 'PASS: the freeze mark reads 250.00 + 900.00 = 1150.00, every one of them a chip';

  -- 2. The break verdict: the same Diamond cash-out, and the verdict holds.
  SELECT total INTO v_pre FROM public.ca_freeze_circulation_marks WHERE kind = 'pre';
  UPDATE public.table_seats SET left_at = now(), stack = 0 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds + 7 WHERE id = '__P_DIA__';
  SELECT total INTO v_post FROM public.fn_ca_circulation_total();
  v_delta := v_post - v_pre;
  v_conserved := (abs(v_delta) <= GREATEST(1.0, COALESCE(v_pre, 0) * 1e-7));
  IF v_delta <> 0 THEN RAISE EXCEPTION 'a Diamond cash-out still moves the chip total by %', v_delta; END IF;
  IF v_conserved IS NOT TRUE THEN RAISE EXCEPTION 'the break still reads as not conserved'; END IF;
  RAISE NOTICE 'PASS: 7 diamonds leaving the felt moves the chip total by 0.00 and the break verdict holds';

  -- 3. And the Diamond is KEPT, not discarded: it is in the Diamond books.
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity broke';
  END IF;
  IF public.fn_ca_arena_diamonds() <> 0 THEN RAISE EXCEPTION 'the float did not release'; END IF;
  UPDATE public.table_seats SET left_at = NULL, stack = 7.00 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 7, state = 'ACTIVE' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds - 7 WHERE id = '__P_DIA__';
  IF public.fn_ca_arena_diamonds() <> 7 THEN
    RAISE EXCEPTION 'the Diamond on the felt is counted nowhere: the float reads %', public.fn_ca_arena_diamonds();
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity broke';
  END IF;
  RAISE NOTICE 'PASS: the Diamond is kept and counted by fn_ca_arena_diamonds(), not thrown away with the chip figure';

  -- 4. The chip supply snapshot.
  DELETE FROM public.chip_supply_snapshots;
  a := public.fn_snapshot_chip_supply();
  IF (a->>'cash_table_stacks')::numeric <> 900.00 THEN
    RAISE EXCEPTION 'the snapshot records % on cash tables and not 900.00', a->>'cash_table_stacks';
  END IF;
  UPDATE public.table_seats SET left_at = now(), stack = 0 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds + 7 WHERE id = '__P_DIA__';
  a := public.fn_snapshot_chip_supply();
  IF (a->>'unexplained_delta')::numeric <> 0 THEN
    RAISE EXCEPTION 'a Diamond cash-out still files % of unexplained chip supply', a->>'unexplained_delta';
  END IF;
  RAISE NOTICE 'PASS: the chip supply snapshot records 900.00 of chips and files no unexplained chip when a Diamond moves';
  UPDATE public.table_seats SET left_at = NULL, stack = 7.00 WHERE table_id = '__T_DIA__';
  UPDATE public.poker_diamond_custody SET balance = 7, state = 'ACTIVE' WHERE entry_key = 'fixture:cash_seat';
  UPDATE public.profiles SET diamonds = diamonds - 7 WHERE id = '__P_DIA__';

  -- 5. The club report lists the chip clubs and not the arena.
  SELECT count(*) INTO v_rows FROM public.fn_club_chip_circulation();
  IF v_rows <> 1 THEN RAISE EXCEPTION 'the chip circulation report lists % clubs, expected the 1 chip club', v_rows; END IF;
  IF EXISTS (SELECT 1 FROM public.fn_club_chip_circulation() x WHERE x.club_id = '__ARENA__') THEN
    RAISE EXCEPTION 'the chip circulation report still lists the Diamond Arena';
  END IF;
  SELECT * INTO r FROM public.fn_club_chip_circulation('__CHIP_CLUB__');
  IF r.member_wallets <> 250.00 OR r.on_the_felt <> 900.00 OR r.total <> 900.00 + 250.00 THEN
    RAISE EXCEPTION 'the chip club report changed: wallets %, felt %, total %', r.member_wallets, r.on_the_felt, r.total;
  END IF;
  RAISE NOTICE 'PASS: the chip circulation report lists the chip club unchanged and gives the arena no chip row';

  -- 6. And asking for the arena by name answers nothing rather than a chip lie.
  IF EXISTS (SELECT 1 FROM public.fn_club_chip_circulation('__ARENA__')) THEN
    RAISE EXCEPTION 'the arena still answers the chip circulation report by name';
  END IF;
  RAISE NOTICE 'PASS: asked for the arena by name, the chip report returns no row at all';
END $$;
""".replace('__T_DIA__', T_DIA).replace('__P_DIA__', P_DIA).replace('__ARENA__', ARENA).replace('__CHIP_CLUB__', CHIP_CLUB)

# ---------------------------------------------------------------------------
# CROSS-FORMAT CONSERVATION. One Diamond walked through every format, and
# after every movement: the identity closes, the float moves by exactly the
# amount, and no chip figure moves at all.
# ---------------------------------------------------------------------------
FORMATS = """
CREATE TABLE fixture_moves(ord int PRIMARY KEY, label text, door text, sql text, float_after bigint);
INSERT INTO fixture_moves VALUES
 (1, 'cash seat buy-in', 'fn_poker_diamond_buyin: wallet to a cash_seat custody row', $m$
    UPDATE public.profiles SET diamonds = diamonds - 90 WHERE id = 'P_DIA';
    INSERT INTO public.poker_diamond_custody(user_id, arena_id, purpose, target_id, entry_key, balance, state)
    VALUES ('P_DIA', 'ARENA', 'cash_seat', 'T_DIA', 'fixture:buyin', 90, 'ACTIVE');
    UPDATE public.table_seats SET stack = stack + 90 WHERE table_id = 'T_DIA';
  $m$, 97),
 (2, 'cash seat cash-out', 'fn_poker_diamond_release: the custody row back to the wallet', $m$
    UPDATE public.table_seats SET stack = stack - 90 WHERE table_id = 'T_DIA';
    UPDATE public.poker_diamond_custody SET balance = 0, state = 'RELEASED' WHERE entry_key = 'fixture:buyin';
    UPDATE public.profiles SET diamonds = diamonds + 90 WHERE id = 'P_DIA';
  $m$, 7),
 (3, 'tournament entry', 'fn_poker_diamond_tournament_charge: wallet to a tournament_entry custody row', $m$
    UPDATE public.profiles SET diamonds = diamonds - 50 WHERE id = 'P_DIA';
    INSERT INTO public.poker_diamond_custody(user_id, arena_id, purpose, target_id, entry_key, balance, state)
    VALUES ('P_DIA', 'ARENA', 'tournament_entry', 'T_DIA', 'fixture:entry', 50, 'ACTIVE');
  $m$, 57),
 (4, 'satellite seat', 'the satellite settler: custody to custody, no wallet touched', $m$
    UPDATE public.poker_diamond_custody SET balance = balance - 20 WHERE entry_key = 'fixture:entry';
    INSERT INTO public.poker_diamond_custody(user_id, arena_id, purpose, target_id, entry_key, balance, state)
    VALUES ('P_DIA', 'ARENA', 'tournament_entry', 'T_DIA', 'fixture:satellite_seat', 20, 'ACTIVE');
  $m$, 57),
 (5, 'tournament fee to the house', 'fn_poker_diamond_tournament_settle_fee: the player''s burn and the house''s mint, one pair', $m$
    UPDATE public.poker_diamond_custody SET balance = balance - 5 WHERE entry_key = 'fixture:entry';
    INSERT INTO public.ca_mint_ledger(op_id, action, asset, holder_type, holder_id, holder_label,
      amount, balance_before, balance_after, supply_after, reason)
    VALUES ('fixture:fee:burn', 'burn', 'diamonds', 'player', 'P_DIA', 'the diamond player',
            5, 0, 0, 102, 'the fee leaves the player');
    UPDATE public.ca_diamond_house SET balance = balance + 5 WHERE id = 1;
    INSERT INTO public.ca_mint_ledger(op_id, action, asset, holder_type, holder_id, holder_label,
      amount, balance_before, balance_after, supply_after, reason)
    VALUES ('fixture:fee:mint', 'mint', 'diamonds', 'house', '00000000-0000-0000-0000-00000000d1a0', 'the house',
            5, 0, 5, 107, 'DR14 (poker_tournament_fee)');
  $m$, 52),
 (6, 'tournament prize', 'fn_poker_diamond_tournament_pay: custody to the winner''s wallet, a transfer the register does not follow', $m$
    UPDATE public.poker_diamond_custody SET balance = balance - 25 WHERE entry_key = 'fixture:entry';
    UPDATE public.profiles SET diamonds = diamonds + 25 WHERE id = 'P_DIA';
  $m$, 27),
 (7, 'spin day entry', 'the Diamond Spin day: the entry leaves the wallet and is pending inside the arena float', $m$
    UPDATE public.profiles SET diamonds = diamonds - 20 WHERE id = 'P_DIA';
    INSERT INTO public.diamond_spin_days(owner_id, day, status, pending_diamonds)
    VALUES ('P_DIA', current_date, 'open', 20);
  $m$, 47),
 (8, 'spin day settles', 'the day closes: its pending Diamonds leave the float for the wallet', $m$
    UPDATE public.diamond_spin_days SET status = 'settled', pending_diamonds = 0
     WHERE owner_id = 'P_DIA' AND day = current_date;
    UPDATE public.profiles SET diamonds = diamonds + 20 WHERE id = 'P_DIA';
  $m$, 27);

DO $outer$
DECLARE mv record; v_before record; v_after record; v_float bigint; v_diff numeric;
        v_snap_cash numeric; v_snap_club numeric; v_snap_before_cash numeric; v_snap_before_club numeric;
BEGIN
  FOR mv IN SELECT * FROM fixture_moves ORDER BY ord LOOP
    SELECT member_wallets, on_the_felt, total INTO v_before FROM public.fn_ca_circulation_total();
    SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL),0) INTO v_snap_before_cash
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds');
    SELECT COALESCE(sum(COALESCE(cm.chip_balance,0)),0) INTO v_snap_before_club FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = cm.club_id AND dc.asset = 'diamonds');

    EXECUTE replace(replace(replace(mv.sql, 'P_DIA', 'PDIA_UUID'), 'ARENA', 'ARENA_UUID'), 'T_DIA', 'TDIA_UUID');

    v_float := public.fn_ca_arena_diamonds();
    SELECT difference INTO v_diff FROM public.fn_ca_diamond_register_vs_supply();
    SELECT member_wallets, on_the_felt, total INTO v_after FROM public.fn_ca_circulation_total();
    SELECT COALESCE(sum(ts.stack) FILTER (WHERE t.tournament_id IS NULL),0) INTO v_snap_cash
      FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
     WHERE ts.left_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds');
    SELECT COALESCE(sum(COALESCE(cm.chip_balance,0)),0) INTO v_snap_club FROM public.club_members cm
     WHERE NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = cm.club_id AND dc.asset = 'diamonds');

    IF v_diff <> 0 THEN
      RAISE EXCEPTION '% (%): the Diamond identity opened by %', mv.label, mv.door, v_diff;
    END IF;
    IF v_float <> mv.float_after THEN
      RAISE EXCEPTION '% (%): the arena float is % and the movement says it should be %',
        mv.label, mv.door, v_float, mv.float_after;
    END IF;
    IF v_after.member_wallets IS DISTINCT FROM v_before.member_wallets
       OR v_after.on_the_felt IS DISTINCT FROM v_before.on_the_felt
       OR v_after.total IS DISTINCT FROM v_before.total THEN
      RAISE EXCEPTION '% (%): a Diamond movement moved the chip circulation total from % to %',
        mv.label, mv.door, v_before.total, v_after.total;
    END IF;
    IF v_snap_cash IS DISTINCT FROM v_snap_before_cash OR v_snap_club IS DISTINCT FROM v_snap_before_club THEN
      RAISE EXCEPTION '% (%): a Diamond movement moved the chip supply measurement', mv.label, mv.door;
    END IF;
    IF v_float <> trunc(v_float) THEN
      RAISE EXCEPTION '% (%): the arena float is not a whole Diamond', mv.label, mv.door;
    END IF;
    RAISE NOTICE 'PASS: % - identity closed, float %, chip total unmoved at %',
      mv.label, v_float, v_after.total;
  END LOOP;

  -- The fee that reached the house reached it once and is still there.
  IF (SELECT balance FROM public.ca_diamond_house WHERE id = 1) <> 5 THEN
    RAISE EXCEPTION 'the house holds % and not the 5 the fee banked',
      (SELECT balance FROM public.ca_diamond_house WHERE id = 1);
  END IF;
  IF (SELECT count(*) FROM public.ca_mint_ledger
       WHERE asset = 'diamonds' AND holder_type = 'house' AND action = 'mint') <> 1 THEN
    RAISE EXCEPTION 'the house fee is registered more than once';
  END IF;
  RAISE NOTICE 'PASS: the fee the house banked is 5, registered once, and the house is still one row (CHECK id = 1)';

  -- And no chip money table learned anything from any of it.
  IF (SELECT count(*) FROM public.chip_supply_snapshots
       WHERE COALESCE(unexplained_delta, 0) <> 0) <> 0 THEN
    RAISE EXCEPTION 'a Diamond format left unexplained chip supply behind it';
  END IF;
  RAISE NOTICE 'PASS: eight Diamond movements across every format and not one of them is anywhere in the chip books';
END $outer$;
""".replace('PDIA_UUID', P_DIA).replace('ARENA_UUID', ARENA).replace('TDIA_UUID', T_DIA)

# ---------------------------------------------------------------------------
# TWO INSTANTS VERSUS ONE SNAPSHOT. Why 20261004124546 merged correct and could
# not apply, and why its successor can.
#
# Its section 0 read the UNFILTERED figures and its section 4 read the FILTERED
# figures afterwards and required equality. Two statements are two snapshots at
# READ COMMITTED, so anything any player did in between answered for the
# Diamond filter. On production it refused itself twice: once on 174066724.55
# -> 174066739.55, and once with every money figure identical to the cent and
# seats 1632 -> 1631 - one player standing up inside 334 ms.
#
# This runs in production's state (no live Diamond seat), where the filtered
# and unfiltered figures are the same number, which is the migration's whole
# claim. The BEFORE half reproduces the refusal deterministically by moving a
# CHIP seat between the two reads; the AFTER half shows the successor's shape -
# both figures as subqueries of one SELECT - holding across the same movement.
# ---------------------------------------------------------------------------
TWO_INSTANTS_VERSUS_ONE_SNAPSHOT = """
DO $$
DECLARE
  v_before numeric; v_after numeric; v_raw numeric; v_filtered numeric;
  v_raw_seats bigint; v_seats bigint; v_seats_before bigint;
BEGIN
  -- 1. THE SHAPE THAT COULD NOT APPLY, on the amount (production attempt 1).
  v_before := COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0);
  UPDATE public.table_seats SET stack = stack + 15.00 WHERE table_id = '__T_CHIP__';
  SELECT on_the_felt INTO v_after FROM public.fn_ca_circulation_total();
  IF v_after = v_before THEN
    RAISE EXCEPTION 'fixture wrong: the chip felt did not move, so this proves nothing';
  END IF;
  RAISE NOTICE 'PASS: reproduced the apply failure - 15.00 of CHIPS moving between a read and a later read reads as "the chip felt total moved: % -> %", which is what refused on production', v_before, v_after;

  -- 2. THE SHAPE THAT APPLIES. One statement, one snapshot: the figure the
  --    substituted STABLE function returns and the unfiltered figure it was
  --    built from, which no concurrent movement can separate.
  SELECT ct.on_the_felt,
         COALESCE((SELECT sum(stack) FROM public.table_seats WHERE left_at IS NULL), 0)::numeric
    INTO v_filtered, v_raw
    FROM public.fn_ca_circulation_total() ct;
  IF v_filtered IS DISTINCT FROM v_raw THEN
    RAISE EXCEPTION 'the one-statement comparison separated the filtered figure from the raw one: % vs %', v_filtered, v_raw;
  END IF;
  RAISE NOTICE 'PASS: and the one-statement comparison holds at the moved figure (% = %), because it asks only whether the Diamond filter changed the number', v_raw, v_filtered;
  UPDATE public.table_seats SET stack = stack - 15.00 WHERE table_id = '__T_CHIP__';

  -- 3. The same thing on the SEAT COUNT, which is what actually refused on
  --    production attempt 2: seats 1632 -> 1631, every money figure identical.
  v_seats_before := (SELECT count(*) FROM public.table_seats ts
                       JOIN public.tables t ON t.id = ts.table_id WHERE ts.left_at IS NULL);
  UPDATE public.table_seats SET left_at = now() WHERE table_id = '__T_CHIP__';
  SELECT (SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
           WHERE ts.left_at IS NULL),
         (SELECT count(*) FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
           WHERE ts.left_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.clubs dc WHERE dc.id = t.club_id AND dc.asset = 'diamonds'))
    INTO v_raw_seats, v_seats;
  IF v_seats_before = v_raw_seats THEN
    RAISE EXCEPTION 'fixture wrong: the seat count did not move, so this proves nothing';
  END IF;
  IF v_seats IS DISTINCT FROM v_raw_seats THEN
    RAISE EXCEPTION 'the one-statement seat comparison separated the filtered count from the raw one: % vs %', v_seats, v_raw_seats;
  END IF;
  RAISE NOTICE 'PASS: a player standing up moves the seat count % -> % and the one-statement comparison still reads % = %, so no seat answers for the Diamond filter', v_seats_before, v_raw_seats, v_raw_seats, v_seats;
  UPDATE public.table_seats SET left_at = NULL WHERE table_id = '__T_CHIP__';

  -- 4. And the fixture is exactly where it was, so the AFTER cases below
  --    measure the same world the baseline was taken from.
  IF (SELECT on_the_felt FROM public.fn_ca_circulation_total()) <> 900.00 THEN
    RAISE EXCEPTION 'the chip felt did not return to 900.00 (it is %)',
      (SELECT on_the_felt FROM public.fn_ca_circulation_total());
  END IF;
  IF (SELECT member_wallets FROM public.fn_ca_circulation_total()) <> 250.00 THEN
    RAISE EXCEPTION 'the chip wallets did not return to 250.00';
  END IF;
  RAISE NOTICE 'PASS: the felt and the wallets are back at 900.00 and 250.00, exactly as the baseline took them';
END $$;
""".replace('__T_CHIP__', T_CHIP)


CLOSES_NOTHING = """
DO $$
BEGIN
  IF (SELECT bool_or(cash_games_enabled OR tournaments_enabled) FROM public.ca_arena_settings) THEN
    RAISE EXCEPTION 'the fixture opened an arena switch';
  END IF;
  RAISE NOTICE 'PASS: both arena switches are still closed, as the fixture found them';
END $$;
"""


def main() -> int:
    manifest = json.loads(MANIFEST.read_text())
    pins = manifest['pins']
    values = ', '.join(f"('{sig}', '{md5}')" for sig, md5 in pins.items())
    pin_sql = PINS.replace('__VALUES__', values).replace('__COUNT__', str(len(pins)))

    tmp = tempfile.mkdtemp(prefix='ca-diamond-xformat-pg17-')
    data = pathlib.Path(tmp) / 'data'
    sock = pathlib.Path(tmp) / 'sock'
    sock.mkdir(parents=True, exist_ok=True)
    passes = 0

    # The file this runner replaced must still say it must never run, and this
    # runner must never be the thing that runs it. A superseding marker that
    # names no version is the easiest lie to tell about a migration that simply
    # never applied, so the marker is read rather than assumed.
    head = SUPERSEDED.read_text()[:400]
    if '-- SUPERSEDED BY 20261004194622' not in head:
        raise SystemExit(
            f'{SUPERSEDED.name} does not carry "-- SUPERSEDED BY 20261004194622" in its head')
    if 'THIS FILE MUST NEVER RUN' not in head:
        raise SystemExit(f'{SUPERSEDED.name} does not say it must never run')
    print('  PASS: the superseded 20261004124546 is marked, named and never applied here')
    passes += 1
    try:
        subprocess.run([bin_path('initdb'), '-D', str(data), '-U', 'postgres',
                        '-A', 'trust', '--no-sync', '--locale=C', '--encoding=UTF8'],
                       check=True, capture_output=True, text=True, env=ENV)
        started = subprocess.run(
            [bin_path('pg_ctl'), '-D', str(data), '-w', '-l', str(pathlib.Path(tmp) / 'pg.log'),
             '-o', f'-k {sock} -c listen_addresses= -c fsync=off', 'start'],
            capture_output=True, text=True, env=ENV)
        if started.returncode:
            print(started.stdout)
            print(started.stderr, file=sys.stderr)
            log = pathlib.Path(tmp) / 'pg.log'
            if log.exists():
                print(log.read_text(), file=sys.stderr)
            raise SystemExit('could not start the isolated PostgreSQL 17 cluster')
        try:
            version = subprocess.run(
                [bin_path('psql'), '-X', '-At', '-h', str(sock), '-U', 'postgres',
                 '-d', 'postgres', '-c', 'SHOW server_version'],
                check=True, capture_output=True, text=True, env=ENV).stdout.strip()
            print(f'Isolated cluster: PostgreSQL {version}')
            if not version.startswith('17'):
                print(f'WARNING: expected PostgreSQL 17, got {version}', file=sys.stderr)

            def psql(sql: str, label: str) -> int:
                nonlocal passes
                r = subprocess.run(
                    [bin_path('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=300, env=ENV)
                if r.returncode:
                    print(r.stdout)
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label} failed')
                n = 0
                for line in r.stderr.splitlines():
                    if 'PASS:' in line:
                        print('  ' + line.split('PASS:', 1)[1].strip())
                        n += 1
                passes += n
                return n

            def psql_file(path: pathlib.Path, label: str) -> int:
                return psql(path.read_text(), label)

            def psql_must_refuse(sql: str, label: str, expect: str) -> None:
                nonlocal passes
                r = subprocess.run(
                    [bin_path('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=300, env=ENV)
                if r.returncode == 0:
                    raise SystemExit(f'{label}: expected a refusal and the statement SUCCEEDED')
                if expect not in r.stderr:
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label}: refused for the wrong reason')
                print(f'  refused by name, which is the success case: {expect}')
                passes += 1

            print('\nThe installed readers, in production\'s own text:')
            psql_file(SCHEMA, 'fixture schema')
            psql_file(DOORS, 'installed readers')
            psql(pin_sql, 'md5 pins')
            psql(GRANT_POSTURE, 'production grant posture')
            psql(SEED, 'fixture seed')
            psql(IDENTITY_IS_WHOLE, 'the fixture closes')

            print('\nBEFORE - the readers as production has them:')
            psql(BEFORE, 'the freeze mark sums a Diamond')
            psql(BEFORE_VERDICT, 'the break verdict')
            psql(BEFORE_SNAPSHOT, 'the chip supply snapshot')
            psql(BEFORE_CLUB_REPORT, 'the club chip circulation report')

            print('\nAPPLYING ' + MIGRATION.name + ' verbatim:')
            psql_must_refuse(MIGRATION.read_text(),
                             'the migration over a live Diamond seat',
                             REFUSES_OVER_A_LIVE_SEAT_MESSAGE)
            psql(STAND_THE_DIAMOND_PLAYER_UP, "production's state")
            psql(CHIP_BASELINE, 'chip baseline')
            psql_file(MIGRATION, 'the migration')
            print('  the migration committed, with its own md5 pins, its'
                  ' nothing-moved assertions and its closing block')

            print('\nTWO INSTANTS VERSUS ONE SNAPSHOT - why 20261004124546 could not apply:')
            psql(TWO_INSTANTS_VERSUS_ONE_SNAPSHOT, 'two instants versus one snapshot')

            psql(SEAT_THE_DIAMOND_PLAYER_AGAIN, 'the Diamond seat again')

            print('\nAFTER - every figure asset-pure, and the Diamond still counted:')
            psql(AFTER, 'the readers afterwards')

            print('\nCROSS-FORMAT - one Diamond through every format the arena deals:')
            psql(FORMATS, 'cross-format conservation')
            psql(CLOSES_NOTHING, 'the fixture closes nothing it opened')

            # One contiguous literal: the wrapper's proof line has to be findable
            # in this source, and tests/unit/diamondAcceptanceCi.test.ts is what
            # fails if it is split across two string pieces.
            print(f'\n{passes} cross-format conservation checks passed on isolated PostgreSQL 17; this is a fixture proof, not a production installation.')
            return 0
        finally:
            subprocess.run([bin_path('pg_ctl'), '-D', str(data), '-w', '-m', 'immediate', 'stop'],
                           capture_output=True, text=True, env=ENV)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
