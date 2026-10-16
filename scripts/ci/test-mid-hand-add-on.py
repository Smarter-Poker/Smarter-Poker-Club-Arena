#!/usr/bin/env python3
"""Native PostgreSQL regression for 20261016183932 (a mid-hand add-on rebase
is movement evidence; a rebuy re-seated while the proven hand was dealt is an
admitted chair).

Builds a throwaway cluster, installs the PRE-image of
smarter_private.f06_movement_prior (from 20261003163015), seeds the boundaries
in scripts/ci/fixtures/mid-hand-add-on/seed.sql, proves the pre-image refuses
both live shapes, applies the migration file VERBATIM (its own pre/post-image
assertions run), then proves the post-image admits them, returns a
byte-identical proof for an ordinary park, and still refuses every
counterfactual. Usage:

  python3 scripts/ci/test-mid-hand-add-on.py --pg-bin /usr/lib/postgresql/17/bin \
    [--evidence artifacts/mid-hand-add-on] [--socket-root "$RUNNER_TEMP"]
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'scripts/ci/fixtures/mid-hand-add-on'
MIG = ROOT / 'supabase/migrations'
PRE_FILE = MIG / '20261003163015_a_busted_chair_taken_by_a_late_entry_is_movement_evidence.sql'
NEW_FILE = MIG / '20261016183932_a_mid_hand_add_on_rebase_is_movement_evidence.sql'
PRE_MD5, PRE_DEF = '862440fc437b25c7c10b96f9ed603283', '458a9e5135824e03d4188e43bc7c9c84'

def u(t):
    import hashlib
    h = hashlib.md5(t.encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"

LOG = []
X = u('X'); A, B, C = u('A'), u('B'), u('C')

class Cluster:
    def __init__(self, pg_bin, root):
        self.bin = Path(pg_bin); self.dir = Path(tempfile.mkdtemp(prefix='midhand-', dir=root))
        os.chmod(self.dir, 0o777)
        self.as_pg = ['su', 'postgres', '-s', '/bin/sh', '-c'] if os.geteuid() == 0 else None
        self._run(f"{self.bin}/initdb -D {self.dir}/data -U postgres -A trust >/dev/null")
        self._run(f"{self.bin}/pg_ctl -D {self.dir}/data -w -o '-k {self.dir} -p 55439 -c listen_addresses=' -l {self.dir}/log start >/dev/null")
    def _run(self, cmd):
        subprocess.run(self.as_pg + [cmd] if self.as_pg else ['sh', '-c', cmd], check=True)
    def psql(self, sql=None, file=None, check=True):
        args = [str(self.bin / 'psql'), '-h', str(self.dir), '-p', '55439', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1']
        args += ['-f', str(file)] if file else ['-c', sql]
        r = subprocess.run(args, capture_output=True, text=True)
        if check and r.returncode != 0:
            raise SystemExit(f'psql failed: {r.stderr.strip()}')
        return r
    def close(self):
        self._run(f"{self.bin}/pg_ctl -D {self.dir}/data -m immediate stop >/dev/null")
        shutil.rmtree(self.dir, ignore_errors=True)

def prior(table):
    return f"smarter_private.f06_movement_prior('{X}','{table}')"

def expect_error(c, name, setup, table, reason):
    sql = (f"BEGIN; {setup}; DO $q$ BEGIN PERFORM {prior(table)}; RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; "
           f"EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'{reason}' THEN RAISE; END IF; END $q$; ROLLBACK;")
    r = c.psql(sql, check=False)
    ok = r.returncode == 0
    print(('PASS' if ok else 'FAIL'), name, '->', reason if ok else r.stderr.strip())
    LOG.append({'case': name, 'expected': reason, 'pass': ok})
    return ok

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--pg-bin', required=True)
    ap.add_argument('--socket-root', default=None); ap.add_argument('--evidence', default=None)
    a = ap.parse_args()
    c = Cluster(a.pg_bin, a.socket_root)
    results = []; names = []
    try:
        c.psql(file=DATA / 'schema.sql')
        pre_sql = PRE_FILE.read_text()
        start = pre_sql.index('CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(')
        end = pre_sql.index('$busted_entry_prior$;', start) + len('$busted_entry_prior$;')
        c.psql(pre_sql[start:end] + "\nREVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;")
        got = c.psql("SELECT md5(prosrc)||' '||md5(pg_get_functiondef(oid))||' '||proacl::text FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure").stdout.strip()
        results.append(got == f'{PRE_MD5} {PRE_DEF} {{postgres=X/postgres}}'); print('PASS' if results[-1] else 'FAIL', 'pre-image installed', got)
        c.psql(file=DATA / 'seed.sql')
        results.append(expect_error(c, 'pre-image refuses the mid-hand add-on', 'SELECT 1', A, 'F06_MOVEMENT_STACK_RECEIPT'))
        results.append(expect_error(c, 'pre-image refuses the rebought chair', 'SELECT 1', B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'))
        plain_pre = c.psql(f"SELECT {prior(C)}::text").stdout.strip()
        c.psql(file=NEW_FILE)
        print('PASS migration applied verbatim (its pre/post-image assertions held)'); results.append(True)
        pa = json.loads(c.psql(f"SELECT {prior(A)}::text").stdout)
        ok = ({r['seat']['user_id']: r['seat']['stack'] for r in pa['roster']} == {u('U1'): 9626, u('U2'): 1150}
              and [x['user_id'] for x in pa['receipts']['rebased']] == [u('U1')]
              and pa['receipts']['rebased'][0]['receipts'][0]['receipt_id'] == u('fU1addon')
              and pa['receipts']['purchases'] == [])
        results.append(ok); print('PASS' if ok else 'FAIL', 'post-image admits the add-on as its rebase receipt and funding receipt')
        pb = json.loads(c.psql(f"SELECT {prior(B)}::text").stdout)
        ent = pb['receipts'].get('entries', [])
        ok = (len(pb['roster']) == 3 and len(ent) == 1 and ent[0]['operation'] == 'rebuy' and ent[0]['user_id'] == u('U3')
              and ent[0]['bust_hand_id'] == u('B:200') and ent[0]['chips'] == 3000)
        results.append(ok); print('PASS' if ok else 'FAIL', 'post-image admits the rebought chair on its rebuy receipt and bust')
        plain_post = c.psql(f"SELECT {prior(C)}::text").stdout.strip()
        results.append(plain_pre == plain_post and 'receipts' not in json.loads(plain_post))
        print('PASS' if results[-1] else 'FAIL', 'an ordinary park proof is byte-identical')
        rb = "UPDATE public.ca_seat_stack_rebases SET "
        fr = f"UPDATE public.tournament_participant_funding_receipts SET "
        A_REC, B_REC = f"WHERE id='{u('fU1addon')}'", f"WHERE id='{u('fU3rebuy')}'"
        cases = [
          ('no rebase receipt', "DELETE FROM public.ca_seat_stack_rebases", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('two rebase receipts', "INSERT INTO public.ca_seat_stack_rebases SELECT 2,settlement_id,table_id,hand_id,hand_number,user_id,engine_before,db_before,engine_after,written,amount,created_at FROM public.ca_seat_stack_rebases", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebase amount differs', rb + "amount=2999", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebase seat-before differs', rb + "db_before=9777", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebase of another hand', rb + "hand_number=100", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebase engine-after differs', rb + "engine_after=6625", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('no funding receipt', f"DELETE FROM public.tournament_participant_funding_receipts {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('receipt after the seal', fr + f"observed_at='2026-10-16 17:03:10+00' {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('receipt before the previous hand', fr + f"observed_at='2026-10-16 17:01:00+00' {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('receipt image is not the running stack', fr + f"registration_snapshot=jsonb_set(registration_snapshot,'{{chips}}','9775') {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('receipt on another table', fr + f"registration_snapshot=jsonb_set(registration_snapshot,'{{table_id}}',to_jsonb('{B}'::text)) {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('receipt is not an add-on', fr + f"operation='rebuy' {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('grant differs from the rebase', fr + f"tournament_snapshot=jsonb_set(tournament_snapshot,'{{addon_chips}}','2000') {A_REC}", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebased player the hand did not deal', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{rebased}}',stack_result->'rebased'||jsonb_build_object('{u('nobody')}',3000)) WHERE table_id='{A}' AND hand_number=101", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('written omits the rebase', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{written,{u('U1')}}}','6626') WHERE table_id='{A}' AND hand_number=101", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebase not a number', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{rebased,{u('U1')}}}','\"3000\"') WHERE table_id='{A}' AND hand_number=101", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('seat lacks the credit', f"UPDATE public.table_seats SET stack=6626 WHERE id='{u('S1')}'", A, 'F06_MOVEMENT_SEAT_CHANGED'),
          ('departed still refused', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{departed}}','[{{}}]') WHERE table_id='{A}' AND hand_number=101", A, 'F06_MOVEMENT_STACK_RECEIPT'),
          ('rebuy for another seat number', fr + f"registration_snapshot=jsonb_set(registration_snapshot,'{{seat_number}}','6') {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('rebuy before the bust was sealed', fr + f"observed_at='2026-10-16 17:02:30+00' {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('rebuy after the chair was taken', fr + f"observed_at='2026-10-16 17:02:43.5+00' {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('rebuy grant differs', fr + f"registration_snapshot=jsonb_set(registration_snapshot,'{{chips}}','2999') {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('rebuy image not playing', fr + f"registration_snapshot=jsonb_set(registration_snapshot,'{{status}}','\"eliminated\"') {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('latest receipt is not the rebuy', f"INSERT INTO public.tournament_participant_funding_receipts SELECT md5('late')::uuid,tournament_id,user_id,registration_id,'reentry','2026-10-16 17:02:43.39+00',NULL,NULL,tournament_snapshot,registration_snapshot FROM public.tournament_participant_funding_receipts {B_REC}", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('bust chair not vacated by the hand', f"UPDATE public.hand_atomic_commits SET stack_result=stack_result-'tournament_zero_stack_seat_generations' WHERE table_id='{B}' AND hand_number=200", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('bust on another chair row', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{request,stacks,0,seat_id}}',to_jsonb('{u('S9')}'::text)) WHERE table_id='{B}' AND hand_number=200", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('not a bust', f"UPDATE public.hand_atomic_commits SET stack_result=jsonb_set(stack_result,'{{written,{u('U3')}}}','10') WHERE table_id='{B}' AND hand_number=200", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('moved after the bust', f"INSERT INTO public.tournament_seat_move_receipts VALUES (md5('mv')::uuid,'{X}','{u('U3')}','{B}','{u('S3')}',5,'{A}',md5('elsewhere')::uuid,9,3000,'2026-10-16 17:02:40+00','live_source')", B, 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'),
          ('chair stack differs from the grant', f"UPDATE public.table_seats SET stack=3001 WHERE id='{u('S3')}'", B, 'F06_MOVEMENT_SEAT_CHANGED'),
        ]
        for name, setup, table, reason in cases:
            results.append(expect_error(c, name, setup, table, reason))
        for role in ('anon', 'authenticated', 'service_role'):
            r = c.psql(f"SET ROLE {role}; SELECT {prior(A)};", check=False)
            ok = r.returncode != 0 and 'permission denied' in r.stderr
            results.append(ok); print('PASS' if ok else 'FAIL', f'{role} cannot call it')
    finally:
        c.close()
    print(f'{sum(results)}/{len(results)} passed')
    if a.evidence:
        out = Path(a.evidence); out.mkdir(parents=True, exist_ok=True)
        (out / 'mid-hand-add-on-report.json').write_text(json.dumps(
            {'passed': sum(results), 'total': len(results), 'refusals': LOG}, indent=2) + '\n')
    sys.exit(0 if all(results) else 1)

if __name__ == '__main__':
    main()
