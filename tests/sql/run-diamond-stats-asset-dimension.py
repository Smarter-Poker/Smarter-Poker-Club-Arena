#!/usr/bin/env python3
"""Prove, on an isolated PostgreSQL 17, that a chip hand and a Diamond hand never sum.

Never connects to production. This starts its own cluster in a temporary
directory, builds the two fact tables in the shape production has them TODAY
(no asset column), reproduces projection 4's ungated write, and shows the
defect: one chip hand and one Diamond hand add up into a single profit that no
reader can take apart again.

It then applies the asset dimension and the labelled write from
_needs_apply/20260920T000000_a_diamond_hand_keeps_its_own_statistics.sql and
shows the same two hands staying separate under a scoped read.

The point of the fixture is the BEFORE as much as the AFTER: a regression that
only ever passes proves nothing about the bug it claims to fix.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
PG_BIN = os.environ.get(
    'PG_BIN',
    '/opt/homebrew/opt/postgresql@17/bin' if sys.platform == 'darwin' else '/usr/lib/postgresql/17/bin',
)


# macOS: the postmaster refuses to start under a locale it has to resolve
# through the system framework ("postmaster became multithreaded during
# startup"). A plain C locale is also what makes the fixture's text comparisons
# deterministic wherever it runs.
ENV = {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'}


def bin_path(name: str) -> str:
    candidate = pathlib.Path(PG_BIN) / name
    if candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    if not found:
        raise SystemExit(f'PostgreSQL 17 tool not found: {name} (set PG_BIN)')
    return found


SETUP = """
-- The two fact tables as production has them today: no club, no asset.
CREATE TABLE ca_hand_player_stat (
  user_id uuid NOT NULL,
  hand_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  tournament_id uuid,
  is_cash boolean,
  profit numeric NOT NULL DEFAULT 0,
  won_amt numeric NOT NULL DEFAULT 0,
  rake_paid numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hand_id)
);
CREATE TABLE ca_hand_player_idx (
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  hand_id uuid NOT NULL,
  PRIMARY KEY (user_id, hand_id)
);

CREATE TABLE clubs (id uuid PRIMARY KEY, asset text NOT NULL);
CREATE TABLE tables_ (id uuid PRIMARY KEY, club_id uuid NOT NULL REFERENCES clubs(id));
CREATE TABLE hands (id uuid PRIMARY KEY, table_id uuid NOT NULL REFERENCES tables_(id),
                    created_at timestamptz NOT NULL);
CREATE TABLE hand_players (hand_id uuid NOT NULL, user_id uuid NOT NULL,
                           profit numeric NOT NULL, won_amt numeric NOT NULL,
                           rake_paid numeric NOT NULL);

-- Projection 4 exactly as it runs today: v_diamond is computed and then NOT
-- used, which is the whole defect.
CREATE FUNCTION project_v4_today(p_hand uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_diamond boolean; v_created timestamptz;
BEGIN
  SELECT c.asset='diamonds', h.created_at INTO v_diamond, v_created
    FROM hands h JOIN tables_ t ON t.id=h.table_id JOIN clubs c ON c.id=t.club_id
   WHERE h.id=p_hand;

  INSERT INTO ca_hand_player_idx(user_id,created_at,hand_id)
  SELECT hp.user_id, v_created, p_hand FROM hand_players hp WHERE hp.hand_id=p_hand
  ON CONFLICT DO NOTHING;

  INSERT INTO ca_hand_player_stat AS hs (
    user_id, hand_id, created_at, is_cash, profit, won_amt, rake_paid)
  SELECT hp.user_id, p_hand, v_created, true, hp.profit, hp.won_amt, hp.rake_paid
    FROM hand_players hp WHERE hp.hand_id=p_hand
  ON CONFLICT DO NOTHING;
END $$;

-- The reader, as it is today: p_user and nothing else.
CREATE FUNCTION read_overview_today(p_user uuid)
RETURNS TABLE(hands bigint, profit numeric, won_amt numeric, rake_paid numeric)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint, coalesce(sum(hs.profit),0), coalesce(sum(hs.won_amt),0),
         coalesce(sum(hs.rake_paid),0)
    FROM ca_hand_player_stat hs WHERE hs.user_id=p_user;
$$;

-- One player, one chip club, one Diamond arena, one hand in each.
INSERT INTO clubs VALUES
  ('00000000-0000-0000-0000-0000000000c1','chips'),
  ('002c2d27-9584-4e52-835a-bb2be148fc81','diamonds');
INSERT INTO tables_ VALUES
  ('00000000-0000-0000-0000-000000000a01','00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000000000a02','002c2d27-9584-4e52-835a-bb2be148fc81');
"""

SEED = """
INSERT INTO hands VALUES
  ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-000000000a01', now()),
  ('00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-000000000a02', now());
INSERT INTO hand_players VALUES
  ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000000e', 250.00, 900.00, 12.50),
  ('00000000-0000-0000-0000-00000000b002','00000000-0000-0000-0000-00000000000e',   7.00,  40.00,  1.00);
SELECT project_v4_today('00000000-0000-0000-0000-00000000b001');
SELECT project_v4_today('00000000-0000-0000-0000-00000000b002');
"""

# The defect, stated as an assertion that PASSES today.
PROVE_DEFECT = """
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM read_overview_today('00000000-0000-0000-0000-00000000000e');
  IF r.hands <> 2 THEN
    RAISE EXCEPTION 'fixture wrong: expected both hands projected, got %', r.hands;
  END IF;
  -- 250 chips + 7 diamonds = 257 of nothing at all.
  IF r.profit <> 257.00 THEN
    RAISE EXCEPTION 'expected the defect (257.00), got %', r.profit;
  END IF;
  IF r.won_amt <> 940.00 OR r.rake_paid <> 13.50 THEN
    RAISE EXCEPTION 'expected won 940.00 / rake 13.50, got % / %', r.won_amt, r.rake_paid;
  END IF;
  RAISE NOTICE 'PASS: reproduced - 250 chips and 7 diamonds summed to 257.00 in one figure';
  -- And nothing can take it apart: the table holds no column that distinguishes them.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='ca_hand_player_stat' AND column_name IN ('asset','club_id')) THEN
    RAISE EXCEPTION 'fixture wrong: the table already carries a dimension';
  END IF;
  RAISE NOTICE 'PASS: and the rows carry no asset or club column to separate them afterwards';
END $$;
"""

# The migration's two structural halves, as the file applies them.
APPLY = """
ALTER TABLE ca_hand_player_stat ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips';
ALTER TABLE ca_hand_player_idx  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'chips';
ALTER TABLE ca_hand_player_stat
  ADD CONSTRAINT ca_hand_player_stat_asset_ck CHECK (asset IN ('chips','diamonds'));
ALTER TABLE ca_hand_player_idx
  ADD CONSTRAINT ca_hand_player_idx_asset_ck CHECK (asset IN ('chips','diamonds'));
CREATE INDEX ca_hand_player_stat_user_asset_created_idx
  ON ca_hand_player_stat (user_id, asset, created_at DESC);

-- Projection 4, now stamping the asset it already computed.
CREATE OR REPLACE FUNCTION project_v4_today(p_hand uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_diamond boolean; v_created timestamptz;
BEGIN
  SELECT c.asset='diamonds', h.created_at INTO v_diamond, v_created
    FROM hands h JOIN tables_ t ON t.id=h.table_id JOIN clubs c ON c.id=t.club_id
   WHERE h.id=p_hand;

  INSERT INTO ca_hand_player_idx(user_id,created_at,hand_id,asset)
  SELECT hp.user_id, v_created, p_hand,
         CASE WHEN COALESCE(v_diamond,false) THEN 'diamonds' ELSE 'chips' END
    FROM hand_players hp WHERE hp.hand_id=p_hand
  ON CONFLICT DO NOTHING;

  INSERT INTO ca_hand_player_stat AS hs (
    asset, user_id, hand_id, created_at, is_cash, profit, won_amt, rake_paid)
  SELECT CASE WHEN COALESCE(v_diamond,false) THEN 'diamonds' ELSE 'chips' END,
         hp.user_id, p_hand, v_created, true, hp.profit, hp.won_amt, hp.rake_paid
    FROM hand_players hp WHERE hp.hand_id=p_hand
  ON CONFLICT DO NOTHING;
END $$;

-- The reader, now scoped. DEFAULT 'chips' keeps every existing caller exact.
--
-- THE OLD SIGNATURE MUST BE DROPPED FIRST, and this fixture is how we learned
-- it. CREATE OR REPLACE with an extra defaulted parameter does not replace the
-- function, it ADDS AN OVERLOAD - and every existing one-argument call then
-- fails with "function read_overview_today(unknown) is not unique". That would
-- have taken every stats panel in the app down the moment the migration
-- committed, with the client half still passing one argument.
DROP FUNCTION IF EXISTS read_overview_today(uuid);
CREATE OR REPLACE FUNCTION read_overview_today(p_user uuid, p_asset text DEFAULT 'chips')
RETURNS TABLE(hands bigint, profit numeric, won_amt numeric, rake_paid numeric)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint, coalesce(sum(hs.profit),0), coalesce(sum(hs.won_amt),0),
         coalesce(sum(hs.rake_paid),0)
    FROM ca_hand_player_stat hs WHERE hs.user_id=p_user AND hs.asset=p_asset;
$$;

-- Re-project both hands so they carry their label.
TRUNCATE ca_hand_player_stat; TRUNCATE ca_hand_player_idx;
SELECT project_v4_today('00000000-0000-0000-0000-00000000b001');
SELECT project_v4_today('00000000-0000-0000-0000-00000000b002');
"""

PROVE_FIXED = """
DO $$
DECLARE chips record; diamonds record; n int;
BEGIN
  SELECT * INTO chips    FROM read_overview_today('00000000-0000-0000-0000-00000000000e','chips');
  SELECT * INTO diamonds FROM read_overview_today('00000000-0000-0000-0000-00000000000e','diamonds');

  IF chips.hands <> 1 OR chips.profit <> 250.00
     OR chips.won_amt <> 900.00 OR chips.rake_paid <> 12.50 THEN
    RAISE EXCEPTION 'chip scope wrong: % hands, profit %, won %, rake %',
      chips.hands, chips.profit, chips.won_amt, chips.rake_paid;
  END IF;
  IF diamonds.hands <> 1 OR diamonds.profit <> 7.00
     OR diamonds.won_amt <> 40.00 OR diamonds.rake_paid <> 1.00 THEN
    RAISE EXCEPTION 'diamond scope wrong: % hands, profit %, won %, rake %',
      diamonds.hands, diamonds.profit, diamonds.won_amt, diamonds.rake_paid;
  END IF;
  RAISE NOTICE 'PASS: chips read 250.00 / 900.00 / 12.50 and diamonds read 7.00 / 40.00 / 1.00';

  IF chips.profit + diamonds.profit = 257.00 AND chips.profit <> 257.00
     AND diamonds.profit <> 257.00 THEN
    RAISE NOTICE 'PASS: the two figures exist side by side and neither is the sum';
  ELSE
    RAISE EXCEPTION 'the figures still sum somewhere';
  END IF;

  -- The Diamond hand is KEPT, not discarded: a Diamond player has statistics.
  SELECT count(*) INTO n FROM ca_hand_player_stat WHERE asset='diamonds';
  IF n <> 1 THEN RAISE EXCEPTION 'the Diamond hand was dropped rather than labelled'; END IF;
  RAISE NOTICE 'PASS: the Diamond hand is kept and labelled, not thrown away';

  -- An unscoped caller still gets exactly what it got yesterday.
  SELECT * INTO chips FROM read_overview_today('00000000-0000-0000-0000-00000000000e');
  IF chips.profit <> 250.00 THEN
    RAISE EXCEPTION 'the default scope changed an existing caller''s answer: %', chips.profit;
  END IF;
  RAISE NOTICE 'PASS: an existing unscoped caller still reads the chip figure, unchanged';

  -- And the label is closed: nothing else can be written.
  BEGIN
    INSERT INTO ca_hand_player_stat(asset,user_id,hand_id,created_at,profit,won_amt,rake_paid)
    VALUES ('tokens','00000000-0000-0000-0000-00000000000e',
            '00000000-0000-0000-0000-00000000b003', now(), 1, 1, 0);
    RAISE EXCEPTION 'the asset check constraint did not hold';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: an unknown asset is refused by the check constraint';
  END;
END $$;
"""


def main() -> int:
    tmp = tempfile.mkdtemp(prefix='ca-diamond-stats-pg17-')
    data = pathlib.Path(tmp) / 'data'
    sock = pathlib.Path(tmp) / 'sock'
    sock.mkdir(parents=True, exist_ok=True)
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

            def psql(sql: str, label: str) -> None:
                r = subprocess.run(
                    [bin_path('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1',
                     '-h', str(sock), '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                    input=sql, text=True, capture_output=True, timeout=120, env=ENV)
                if r.returncode:
                    print(r.stdout)
                    print(r.stderr, file=sys.stderr)
                    raise SystemExit(f'{label} failed')
                for line in r.stderr.splitlines():
                    if 'PASS:' in line:
                        print('  ' + line.split('PASS:', 1)[1].strip())

            print('\nBEFORE — production shape, projection 4 ungated:')
            psql(SETUP + SEED, 'fixture setup')
            psql(PROVE_DEFECT, 'defect reproduction')

            print('\nAFTER — asset dimension and the labelled write applied:')
            psql(APPLY, 'migration')
            psql(PROVE_FIXED, 'scoped read proof')

            print('\nDiamond stats asset dimension certified on isolated PostgreSQL 17.')
            print('This is a fixture proof, not a production installation.')
            return 0
        finally:
            subprocess.run([bin_path('pg_ctl'), '-D', str(data), '-w', '-m', 'immediate', 'stop'],
                           capture_output=True, text=True, env=ENV)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    raise SystemExit(main())
