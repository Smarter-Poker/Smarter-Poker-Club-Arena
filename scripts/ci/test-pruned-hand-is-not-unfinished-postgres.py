#!/usr/bin/env python3
"""A pruned hand is not an unfinished one (migration 20260927145821).

Builds a disposable PostgreSQL cluster, installs the exact production bodies
of public.fn_ca_resume_hand_submission (20260926091630) and
public.sp_prune_hand_history (20260925210126, and main's 20260926151328), each
pinned by md5(prosrc), on the smallest schema those bodies read. Then:

  1. PRE-IMAGE: reproduces the 2026-09-27 refusal. A submission whose commit row
     retention took, below a later commit on the same live table, makes the
     door refuse HAND_SUBMISSION_HANDOFF_STATE_CHANGED on every admission, and
     retention takes a live table's LAST commit too.
  2. Applies supabase/migrations/20260927145821_a_pruned_hand_is_not_an_unfinished_one.sql
     exactly as written (its own pre- and post-image assertions run).
  3. POST-IMAGE: the same admission succeeds with found=false, and every row
     the door must still hold is still selected with its old outcome:
     a genuine unfinished last hand, a 'reserved' permit, and a different
     commit at the coordinate. Retention keeps a live table's last commit and
     still prunes the rest, and still prunes a closed table completely.

The suite fails if the pre-image does NOT show the defect (the regression
test must fail before the fix) or if any post-image expectation does not hold.

Usage: python3 scripts/ci/test-pruned-hand-is-not-unfinished-postgres.py [--pg-bin DIR]
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / "supabase/migrations"
RESUME_SRC = MIG / "20260926091630_a_retained_hand_commits_past_a_seat_taken_after_its_deal.sql"
PRUNE_SOURCES = {
    "20260925210126": (MIG / "20260925210126_a_live_table_keeps_the_boundary_its_movement_reads.sql",
                       "f0334f1595384bb608a6c99af86b568a"),
    "20260926151328": (MIG / "20260926151328_prune_e2e_certification_hand_history_fixtures.sql",
                       "f776fcb97431b343e7cb8f469f51aa42"),
}
F06_BOUNDARY_SRC = MIG / "20260925210126_a_live_table_keeps_the_boundary_its_movement_reads.sql"
FIX = MIG / "20260927145821_a_pruned_hand_is_not_an_unfinished_one.sql"
RESUME_PRE_MD5 = "828edb105fa8d69f089430d7945f5fb9"


def function_statement(path: Path, start: str) -> str:
    """The exact CREATE statement as the migration writes it, through its $function$; terminator."""
    sql = path.read_text()
    i = sql.index(start)
    j = sql.index("$function$", sql.index("AS $function$", i) + len("AS $function$"))
    k = sql.index(";", j) + 1
    return sql[i:k]


def body_md5(statement: str) -> str:
    a = statement.index("$function$") + len("$function$")
    b = statement.rindex("$function$")
    return hashlib.md5(statement[a:b].encode()).hexdigest()


class Cluster:
    def __init__(self, pg_bin: str):
        self.bin = Path(pg_bin)
        self.dir = Path(tempfile.mkdtemp(prefix="pruned-hand-"))
        self.data = self.dir / "data"
        self.port = str(56000 + os.getpid() % 5000)
        run_as = []
        if os.geteuid() == 0:
            # initdb refuses root; hand the scratch dir to the postgres account.
            shutil.chown(self.dir, "postgres")
            os.chmod(self.dir, 0o755)
            run_as = ["runuser", "-u", "postgres", "--"]
        self.run_as = run_as
        try:
            subprocess.run(run_as + [str(self.bin / "initdb"), "-D", str(self.data), "-A", "trust", "-U", "postgres"],
                           check=True, stdout=subprocess.DEVNULL)
            subprocess.run(run_as + [str(self.bin / "pg_ctl"), "-D", str(self.data), "-w", "-l", str(self.dir / "log"),
                                     "-o", f"-p {self.port} -k {self.dir} -c listen_addresses=''", "start"],
                           check=True, stdout=subprocess.DEVNULL)
        except BaseException:
            self.stop()
            raise

    def psql(self, sql: str, expect_ok=True) -> str:
        p = subprocess.run([str(self.bin / "psql"), "-h", str(self.dir), "-p", self.port, "-U", "postgres",
                            "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"],
                           input=sql, text=True, capture_output=True)
        if expect_ok and p.returncode != 0:
            raise RuntimeError(f"psql failed:\n{p.stderr}")
        return p.stdout.strip() if p.returncode == 0 else "ERROR: " + p.stderr.strip()

    def stop(self):
        subprocess.run(self.run_as + [str(self.bin / "pg_ctl"), "-D", str(self.data), "-m", "immediate", "stop"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(self.dir, ignore_errors=True)


# The smallest schema the two production bodies read, with the columns they read.
SCHEMA = r"""
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA smarter_private; CREATE SCHEMA test;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;

CREATE TABLE public.tournaments(id uuid PRIMARY KEY, status text, variant text, tournament_type text);
CREATE TABLE public.tables(id uuid PRIMARY KEY, tournament_id uuid, is_deleted boolean DEFAULT false,
  status text, lifecycle text);
CREATE TABLE public.table_seats(id uuid PRIMARY KEY, table_id uuid, user_id uuid, joined_at timestamptz,
  left_at timestamptz, stack numeric);
CREATE TABLE public.engine_table_leases(table_id uuid PRIMARY KEY, instance_id text, lease_generation uuid,
  protocol_version integer, heartbeat_at timestamptz);
CREATE TABLE public.engine_tournament_leases(tournament_id uuid PRIMARY KEY, instance_id text,
  lease_generation uuid, protocol_version integer, heartbeat_at timestamptz);
CREATE TABLE public.hand_atomic_commits(table_id uuid NOT NULL, hand_number bigint NOT NULL, hand_id uuid UNIQUE,
  payload_hash text, stack_result jsonb DEFAULT '{}'::jsonb, post_commit_payload jsonb, post_commit_payload_hash text,
  post_commit_request_hash text, post_commit_completed_at timestamptz, post_commit_result jsonb,
  committed_at timestamptz DEFAULT now(), PRIMARY KEY(table_id, hand_number));
CREATE TABLE public.hand_history(id uuid PRIMARY KEY, table_id uuid, hand_number bigint, tournament_id uuid,
  has_human boolean, reported boolean, created_at timestamptz, players jsonb);
CREATE TABLE public.hand_history_retention_policy(horse_retention_days integer);
INSERT INTO public.hand_history_retention_policy VALUES (8);
CREATE TABLE public.bbj_payouts(table_id uuid, hand_number bigint);
CREATE TABLE public.hand_projection_outbox(hand_id uuid);
CREATE TABLE public.tournament_knockout_candidates(hand_id uuid, state text);
CREATE TABLE public.tournament_terminal_settlements(tournament_id uuid);
CREATE TABLE public.tournament_cancellation_receipts(tournament_id uuid);
CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_horse boolean);
CREATE TABLE public.ca_hand_player_idx(hand_id uuid);

CREATE TABLE smarter_private.hand_submissions(submission_id uuid PRIMARY KEY, table_id uuid NOT NULL,
  hand_number bigint NOT NULL, instance_id text NOT NULL, lease_generation uuid NOT NULL, request jsonb NOT NULL,
  request_hash text NOT NULL, retained_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(table_id, hand_number));
CREATE TABLE smarter_private.f06_hand_permits(permit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_id uuid,
  hand_number bigint, tournament_id uuid, generation uuid, lifecycle bigint, state text, evidence_id uuid,
  UNIQUE(table_id, hand_number));
CREATE TABLE smarter_private.hand_submission_handoffs(submission_id uuid PRIMARY KEY, original_generation uuid,
  instance_id text, lease_generation uuid, request_hash text, transaction_id bigint);
CREATE TABLE smarter_private.hand_submission_failures(submission_id uuid, request_hash text);
CREATE TABLE smarter_private.hand_submission_dispatch(transaction_id bigint, submission_id uuid, request_hash text,
  instance_id text, lease_generation uuid);
CREATE TABLE smarter_private.hand_submission_handoff_results(submission_id uuid, result jsonb);

CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 60 $$;
CREATE FUNCTION public.fn_ca_share_settlement_lane_for_table(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE FUNCTION smarter_private.f06_prefix(uuid, uuid, uuid[], uuid[]) RETURNS void LANGUAGE sql AS $$ SELECT $$;
-- No scenario here may reach a settlement; reaching one is a test failure.
CREATE FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)
  RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_NO_SETTLEMENT_EXPECTED'; END $$;
CREATE FUNCTION smarter_private.f06_hand_cards_unresolved(p_table uuid, p_hand bigint) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits
    WHERE table_id = p_table AND hand_number = p_hand AND state = 'reserved') $$;

-- Call the door the way PostgREST does and report either its answer or its refusal.
CREATE FUNCTION test.resume(p_table uuid, p_instance text, p_generation uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.fn_ca_resume_hand_submission(p_table, p_instance, p_generation);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('refused', SQLERRM);
END $$;
"""

G = {  # fixed identities
    "horse": "10000000-0000-0000-0000-000000000001",
    "inst": "engine-new",
}


def uid(n: int) -> str:
    return f"00000000-0000-0000-0000-{n:012d}"


def scenario_sql() -> str:
    """Tables T1..T6; see the module docstring. Generations: 9xx are successors (the caller), 8xx originals."""
    s = []
    add = s.append
    add(f"INSERT INTO public.profiles VALUES ('{G['horse']}', true);")
    # T1: the incident. Pruned submission 1000 below an accepted commit 2000 on a live cash table.
    # T2: a genuine unfinished last hand 3000 (no commit, nothing later), the original generation asking.
    # T3: a 'reserved' permit at 4000 with an empty coordinate and a later commit 5000.
    # T4: a DIFFERENT commit at 6000's coordinate, later commit 7000.
    # T5: live cash table, horse-only hands 8000 and 9000 committed ten days ago (retention).
    # T6: closed cash table, horse-only hands 10000 and 11000 committed ten days ago.
    for t, status, life in [(1, "running", "live"), (2, "running", "live"), (3, "running", "live"),
                            (4, "running", "live"), (5, "waiting", "live"), (6, "closed", "closed")]:
        add(f"INSERT INTO public.tables VALUES ('{uid(t)}', NULL, false, '{status}', '{life}');")
        add(f"INSERT INTO public.engine_table_leases VALUES ('{uid(t)}', '{G['inst']}', '{uid(900 + t)}', 2, now());")
        # One live chair whose stack is the table's CURRENT stack, never a pruned hand's stack_before.
        add(f"INSERT INTO public.table_seats VALUES ('{uid(100 + t)}', '{uid(t)}', '{G['horse']}', "
            f"'2026-09-01T00:00:00Z', NULL, 111);")

    def submission(sub, t, hand, gen):
        req = {"p_stacks": [{"seat_id": uid(100 + t), "user_id": G["horse"],
                             "seat_joined_at": "2026-09-01T00:00:00+00:00", "stack_before": 100}],
               "p_hand_row": {"started_at": "2026-09-18T22:00:00+00:00"}}
        add(f"INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,"
            f"lease_generation,request,request_hash,retained_at) VALUES ('{uid(sub)}','{uid(t)}',{hand},'engine-old',"
            f"'{gen}','{json.dumps(req)}','{'a' * 64}', now() - interval '10 days');")

    def commit(t, hand, hand_id, age="1 minute"):
        add(f"INSERT INTO public.hand_atomic_commits(table_id,hand_number,hand_id,payload_hash,post_commit_payload,"
            f"post_commit_completed_at,post_commit_result,committed_at) VALUES ('{uid(t)}',{hand},'{hand_id}',"
            f"'{'b' * 64}','{{}}', now() - interval '{age}', '{{\"ok\": true}}', now() - interval '{age}');")

    def history(t, hand, hand_id, age="10 days"):
        add(f"INSERT INTO public.hand_history VALUES ('{hand_id}','{uid(t)}',{hand},NULL,NULL,false,"
            f"now() - interval '{age}', '[{{\"userId\": \"{G['horse']}\"}}]');")

    submission(1000, 1, 1000, uid(801))                 # pruned: no commit, no history
    submission(2000, 1, 2000, uid(801)); commit(1, 2000, uid(2000))
    submission(3000, 2, 3000, uid(902))                 # original generation == caller's
    submission(4000, 3, 4000, uid(903)); commit(3, 5000, uid(5000))
    add(f"INSERT INTO smarter_private.f06_hand_permits(table_id,hand_number,state) VALUES ('{uid(3)}',4000,'reserved');")
    submission(6000, 4, 6000, uid(804)); commit(4, 6000, uid(6999)); commit(4, 7000, uid(7000))
    for t, hands in [(5, (8000, 9000)), (6, (10000, 11000))]:
        for h in hands:
            submission(h, t, h, uid(800 + t)); commit(t, h, uid(h), "10 days"); history(t, h, uid(h))
    return "\n".join(s)


def resume(c: Cluster, t: int) -> dict:
    return json.loads(c.psql(f"SELECT test.resume('{uid(t)}', '{G['inst']}', '{uid(900 + t)}');"))


def prune_and_read(c: Cluster) -> dict:
    c.psql("SELECT public.sp_prune_hand_history(5000);")
    rows = c.psql("SELECT table_id, hand_number FROM public.hand_atomic_commits "
                  f"WHERE table_id IN ('{uid(5)}','{uid(6)}') ORDER BY 1, 2;")
    return {"commits_left": [r.split("|") for r in rows.splitlines() if r]}


def run(pg_bin: str, prune_key: str) -> list:
    failures = []
    c = Cluster(pg_bin)
    try:
        c.psql(SCHEMA)
        c.psql(function_statement(F06_BOUNDARY_SRC, "CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained"))
        resume_stmt = function_statement(RESUME_SRC, "CREATE OR REPLACE FUNCTION public.fn_ca_resume_hand_submission")
        assert body_md5(resume_stmt) == RESUME_PRE_MD5, "resume pre-image is not the production body"
        c.psql(resume_stmt + "\nREVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;"
               "\nGRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;")
        path, prune_md5 = PRUNE_SOURCES[prune_key]
        prune_stmt = function_statement(path, "CREATE OR REPLACE FUNCTION public.sp_prune_hand_history")
        assert body_md5(prune_stmt) == prune_md5, f"prune pre-image {prune_key} is not the pinned body"
        c.psql(prune_stmt)
        c.psql(scenario_sql())

        # ---- PRE-IMAGE: the defect must reproduce, or this test proves nothing.
        pre = resume(c, 1)
        if pre.get("refused", "").find("HAND_SUBMISSION_HANDOFF_STATE_CHANGED") < 0:
            failures.append(f"[{prune_key}] pre-image did not reproduce the refusal on T1: {pre}")
        # The pre-image prune is observed and rolled back inside one session.
        pre_prune = c.psql("BEGIN; SELECT public.sp_prune_hand_history(5000); "
                           f"SELECT count(*) FROM public.hand_atomic_commits WHERE table_id='{uid(5)}'; ROLLBACK;")
        if pre_prune.splitlines()[-1] != "0":
            failures.append(f"[{prune_key}] pre-image retention did not take the live table's last commit: {pre_prune}")

        # ---- APPLY THE FIX EXACTLY AS WRITTEN.
        c.psql(FIX.read_text())

        # ---- POST-IMAGE.
        got = resume(c, 1)
        if got != {"found": False}:
            failures.append(f"[{prune_key}] T1 pruned-below-a-later-commit still holds admission: {got}")
        got = resume(c, 2)
        if not (got.get("found") is True and got.get("reason") == "original_failure_or_handoff_unproven"):
            failures.append(f"[{prune_key}] T2 genuine unfinished last hand is no longer selected: {got}")
        got = resume(c, 3)
        if not (got.get("found") is True and got.get("reason") == "original_failure_or_handoff_unproven"
                and got.get("submission_id") == uid(4000)):
            failures.append(f"[{prune_key}] T3 reserved permit is no longer selected: {got}")
        got = resume(c, 4)
        if got.get("refused", "").find("HAND_SUBMISSION_ACCEPTANCE_UNPROVEN") < 0:
            failures.append(f"[{prune_key}] T4 identity conflict no longer refuses: {got}")

        left = prune_and_read(c)["commits_left"]
        if left != [[uid(5), "9000"]]:
            failures.append(f"[{prune_key}] retention should keep only the live table's last commit (T5 9000) "
                            f"and prune T5 8000 and all of closed T6; left {left}")
        got = resume(c, 5)
        if got != {"found": False}:
            failures.append(f"[{prune_key}] T5 after retention still holds admission: {got}")
        # Re-applying is refused by its own pre-image check, never silently doubled.
        again = c.psql(FIX.read_text(), expect_ok=False)
        if "PREIMAGE" not in again:
            failures.append(f"[{prune_key}] a second application was not refused by the pre-image: {again[:200]}")
    finally:
        c.stop()
    return failures


def main():
    ap = argparse.ArgumentParser()
    default = next((d for d in ("/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin")
                    if Path(d, "initdb").exists()), "")
    ap.add_argument("--pg-bin", default=default)
    a = ap.parse_args()
    failures = []
    for key in PRUNE_SOURCES:
        failures += run(a.pg_bin, key)
    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("OK  a pruned hand is not an unfinished one: pre-image reproduced, post-image holds for both retention bodies")


if __name__ == "__main__":
    main()
