#!/usr/bin/env python3
"""The seven-day equity coverage is measured once an hour.

Migration 20261004003115_the_seven_day_equity_coverage_is_measured_once_an_hour
substitutes two fragments in ca_stats_witness_audit so that section 2f (the
seven-day all-in equity coverage) is measured only on the run in the first
quarter of the hour, or when no earlier reading exists, and is otherwise
carried forward from the latest log row. The live body is not in this
repository as a CREATE, so this harness runs the SHIPPED migration (pins
rewritten to the stand-in's) against a stand-in carrying the exact 2f
statement and the log write, and proves on a disposable cluster:

  APPLY    the two fragments are each found once and replaced;
  FIRST    with no earlier row, 2f is measured whatever the minute;
  CARRY    outside the first quarter of the hour the last pair is carried
           forward unchanged, even when the facts have moved;
  MEASURE  inside the first quarter it is measured, and equals what the
           pre-image measures on the same data.
The minute is steered with the session time zone, which extract(minute) obeys.
"""
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
OUT = (ROOT / 'artifacts/witness-audit-2f-hourly').resolve()
OUT.mkdir(parents=True, exist_ok=True)


def find_pg_bin():
    if os.environ.get('PG_BIN'):
        return Path(os.environ['PG_BIN'])
    for cand in sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True):
        if (cand / 'postgres').exists():
            return cand
    return Path('/opt/homebrew/opt/postgresql@17/bin')


PG = find_pg_bin()
AS_PG = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
ENV['LC_ALL'] = 'C'

found = sorted((ROOT / 'supabase/migrations').glob('*_the_seven_day_equity_coverage_is_measured_once_an_hour.sql'))
if len(found) != 1:
    raise RuntimeError(f'expected exactly one shipped migration, found {len(found)}')
SHIPPED = found[0].read_text()

STAND_IN = r"""
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.hand_history (id uuid PRIMARY KEY, actions jsonb);
CREATE TABLE public.ca_hand_facts (hand_id uuid, all_in_equity numeric, was_all_in boolean, went_to_showdown boolean,
  all_in_street text, played_at timestamptz);
CREATE TABLE public.ca_stats_witness_audit_log (id bigserial PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now(),
  allin_showdown_7d integer, allin_showdown_without_equity_7d integer);
CREATE OR REPLACE FUNCTION public.ca_stats_witness_audit(p_minutes integer DEFAULT 10, p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_allin_sd integer;
  v_allin_sd_no_eq integer;
BEGIN
  SELECT count(*) FILTER (WHERE x.has_eq OR NOT coalesce(x.betting_continued, true))::int,
         count(*) FILTER (WHERE NOT x.has_eq AND NOT coalesce(x.betting_continued, true))::int
    INTO v_allin_sd, v_allin_sd_no_eq
  FROM (
    SELECT f.all_in_equity IS NOT NULL AS has_eq,
           CASE WHEN f.all_in_equity IS NULL THEN
             (SELECT bool_or(a.act->>'action' IN ('check', 'bet', 'raise') AND a.ord > la.last_allin)
                FROM public.hand_history h
                CROSS JOIN LATERAL (
                  SELECT max(b.ord) AS last_allin
                  FROM jsonb_array_elements(h.actions) WITH ORDINALITY b(act, ord)
                  WHERE b.act->>'action' IN ('all_in', 'allin')
                ) la
                CROSS JOIN LATERAL jsonb_array_elements(h.actions) WITH ORDINALITY a(act, ord)
               WHERE h.id = f.hand_id)
           END AS betting_continued
      FROM public.ca_hand_facts f
     WHERE f.was_all_in = true
       AND f.went_to_showdown
       AND coalesce(f.all_in_street, '') <> 'river'
       AND f.played_at >= now() - interval '7 days'
    OFFSET 0
  ) x;

  INSERT INTO public.ca_stats_witness_audit_log (allin_showdown_7d, allin_showdown_without_equity_7d)
  VALUES (v_allin_sd, v_allin_sd_no_eq);
  RETURN jsonb_build_object('allin_showdown_7d', v_allin_sd, 'without_equity', v_allin_sd_no_eq);
END;
$function$;
REVOKE ALL ON FUNCTION public.ca_stats_witness_audit(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ca_stats_witness_audit(integer, integer) TO service_role;
"""


class Cluster:
    def __init__(self, name, port):
        self.dir = Path(tempfile.mkdtemp(prefix=f'witness-2f-{name}-', dir='/tmp'))
        self.sock = self.dir / 'socket'
        self.sock.mkdir(mode=0o700)
        if AS_PG:
            shutil.chown(self.dir, 'postgres')
            shutil.chown(self.sock, 'postgres')
        self.port = str(port)
        subprocess.run(AS_PG + [str(PG / 'initdb'), '-D', str(self.dir / 'data'), '-U', 'postgres', '-A', 'trust'],
                       env=ENV, check=True, capture_output=True)
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-l', str(self.dir / 'log'), '-w',
                        '-o', f"-k {self.sock} -p {self.port} -c listen_addresses='' -c fsync=off",
                        'start'], env=ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def psql(self, sql, check=True):
        r = subprocess.run([str(PG / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(self.sock),
                            '-p', self.port, '-U', 'postgres', '-d', 'postgres'],
                           input=sql, text=True, capture_output=True, env=ENV, timeout=120)
        if check and r.returncode != 0:
            raise RuntimeError(r.stderr)
        return r

    def stop(self):
        subprocess.run(AS_PG + [str(PG / 'pg_ctl'), '-D', str(self.dir / 'data'), '-m', 'immediate', 'stop'],
                       env=ENV, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def tz_for(inside_first_quarter):
    """A fixed-offset time zone that puts this minute inside or outside :00-:14."""
    m = datetime.datetime.now(datetime.timezone.utc).minute
    target = 7 if inside_first_quarter else 37
    offset = (target - m) % 60
    if datetime.datetime.now(datetime.timezone.utc).second > 50:
        offset = (offset - 1) % 60
    return f"SET TIME ZONE INTERVAL '+00:{offset:02d}' HOUR TO MINUTE; "


def add_facts(c, n, with_equity):
    c.psql(f"""
      INSERT INTO public.hand_history
      SELECT g, jsonb_build_array(jsonb_build_object('action','all_in'), jsonb_build_object('action','call'))
        FROM (SELECT gen_random_uuid() g FROM generate_series(1, {n})) s;
      INSERT INTO public.ca_hand_facts
      SELECT h.id, {'0.5' if with_equity else 'NULL'}, true, true, 'flop', now() - interval '1 hour'
        FROM public.hand_history h WHERE NOT EXISTS (SELECT 1 FROM public.ca_hand_facts f WHERE f.hand_id = h.id);""")


def last(c):
    return c.psql("SELECT allin_showdown_7d || '/' || allin_showdown_without_equity_7d FROM public.ca_stats_witness_audit_log ORDER BY ran_at DESC, id DESC LIMIT 1;").stdout.strip()


results = {'scope': 'the seven-day equity coverage is measured once an hour', 'cases': [], 'passed': False}


def case(name, ok, **kw):
    results['cases'].append({'case': name, **kw, 'ok': bool(ok)})


old = new = None
try:
    old = Cluster('old', 55861)
    new = Cluster('new', 55862)
    for c in (old, new):
        c.psql(STAND_IN)
    pre = new.psql("SELECT md5(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure));").stdout.strip()
    frags = {k: re.search(rf"  {k} := ((?:E'(?:[^'\\]|\\.)*'\s*(?:\|\|\s*)?)+);", SHIPPED).group(1) for k in ('v_old1', 'v_new1', 'v_old2', 'v_new2')}
    post = new.psql("SELECT md5(replace(replace(pg_get_functiondef('public.ca_stats_witness_audit(integer,integer)'::regprocedure), "
                    f"{frags['v_old1']}, {frags['v_new1']}), {frags['v_old2']}, {frags['v_new2']}));").stdout.strip()
    shipped = SHIPPED.replace('0260f227fb49030f22a7e2019a755796', pre).replace('962ed3ca1dd6346e25d7a1c6edd7246e', post)
    r = new.psql(shipped, check=False)
    case('APPLY the shipped substitution', r.returncode == 0, stderr=r.stderr.strip()[-300:])

    add_facts(new, 30, True)
    add_facts(new, 5, False)
    new.psql(tz_for(False) + 'SELECT public.ca_stats_witness_audit(10, 90);')
    case('FIRST with no earlier reading 2f is measured outside the first quarter', last(new) == '35/5', reading=last(new))

    add_facts(new, 10, True)
    new.psql(tz_for(False) + 'SELECT public.ca_stats_witness_audit(10, 90);')
    case('CARRY outside the first quarter the last pair is carried unchanged', last(new) == '35/5', reading=last(new))

    new.psql(tz_for(True) + 'SELECT public.ca_stats_witness_audit(10, 90);')
    add_facts(old, 40, True)
    add_facts(old, 5, False)
    old.psql('SELECT public.ca_stats_witness_audit(10, 90);')
    case('MEASURE inside the first quarter it is measured, as the pre-image measures it',
         last(new) == '45/5' and last(old) == '45/5', new=last(new), old=last(old))

    results['passed'] = all(x['ok'] for x in results['cases'])
finally:
    for c in (old, new):
        if c:
            c.stop()
    (OUT / 'result.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))

if not results['passed']:
    raise SystemExit(1)
