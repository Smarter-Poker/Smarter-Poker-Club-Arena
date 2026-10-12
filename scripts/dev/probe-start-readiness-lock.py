#!/usr/bin/env python3
"""A tournament start's bank lock, on disposable socket-only PostgreSQL 17.

Loads the captured production pre-image of fn_guard_tournament_start_readiness
and fn_ca_fund_overlay_on_lock (scripts/dev/fixtures/start-readiness-lock/
preimage.sql), reproduces the club-wide drain their FOR UPDATE caused, applies
migration 20260929071925 twice, and proves:

  * a start no longer waits for an open transaction that inserted a row
    referencing the club (a foreign-key check holds FOR KEY SHARE), and such
    an insert no longer waits for an open start;
  * a start still waits for a competing start of the same bank, for a
    treasury write, and for a competing start on the same union bank;
  * an overlay start still debits the bank exactly once, beside an open
    foreign-key holder.

Readiness, payout terms, alerts and authentication are fixture boundaries.
No production connection string or credential is read.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
# The postmaster refuses to start under an unset or invalid locale on macOS.
os.environ["LC_ALL"] = os.environ.get("LC_ALL") or "C"
pg = Path(os.environ.get("PGBIN", "/opt/homebrew/opt/postgresql@17/bin"))
assert " 17." in subprocess.check_output([str(pg / "postgres"), "--version"], text=True)
preimage = (repo / "scripts/dev/fixtures/start-readiness-lock/preimage.sql").read_text()
migration = (repo / "supabase/migrations/"
             "20260929071925_a_tournament_start_locks_the_bank_without_blocking_foreign_k.sql").read_text()

CLUB = "11111111-1111-4111-8111-111111111111"
UNION = "22222222-2222-4222-8222-222222222222"
UCLUB = "33333333-3333-4333-8333-333333333333"
T1, T2, T3, T4, T5 = ("aaaaaaaa-0000-4000-8000-00000000000%d" % i for i in range(1, 6))

bootstrap = """
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY, union_id uuid, guarantee_enforcement_enabled boolean DEFAULT true,
  chip_treasury numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE public.union_wallets(union_id uuid PRIMARY KEY, chip_balance numeric DEFAULT 0, updated_at timestamptz);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY, club_id uuid REFERENCES public.clubs(id), union_id uuid,
  is_private boolean DEFAULT false, status text, name text, variant text, tournament_type text,
  prize_pool numeric DEFAULT 0, guaranteed_prize numeric DEFAULT 0, satellite_seats integer DEFAULT 0,
  satellite_target_id uuid, satellite_target uuid, payout_percent numeric, payout_structure text,
  prize_pool_finalized boolean, buy_in_amount numeric, buy_in_fee numeric);
CREATE TABLE public.tournament_players(tournament_id uuid, user_id uuid);
CREATE TABLE public.agent_commissions(id bigserial PRIMARY KEY, club_id uuid REFERENCES public.clubs(id));
CREATE TABLE public.chip_ledger(id bigserial PRIMARY KEY, performed_by uuid, from_type text, from_entity_id uuid,
  to_type text, to_entity_id uuid, amount numeric, category text, club_id uuid, tournament_id uuid, description text);
CREATE FUNCTION public.fn_tournament_management_readiness_for_row(jsonb) RETURNS jsonb LANGUAGE sql
  AS $$SELECT '{"can_start": true}'::jsonb$$;
CREATE FUNCTION public.fn_tournament_payout_terms_committed_v1(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE FUNCTION public.fn_raise_server_financial_alert(text, text, text, jsonb, text) RETURNS void LANGUAGE sql AS $$SELECT$$;
""" + preimage + """
REVOKE ALL ON FUNCTION public.fn_guard_tournament_start_readiness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_guard_tournament_start_readiness() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO service_role;
CREATE TRIGGER trg_tournaments_start_readiness BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_start_readiness();
CREATE TRIGGER zz_ca_fund_overlay_on_lock BEFORE UPDATE OF status ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fund_overlay_on_lock();
"""

with tempfile.TemporaryDirectory(prefix="ca-start-lock-pg17-") as directory:
    root = Path(directory)
    cluster, sock = root / "cluster", root / "socket"
    sock.mkdir()
    port = str(36000 + os.getpid() % 10000)
    share = Path(subprocess.check_output([str(pg / "pg_config"), "--sharedir"], text=True).strip())
    if not (share / "postgres.bki").exists():
        share = pg.parent / "share/postgresql"
    cmd = [str(pg / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", str(sock),
           "-p", port, "-U", "postgres", "-d", "postgres"]

    def sql(query, check=True):
        return subprocess.run(cmd, input=query, text=True, capture_output=True, check=check, timeout=20)

    def value(query):
        return json.loads(sql(query).stdout.strip())

    def seed():
        sql(f"""TRUNCATE public.tournaments, public.agent_commissions, public.chip_ledger, public.tournament_players;
        DELETE FROM public.clubs; DELETE FROM public.union_wallets;
        INSERT INTO public.clubs(id, chip_treasury) VALUES ('{CLUB}', 1000), ('{UCLUB}', 0);
        UPDATE public.clubs SET union_id = '{UNION}' WHERE id = '{UCLUB}';
        INSERT INTO public.union_wallets(union_id, chip_balance) VALUES ('{UNION}', 500);
        INSERT INTO public.tournaments(id, club_id, union_id, status, name) VALUES
          ('{T1}', '{CLUB}', NULL, 'REGISTERING', 't1'), ('{T2}', '{CLUB}', NULL, 'REGISTERING', 't2'),
          ('{T3}', '{UCLUB}', '{UNION}', 'REGISTERING', 't3'), ('{T4}', '{UCLUB}', '{UNION}', 'REGISTERING', 't4');
        INSERT INTO public.tournaments(id, club_id, status, name, prize_pool, guaranteed_prize) VALUES
          ('{T5}', '{CLUB}', 'REGISTERING', 't5', 40, 100);""")

    START = "UPDATE public.tournaments SET status = 'RUNNING' WHERE id = '%s';"
    FK_INSERT = f"INSERT INTO public.agent_commissions(club_id) VALUES ('{CLUB}');"
    TREASURY = f"UPDATE public.clubs SET chip_treasury = chip_treasury + 1 WHERE id = '{CLUB}';"

    def waits(holder_sql, contender_sql):
        """True when contender_sql cannot finish while holder_sql's transaction is open."""
        seed()
        holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        try:
            holder.stdin.write(f"BEGIN;\n{holder_sql}\n\\echo HOLDER_READY\n")
            holder.stdin.flush()
            while True:
                line = holder.stdout.readline()
                assert line, "holder exited before it held its locks: " + holder.stderr.read()
                if "HOLDER_READY" in line:
                    break
            contender = sql("BEGIN; SET LOCAL lock_timeout = '1500ms';\n" + contender_sql + "\nCOMMIT;",
                            check=False)
            if contender.returncode == 0:
                return False
            assert "lock timeout" in contender.stderr, contender.stderr
            return True
        finally:
            holder.stdin.write("ROLLBACK;\n\\q\n")
            holder.stdin.flush()
            holder.wait(timeout=10)

    def expect(image, fk_blocks_start, start_blocks_fk):
        assert waits(FK_INSERT, START % T1) is fk_blocks_start, image + ": start behind an open FK insert"
        assert waits(START % T1, FK_INSERT) is start_blocks_fk, image + ": FK insert behind an open start"
        assert waits(START % T1, START % T2) is True, image + ": two starts of one club bank must serialize"
        assert waits(START % T1, TREASURY) is True, image + ": a treasury write must wait for a start"
        assert waits(TREASURY, START % T1) is True, image + ": a start must wait for a treasury write"
        assert waits(START % T3, START % T4) is True, image + ": two starts of one union bank must serialize"

    started = False
    try:
        subprocess.run([str(pg / "initdb"), "-L", str(share), "-D", str(cluster), "-U", "postgres",
                        "--auth=trust", "--no-locale", "-E", "UTF8"], check=True, capture_output=True, timeout=60)
        boot = subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-l", str(root / "postgres.log"),
                               "-o", f"-h '' -k {sock} -p {port}", "-w", "start"], capture_output=True, timeout=60)
        if boot.returncode != 0:
            log = root / "postgres.log"
            raise RuntimeError("PostgreSQL did not start: " + boot.stderr.decode()
                               + (log.read_text() if log.exists() else ""))
        started = True
        sql(bootstrap)
        assert value("SELECT to_json(md5(pg_get_functiondef('public.fn_guard_tournament_start_readiness()'::regprocedure)))") \
            == "f2ee43657b769c37527ae2974101bb06", "fixture is not the production pre-image"
        assert value("SELECT to_json(md5(pg_get_functiondef('public.fn_ca_fund_overlay_on_lock()'::regprocedure)))") \
            == "93f3e46a957abb7a42d4a2cfaff42fcb", "fixture is not the production pre-image"
        expect("pre-image", fk_blocks_start=True, start_blocks_fk=True)
        print("PASS: pre-image reproduces the drain: a start waits for an open foreign-key insert "
              "and the insert waits for the start", flush=True)

        sql(migration)
        sql(migration)
        print("PASS: migration applies over the pre-image and replays over its own post-image", flush=True)
        expect("post-image", fk_blocks_start=False, start_blocks_fk=False)
        print("PASS: post-image: neither waits; start/start, start/treasury and union start/start still serialize",
              flush=True)

        seed()
        holder = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        holder.stdin.write(f"BEGIN;\n{FK_INSERT}\n\\echo HOLDER_READY\n")
        holder.stdin.flush()
        while "HOLDER_READY" not in holder.stdout.readline():
            pass
        sql("BEGIN; SET LOCAL lock_timeout = '1500ms';\n" + START % T5 + "\nCOMMIT;")
        holder.stdin.write("COMMIT;\n\\q\n")
        holder.stdin.flush()
        holder.wait(timeout=10)
        got = value(f"""SELECT json_build_array(
            (SELECT chip_treasury FROM public.clubs WHERE id = '{CLUB}'),
            (SELECT prize_pool FROM public.tournaments WHERE id = '{T5}'),
            (SELECT count(*) FROM public.chip_ledger WHERE tournament_id = '{T5}' AND category = 'overlay'),
            (SELECT sum(amount) FROM public.chip_ledger WHERE tournament_id = '{T5}'))""")
        assert got == [940, 100, 1, 60], got
        print("PASS: an overlay start beside an open foreign-key holder debits the bank once (1000 -> 940, pool 100)",
              flush=True)

        bad = sql(migration.replace("f2ee43657b769c37527ae2974101bb06", "0" * 32)
                  .replace("82a9626b0fd5a6f93ed297b397ded144", "1" * 32), check=False)
        assert bad.returncode != 0 and "preimage mismatch" in bad.stderr, bad.stderr
        print("PASS: the migration refuses an unreviewed pre-image", flush=True)
    finally:
        if started:
            subprocess.run([str(pg / "pg_ctl"), "-D", str(cluster), "-m", "immediate", "-w", "stop"],
                           capture_output=True, timeout=60)
