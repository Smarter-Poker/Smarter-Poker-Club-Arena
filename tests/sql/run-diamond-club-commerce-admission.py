#!/usr/bin/env python3
"""Diamond commerce admission, wired in shadow: isolated PostgreSQL qualification.

Assignment CA-DIAMOND-COMMERCE-2026-09-22 (R2), sections 2.3, 4.3, 6.3 and
D21 / D22 / D28 / D52 / D53. Builds the same private, socket-only cluster as
tests/sql/run-diamond-club-commerce.py (reused through importlib, unmodified),
installs the two commerce migrations production has, loads the four admission
doors captured verbatim from production
(tests/fixtures/diamond-club-commerce-admission/), then:

  RED    every scenario runs on a copy WITHOUT
         20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql and
         must FAIL there (each check is proved to need its fix);
  GREEN  every scenario runs on a copy WITH it and must pass;
  SAFETY the migration itself refuses a double apply, an enforcement already
         switched on, and a moved anchor, and preserves an unrelated
         concurrent change to a door body;
  REGRESSION the original 155-scenario commerce harness passes with this
         migration applied on top.

Every action goes through the real door as PostgREST presents a caller
(request.jwt.claims plus the JWT role). Nothing here connects to production.

Run:  PG_BIN=/usr/lib/postgresql/16/bin python3 tests/sql/run-diamond-club-commerce-admission.py
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('diamond_club_commerce_base', ROOT / 'tests/sql/run-diamond-club-commerce.py')
base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(base)

# The server binaries: PG_BIN and nothing else from the environment chooses
# anything about the server (same rule as the base harness).
PG_BIN = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin')
if 'PG_BIN' not in os.environ and not Path(PG_BIN, 'initdb').exists():
    _found = sorted(Path('/usr/lib/postgresql').glob('*/bin/initdb'), key=lambda p: int(p.parts[-3]) if p.parts[-3].isdigit() else 0)
    if _found:
        PG_BIN = str(_found[-1].parent)
# A cluster of its own, in a directory it creates and destroys, on a socket
# there and a port of its own, so this runner and the base harness can run side
# by side. base.start_cluster starts it socket-only (listen_addresses= empty).
shutil.rmtree(base.work, ignore_errors=True)
base.work = Path(tempfile.mkdtemp(prefix='diamond-club-commerce-admission.'))
base.sock = base.work / 'socket'
base.sock.mkdir()
base.data = base.work / 'data'
base.PG_BIN = PG_BIN
base.PORT = '55613'
base.PSQL = [PG_BIN + '/psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', str(base.sock), '-p', base.PORT, '-U', 'postgres']

MIGRATION = ROOT / 'supabase/migrations/20260924102056_diamond_commerce_admission_is_wired_in_shadow.sql'
FIXTURE = ROOT / 'tests/fixtures/diamond-club-commerce-admission'
TEMPLATE = base.DB
RED, GREEN = 'admission_red', 'admission_green'

LIVE_MD5 = {  # production, 2026-09-24, pg_get_functiondef
    'public.fn_review_join_request(uuid,uuid,boolean)': '0ad8e6df115201015d969e0db78e3ff5',
    'public.fn_cash_game_create(uuid,text,text,numeric,numeric,integer,jsonb,text,boolean)': 'fec049e3a50544b66d88dab7ff535ae2',
    'public.fn_create_tournament(uuid,jsonb)': '4c5c8783d1f6f534fdaf5cefbb460d62',
    'public.fn_upsert_tournament_schedule(jsonb)': 'b8dd7cc8e0996889a936affdc732b664',
    'public.fn_ca_commerce_admission(text,uuid,text)': '9fc091db66ee2265502e042420ddd84e',
}

passed = 0
results = []


class CheckFailed(AssertionError):
    pass


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
def psql(db, q, ok=True):
    r = base.run(base.PSQL + ['-d', db, '-At', '-c', q])
    if ok and r.returncode:
        raise CheckFailed(f'{q[:300]}\n{r.stderr}')
    return r


def sid(user):
    """A deterministic live session id per synthetic user."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'session:' + user))


def as_caller(user=None, role='authenticated'):
    """Present identity exactly as PostgREST does: claims object plus JWT role."""
    if role == 'postgres':
        return ''
    claims = {'role': role}
    if user:
        claims['sub'] = user
        claims['session_id'] = sid(user)
    c = json.dumps(claims)
    p = f"SELECT set_config('request.jwt.claims','{c}',false); SELECT set_config('request.jwt.claim.role','{role}',false);"
    if user:
        p += f"SELECT set_config('request.jwt.claim.sub','{user}',false);"
    return p + f' SET ROLE {role};'


def q1(db, q, user=None, role='authenticated', ok=True):
    """One statement; returns the last output line (or the result object when ok=False)."""
    r = psql(db, as_caller(user, role) + q, ok=ok)
    if not ok:
        return r
    out = r.stdout.strip()
    return out.splitlines()[-1] if out else ''


def system(db, q):
    """An engine/system writer: service_role claims, no signed-in person."""
    claims = json.dumps({'role': 'service_role'})
    return psql(db, f"SELECT set_config('request.jwt.claims','{claims}',false); SELECT set_config('request.jwt.claim.role','service_role',false); " + q)


def rpc(db, fn, args, user, role='authenticated'):
    return json.loads(q1(db, f'SELECT public.{fn}({args})', user, role))


def scalar(db, q):
    return q1(db, q, role='postgres')


def text(db, q):
    """The whole output of one query (for multi-line function definitions)."""
    return psql(db, q).stdout.rstrip('\n')


def count(db, q):
    return int(scalar(db, f'SELECT count(*) FROM {q}'))


def ck(cond, label, detail=''):
    if not cond:
        raise CheckFailed(f'{label} :: {str(detail)[:600]}')


def u(tag):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'admission:' + tag))


# ---------------------------------------------------------------------------
# Synthetic tenants
# ---------------------------------------------------------------------------
def person(db, tag, diamonds=0, horse=False):
    uid = u('user:' + tag)
    psql(db, f"""
      INSERT INTO auth.users(id) VALUES ('{uid}');
      INSERT INTO public.profiles(id,username,diamonds,diamond_balance,role,is_horse) VALUES ('{uid}','adm_{tag[:20]}',{diamonds},{diamonds},'user',{str(horse).lower()});
      INSERT INTO auth.sessions(id,user_id,not_after) VALUES ('{sid(uid)}','{uid}',now() + interval '1 day');""")
    return uid


def club(db, tag, owner, requires_approval=True):
    cid = u('club:' + tag)
    psql(db, f"""
      INSERT INTO public.clubs(id,name,owner_id,union_id,chip_treasury,promo_balance,is_union,requires_approval)
      VALUES ('{cid}','Admission {tag}','{owner}',NULL,0,0,false,{str(requires_approval).lower()});
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{cid}','{owner}','owner','active',0);""")
    return cid


def pending(db, cid, tag):
    uid = person(db, tag)
    psql(db, f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{cid}','{uid}','player','pending',0)")
    return uid


def fill(db, cid, tag, n):
    """n approved human members, written by the system (existing obligations)."""
    psql(db, f"""
      WITH g AS (SELECT gen_random_uuid() AS id FROM generate_series(1,{n})),
           a AS (INSERT INTO auth.users(id) SELECT id FROM g RETURNING id),
           p AS (INSERT INTO public.profiles(id,username) SELECT id, 'adm_fill_' || replace(id::text,'-','') FROM a RETURNING id)
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) SELECT '{cid}', id, 'player', 'active', 0 FROM p;""")


def status_of(db, cid, uid):
    return scalar(db, f"SELECT status FROM public.club_members WHERE club_id='{cid}' AND user_id='{uid}'")


def buy(db, owner, cid, sku, key):
    lines = json.dumps([{'sku': sku, 'quantity': 1}])
    qt = rpc(db, 'fn_ca_commerce_quote', f"'club','{cid}','{lines}'::jsonb,NULL,NULL,'purchase'", owner)
    ck(qt.get('success'), f'quote {sku}', qt)
    rc = rpc(db, 'fn_ca_commerce_purchase', f"'{qt['quote_id']}','{key}','purchase'", owner)
    ck(rc.get('success'), f'purchase {sku}', rc)
    return rc


def approve(db, owner, cid, uid, yes=True):
    return rpc(db, 'fn_review_join_request', f"'{cid}','{uid}',{str(yes).lower()}", owner)


def cash(db, owner, cid, name, insurance=False, ok=True):
    ov = json.dumps({'options': {'insurance_enabled': True}} if insurance else {})
    return q1(db, f"SELECT public.fn_cash_game_create('{cid}','classic','nlh',1,2,NULL,'{ov}'::jsonb,'{name}',true)", owner, ok=ok)


def tournament(db, owner, cid, name):
    cfg = json.dumps({'type': 'mtt', 'name': name})
    return rpc(db, 'fn_create_tournament', f"'{cid}','{cfg}'::jsonb", owner)


def schedule(db, owner, cid, name, sched_id=None, active=True):
    s = {'clubId': cid, 'name': name, 'daysOfWeek': [1, 3], 'startTimesUtc': ['20:00'], 'config': {'type': 'mtt'}, 'active': active}
    if sched_id:
        s['id'] = sched_id
    return rpc(db, 'fn_upsert_tournament_schedule', f"'{json.dumps(s)}'::jsonb", owner)


def decisions(db, cid, where='true'):
    return json.loads(scalar(db, f"""SELECT COALESCE(jsonb_agg(jsonb_build_object('action',action,'door',door,'would_allow',would_allow,'enforced',enforced,
      'allowed',allowed,'reason',reason,'actor',actor_id,'subject',subject_id) ORDER BY id),'[]') FROM public.ca_commerce_admission_decisions
      WHERE scope_kind='club' AND scope_id='{cid}' AND {where}"""))


def enforce(db, on):
    staff = base.S
    r = rpc(db, 'fn_ca_commerce_settings_set', "NULL,NULL,now() - interval '1 minute',false" if on else "NULL,NULL,NULL,true", staff)
    ck(r.get('success') and (bool(r.get('admission_enforced_from')) == on), 'staff records the admission enforcement event', r)


MSG_TABLE = 'This Club Needs Active Operating Access To Open A New Table. Running Tables Are Not Affected.'
MSG_MEMBER = 'This Club Needs Active Operating Access To Approve New Members. Current Members Are Not Affected.'
MSG_CAPACITY = 'This Club Has Reached Its Member Capacity. Upgrade Capacity To Approve New Members. Current Members Are Not Affected.'
MSG_TOURNAMENT = 'This Club Needs Active Operating Access To Create A New Tournament. Scheduled And Running Tournaments Are Not Affected.'
MSG_INSURANCE = 'This Club Needs The Insurance Module To Offer Insurance On A New Table. Existing Insurance Offers Are Not Affected.'


# ---------------------------------------------------------------------------
# Scenarios. Each takes a database and a tag (so RED and GREEN never share
# ids), raises CheckFailed on the first unmet expectation, and is expected to
# FAIL on RED.
# ---------------------------------------------------------------------------
def s_shadow_records_and_allows(db, t):
    o = person(db, t + 'o1', 5000)
    k = club(db, t + 'k1', o)
    q = pending(db, k, t + 'q1')
    r = approve(db, o, k, q)
    ck(r.get('success') and status_of(db, k, q) == 'active', 'shadow: the approval proceeds', r)
    ck(cash(db, o, k, 'Shadow Main'), 'shadow: a new table opens')
    ck(cash(db, o, k, 'Shadow Insured', insurance=True), 'shadow: a new insured table opens')
    ck(count(db, f"public.tables WHERE club_id='{k}'") == 2 and count(db, f"public.tables WHERE club_id='{k}' AND insurance_enabled") == 1, 'shadow: both tables exist')
    r = tournament(db, o, k, 'Shadow Event')
    ck(r.get('success') and count(db, f"public.tournaments WHERE club_id='{k}'") == 1, 'shadow: the tournament is created', r)
    r = schedule(db, o, k, 'Shadow Weekly')
    ck(r.get('ok') and count(db, f"public.tournament_schedules WHERE club_id='{k}'") == 1, 'shadow: the schedule is created', r)
    d = decisions(db, k)
    got = [(x['action'], x['door']) for x in d]
    ck(got == [('approve_member', 'fn_review_join_request'), ('open_table', 'fn_cash_game_create'), ('open_table', 'fn_cash_game_create'),
               ('club_insurance', 'fn_cash_game_create'), ('create_tournament', 'fn_create_tournament'), ('create_tournament', 'fn_upsert_tournament_schedule')],
       'shadow: one durable decision per prospective action, in order', d)
    ck(all(x['allowed'] and x['would_allow'] is False and x['enforced'] is False and x['reason'] == 'no_effective_entitlement' and x['actor'] == o for x in d),
       'shadow: every decision says would-deny, not enforced, allowed, and names the owner', d)
    ck(d[0]['subject'] == q and all(x['subject'] is None for x in d[1:]), 'shadow: the approval names the applicant id, nothing else personal', d)
    return 'shadow records a would-deny for approve/table/insurance/tournament/schedule and every action proceeds'


def s_enforced_refuses_without_side_effect(db, t):
    o = person(db, t + 'o2', 5000)
    k = club(db, t + 'k2', o)
    q = pending(db, k, t + 'q2')
    r = approve(db, o, k, q)
    ck(r.get('success') is False and r.get('error') == MSG_MEMBER and r.get('code') == 'operating_access_required', 'enforced: approval refused in Title Case', r)
    ck(status_of(db, k, q) == 'pending', 'enforced: the applicant is still pending (no side effect)')
    r = cash(db, o, k, 'Refused Main', ok=False)
    ck(r.returncode != 0 and MSG_TABLE in r.stderr, 'enforced: a new table is refused with the sentence', r.stderr[-300:])
    ck(count(db, f"public.tables WHERE club_id='{k}'") == 0, 'enforced: no table row was written')
    r = tournament(db, o, k, 'Refused Event')
    ck(r.get('success') is False and r.get('error') == 'operating_access_required' and r.get('message') == MSG_TOURNAMENT, 'enforced: a new tournament is refused', r)
    ck(count(db, f"public.tournaments WHERE club_id='{k}'") == 0, 'enforced: no tournament row was written')
    r = schedule(db, o, k, 'Refused Weekly')
    ck(r.get('error') == 'operating_access_required' and r.get('message') == MSG_TOURNAMENT, 'enforced: a new schedule is refused', r)
    ck(count(db, f"public.tournament_schedules WHERE club_id='{k}'") == 0, 'enforced: no schedule row was written')
    d = decisions(db, k)
    ck([(x['action'], x['allowed'], x['enforced']) for x in d] == [('approve_member', False, True), ('create_tournament', False, True), ('create_tournament', False, True)],
       'enforced: JSON-door refusals are recorded; the raising cash door rolls its own decision back with the refusal', d)
    return 'enforced: approve/table/tournament/schedule refused with a Title Case sentence and no side effect'


def s_effective_right_allowed(db, t):
    o = person(db, t + 'o3', 5000)
    k = club(db, t + 'k3', o)
    buy(db, o, k, 'capacity_60', t + 'cap-k3-0001')
    q = pending(db, k, t + 'q3')
    r = approve(db, o, k, q)
    ck(r.get('success') and status_of(db, k, q) == 'active', 'entitled: approval within capacity proceeds', r)
    ck(cash(db, o, k, 'Entitled Main'), 'entitled: a new table opens')
    r = tournament(db, o, k, 'Entitled Event')
    ck(r.get('success'), 'entitled: a tournament is created', r)
    r = schedule(db, o, k, 'Entitled Weekly')
    ck(r.get('ok'), 'entitled: a schedule is created', r)
    r = cash(db, o, k, 'Insured Without Module', insurance=True, ok=False)
    ck(r.returncode != 0 and MSG_INSURANCE in r.stderr and count(db, f"public.tables WHERE club_id='{k}' AND insurance_enabled") == 0,
       'entitled: capacity alone does not offer insurance on a new table (section 6.3)', r.stderr[-300:])
    buy(db, o, k, 'club_insurance_module', t + 'ins-k3-0001')
    ck(cash(db, o, k, 'Insured With Module', insurance=True) and count(db, f"public.tables WHERE club_id='{k}' AND insurance_enabled") == 1,
       'entitled: the insurance module admits an insured table')
    d = decisions(db, k)
    ck(all(x['allowed'] for x in d if not (x['action'] == 'club_insurance' and x['would_allow'] is False))
       and [x['reason'] for x in d if x['action'] == 'approve_member'] == ['within_capacity']
       and {x['reason'] for x in d if x['action'] in ('open_table', 'create_tournament')} == {'entitled'},
       'entitled: decisions name within_capacity and entitled', d)
    o2 = person(db, t + 'o3b', 0)
    k2 = club(db, t + 'k3b', o2)
    tr = rpc(db, 'fn_ca_commerce_activate_trial', f"'club','{k2}'", o2)
    ck(tr.get('success'), 'trial activation', tr)
    q2 = pending(db, k2, t + 'q3b')
    r = approve(db, o2, k2, q2)
    ck(r.get('success') and decisions(db, k2)[0]['reason'] == 'trial', 'trial: the included month admits new operation', r)
    return 'a purchased right (and a trial) admits; insurance needs its own module'


def s_existing_obligations_untouched(db, t):
    o = person(db, t + 'o4', 5000)
    k = club(db, t + 'k4', o)
    fill(db, k, t + 'fill4', 5)
    existing = person(db, t + 'e4')
    system(db, f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{k}','{existing}','player','active',0)")
    tid = scalar(db, f"INSERT INTO public.tables(club_id,name,status) VALUES ('{k}','Running Main','playing') RETURNING id")
    system(db, f"INSERT INTO public.table_seats(table_id,user_id,seat_number,stack) VALUES ('{tid}','{existing}',1,100)")
    tour = scalar(db, f"INSERT INTO public.tournaments(club_id,name,status,buy_in_amount,buy_in_fee,start_time,max_players) VALUES ('{k}','Running Event','running',0,0,now(),9) RETURNING id")
    sch = scalar(db, f"INSERT INTO public.tournament_schedules(club_id,name,active,days_of_week,start_times_utc,config) VALUES ('{k}','Old Weekly',false,'{{1}}','{{20:00}}','{{\"type\":\"mtt\"}}') RETURNING id")
    before = count(db, f"public.club_members WHERE club_id='{k}' AND status='active'")
    q = pending(db, k, t + 'q4')
    r = approve(db, o, k, q)
    ck(r.get('success') is False and r.get('error') == MSG_MEMBER, 'existing: a NEW approval at this scope is refused (enforcement is live here)', r)
    r = approve(db, o, k, existing)
    ck(r.get('success') is False and r.get('error') == 'No pending request found', 'existing: an already-approved member is not re-admitted or re-checked', r)
    r = schedule(db, o, k, 'Old Weekly Renamed', sched_id=sch, active=True)
    ck(r.get('ok') and scalar(db, f"SELECT active::text || name FROM public.tournament_schedules WHERE id='{sch}'") == 'trueOld Weekly Renamed',
       'existing: an existing schedule is edited and re-activated without admission', r)
    denier = pending(db, k, t + 'd4')
    r = approve(db, o, k, denier, yes=False)
    ck(r.get('success') and status_of(db, k, denier) == '', 'existing: denying a request is never gated', r)
    ck(count(db, f"public.club_members WHERE club_id='{k}' AND status='active'") == before, 'existing: every approved member is still active')
    ck(scalar(db, f"SELECT status FROM public.tables WHERE id='{tid}'") == 'playing' and count(db, f"public.table_seats WHERE table_id='{tid}'") == 1,
       'existing: the running table and its seated player are untouched')
    ck(scalar(db, f"SELECT status FROM public.tournaments WHERE id='{tour}'") == 'running', 'existing: the running tournament is untouched')
    d = decisions(db, k)
    ck([x['action'] for x in d] == ['approve_member'], 'existing: only the one new admission was decided; edits, denials and re-approvals were not', d)
    return 'existing members, running tables/tournaments/seats and existing schedules are untouched; only new admission is refused'


def s_horse_counts(db, t):
    o = person(db, t + 'o5', 5000)
    k = club(db, t + 'k5', o)
    buy(db, o, k, 'capacity_60', t + 'cap-k5-0001')
    fill(db, k, t + 'fill5', 58)  # owner + 58 = 59 of 60
    horse = person(db, t + 'h5', horse=True)
    system(db, f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{k}','{horse}','player','active',0)")
    ck(status_of(db, k, horse) == 'active', 'horse: the system join lands (horse plumbing is not an owner action)')
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{k}','approve_member'", o)
    ck(adm.get('roster_count') == 60 and adm.get('capacity') == 60, 'horse: the roster counts the horse exactly like a human', adm)
    q = pending(db, k, t + 'q5')
    r = approve(db, o, k, q)
    ck(r.get('success') is False and r.get('error') == MSG_CAPACITY and status_of(db, k, q) == 'pending',
       'horse: the next owner approval meets a full roster because the horse counts', r)
    ck(status_of(db, k, horse) == 'active', 'horse: the horse keeps its seat in the roster')
    d = decisions(db, k)
    ck([(x['action'], x['reason']) for x in d] == [('approve_member', 'capacity_reached')], 'horse: the horse join made no decision; the approval did', d)
    return 'a horse joining counts in the roster like a human and is never gated itself'


def s_system_paths_not_gated(db, t):
    o = person(db, t + 'o6', 5000)
    k = club(db, t + 'k6', o)
    r = cash(db, o, k, 'Owner Main', ok=False)
    ck(r.returncode != 0 and MSG_TABLE in r.stderr, 'system: the owner door refuses at this scope', r.stderr[-200:])
    horse = person(db, t + 'h6', horse=True)
    player = person(db, t + 'p6')
    system(db, f"""
      INSERT INTO public.tables(club_id,name,status) VALUES ('{k}','Auto Feeder 2','waiting');
      INSERT INTO public.tables(club_id,name,status) VALUES ('{k}','Balanced Table 3','playing');
      INSERT INTO public.tournaments(club_id,name,status,buy_in_amount,buy_in_fee,start_time,max_players) VALUES ('{k}','Spawned Weekly','registering',0,0,now() + interval '1 hour',9);
      INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{k}','{horse}','player','active',0);
      INSERT INTO public.table_seats(table_id,user_id,seat_number,stack) SELECT id,'{horse}',1,100 FROM public.tables WHERE club_id='{k}' AND name='Auto Feeder 2';
      INSERT INTO public.tournament_players(tournament_id,user_id) SELECT id,'{player}' FROM public.tournaments WHERE club_id='{k}';""")
    ck(count(db, f"public.tables WHERE club_id='{k}'") == 2 and count(db, f"public.tournaments WHERE club_id='{k}'") == 1
       and count(db, f"public.table_seats s JOIN public.tables x ON x.id=s.table_id WHERE x.club_id='{k}'") == 1,
       'system: auto-spawn, balancing, the scheduled spawner, seating and registration all land under enforcement')
    ck(decisions(db, k) == [], 'system: no engine path made a decision (and the refused cash door rolled its own back)', decisions(db, k))
    r = rpc(db, 'fn_create_tournament', f"'{k}','{{\"type\":\"mtt\"}}'::jsonb", None, role='service_role')
    ck(r.get('error') == 'not_authenticated', 'system: the owner doors are browser doors; the engine cannot and does not use them', r)
    callers = json.loads(scalar(db, """SELECT COALESCE(jsonb_agg(p.proname ORDER BY p.proname),'[]') FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.prosrc LIKE '%fn_ca_commerce_admit(%'"""))
    ck(callers == ['fn_cash_game_create', 'fn_create_tournament', 'fn_review_join_request', 'fn_upsert_tournament_schedule'],
       'system: exactly the four owner doors call the admission gate', callers)
    ck(count(db, """pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc f ON f.oid=t.tgfoid
      WHERE c.relname IN ('tables','table_seats','tournaments','tournament_players','club_members')
        AND NOT t.tgisinternal AND (t.tgname LIKE '%commerce%' OR f.prosrc LIKE '%ca_commerce%')""") == 0,
       'D21 / D28 no commerce trigger (by name or by body) sits in the gameplay or seating path')
    return 'engine/system writers (tables, spawns, seats, registrations, horse joins) are never gated; only four doors call the gate'


def s_last_seat_race(db, t):
    o = person(db, t + 'o7', 5000)
    k = club(db, t + 'k7', o)
    buy(db, o, k, 'capacity_60', t + 'cap-k7-0001')
    fill(db, k, t + 'fill7', 58)  # 59 of 60: one seat left
    q1_ = pending(db, k, t + 'q7a')
    q2_ = pending(db, k, t + 'q7b')
    outs = {}

    def slow(uid, key):
        # Hold the approving transaction open for a second after the door.
        r = psql(db, as_caller(o) + f"BEGIN; SELECT public.fn_review_join_request('{k}','{uid}',true); SELECT pg_sleep(1.2); COMMIT;", ok=False)
        outs[key] = r.stdout

    def fast(uid, key):
        time.sleep(0.4)
        outs[key] = psql(db, as_caller(o) + f"SELECT public.fn_review_join_request('{k}','{uid}',true)", ok=False).stdout

    ths = [threading.Thread(target=slow, args=(q1_, 'a')), threading.Thread(target=fast, args=(q2_, 'b'))]
    [x.start() for x in ths]
    [x.join() for x in ths]
    active = count(db, f"public.club_members WHERE club_id='{k}' AND status='active'")
    ck(active == 60 and status_of(db, k, q1_) == 'active' and status_of(db, k, q2_) == 'pending' and MSG_CAPACITY in outs.get('b', ''),
       'race: two approvals for the last seat, one lands and the other meets a full roster (scope lock)', {'active': active, 'outs': outs})
    return 'two concurrent approvals for the last seat: exactly one lands'


def s_browser_read_is_tightened(db, t):
    A, B, D, X, S, C1, C3 = base.A, base.B, base.D, base.X, base.S, base.C1, base.C3
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{C1}','open_table'", X)
    ck(adm == {'error': 'access_denied'}, 'tightened: another club\'s owner cannot ask about this club', adm)
    outsider = person(db, t + 'n8')
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{C1}','approve_member'", outsider)
    ck(adm == {'error': 'access_denied'}, 'tightened: a signed-in stranger cannot ask', adm)
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{C1}','approve_member'", base.P)
    ck(adm == {'error': 'access_denied'}, 'tightened: a plain member of the club cannot ask', adm)
    adm = rpc(db, 'fn_ca_commerce_admission', f"'union','{base.U}','union_tools'", X)
    ck(adm == {'error': 'access_denied'}, 'tightened: a stranger cannot ask about a union', adm)
    admin = person(db, t + 'y8')
    psql(db, f"INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance) VALUES ('{C1}','{admin}','admin','active',0)")
    for who, scope, label in ((A, f"'club','{C1}'", 'the owner'), (admin, f"'club','{C1}'", 'a club admin'),
                              (D, f"'club','{C3}'", 'the member club owner'), (B, f"'club','{C3}'", 'the union owner of a covered club'),
                              (B, f"'union','{base.U}'", 'the union owner'), (S, f"'club','{C1}'", 'platform staff')):
        adm = rpc(db, 'fn_ca_commerce_admission', f"{scope},'open_table'", who)
        ck('reason' in adm and 'error' not in adm, f'tightened: {label} may ask', adm)
    adm = rpc(db, 'fn_ca_commerce_admission', f"'club','{C1}','open_table'", None, role='service_role')
    ck('reason' in adm, 'tightened: service role is unrestricted', adm)
    r = q1(db, f"SELECT public.fn_ca_commerce_admission('club','{C1}','open_table')", role='anon', ok=False)
    ck(r.returncode != 0 and 'permission denied' in r.stderr, 'tightened: anon cannot execute the read', r.stderr[-200:])
    for fn in (f"fn_ca_commerce_admit('club','{C1}','open_table','x',NULL)", f"fn_ca_commerce_admission_decide('club','{C1}','open_table')"):
        r = q1(db, f'SELECT public.{fn}', A, ok=False)
        ck(r.returncode != 0 and 'permission denied' in r.stderr, f'tightened: a browser cannot call {fn.split("(")[0]} directly', r.stderr[-200:])
    r = q1(db, 'SELECT count(*) FROM public.ca_commerce_admission_decisions', A, ok=False)
    ck(r.returncode != 0 and 'permission denied' in r.stderr, 'tightened: decisions are not browser-readable', r.stderr[-200:])
    return 'the browser read answers only owners/administrators; the gate, decision and log are internal'


SCENARIOS = [  # (name, needs enforcement on)
    (s_shadow_records_and_allows, False),
    (s_enforced_refuses_without_side_effect, True),
    (s_effective_right_allowed, True),
    (s_existing_obligations_untouched, True),
    (s_horse_counts, True),
    (s_system_paths_not_gated, True),
    (s_last_seat_race, True),
    (s_browser_read_is_tightened, True),
]


def record(label, ok, detail=''):
    global passed
    results.append({'test': label, 'result': 'PASS' if ok else 'FAIL', **({'detail': str(detail)[:600]} if detail else {})})
    if ok:
        passed += 1
        print('PASS', label, flush=True)
    else:
        print('FAIL', label, detail, flush=True)
        raise CheckFailed(f'{label} {detail}')


def run_scenarios(db, expect_fail):
    tag = 'r' if expect_fail else 'g'
    enforced = False
    for fn, needs in SCENARIOS:
        if needs != enforced:
            enforce(db, needs)
            enforced = needs
        name = fn.__name__[2:].replace('_', ' ')
        try:
            summary = fn(db, tag)
            err = None
        except CheckFailed as e:
            summary, err = None, str(e)
        if expect_fail:
            record(f'RED   {name}: fails without the migration', err is not None, '' if err else 'passed without its fix')
            if err:
                print('      ', err.split('\n')[0][:160], flush=True)
        else:
            record(f'GREEN {summary or name}', err is None, err or '')


# ---------------------------------------------------------------------------
# The migration's own safety
# ---------------------------------------------------------------------------
def md5_of(db, sig):
    return scalar(db, f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))")


def migration_safety():
    def copy(name):
        psql('postgres', f'CREATE DATABASE {name} TEMPLATE {TEMPLATE}')
        return name

    def apply(db):
        return base.run(base.PSQL + ['-d', db, '-f', str(MIGRATION)])

    db = copy('admission_twice')
    ck(apply(db).returncode == 0, 'safety: first apply')
    r = apply(db)
    record('SAFETY a second apply refuses at its baseline pin and changes nothing', r.returncode != 0 and 'fn_ca_commerce_admission changed since 20260922143541' in r.stderr, r.stderr[-200:])

    db = copy('admission_preenforced')
    psql(db, "UPDATE public.ca_commerce_settings SET admission_enforced_from = now() WHERE id = 1")
    r = apply(db)
    record('SAFETY wiring refuses when enforcement is already on (shadow first)',
           r.returncode != 0 and 'admission_enforced_from is already set' in r.stderr
           and md5_of(db, 'public.fn_review_join_request(uuid,uuid,boolean)') == LIVE_MD5['public.fn_review_join_request(uuid,uuid,boolean)'], r.stderr[-200:])

    db = copy('admission_anchor_moved')
    psql(db, """DO $d$ DECLARE v text; BEGIN
      v := pg_get_functiondef('public.fn_create_tournament(uuid,jsonb)'::regprocedure);
      EXECUTE replace(v, 'v_res := public.fn_create_tournament_governed_legacy(p_club_id,p_config);', 'v_res := public.fn_create_tournament_governed_legacy(p_club_id, p_config);');
    END $d$;""")
    moved = md5_of(db, 'public.fn_create_tournament(uuid,jsonb)')
    r = apply(db)
    record('SAFETY a moved anchor stops the migration and rolls every door back',
           r.returncode != 0 and 'anchor must occur exactly once' in r.stderr
           and md5_of(db, 'public.fn_create_tournament(uuid,jsonb)') == moved
           and md5_of(db, 'public.fn_review_join_request(uuid,uuid,boolean)') == LIVE_MD5['public.fn_review_join_request(uuid,uuid,boolean)']
           and scalar(db, "SELECT to_regclass('public.ca_commerce_admission_decisions') IS NULL") == 't', r.stderr[-300:])

    db = copy('admission_concurrent')
    psql(db, """DO $d$ DECLARE v text; BEGIN
      v := pg_get_functiondef('public.fn_create_tournament(uuid,jsonb)'::regprocedure);
      EXECUTE replace(v, '  RETURN v_res;', '  -- a concurrent workstream line' || chr(10) || '  RETURN v_res;');
    END $d$;""")
    r = apply(db)
    body = scalar(db, "SELECT prosrc LIKE '%a concurrent workstream line%' AND prosrc LIKE '%ca-commerce-admission%' FROM pg_proc WHERE oid='public.fn_create_tournament(uuid,jsonb)'::regprocedure")
    record('SAFETY a concurrent change elsewhere in a door body is preserved, not clobbered', r.returncode == 0 and body == 't', r.stderr[-300:])

    db = copy('admission_exact_diff')
    befores = {s: text(db, f"SELECT pg_get_functiondef('{s}'::regprocedure)") for s in LIVE_MD5 if 'admission(' not in s}
    ck(apply(db).returncode == 0, 'safety: apply for the diff')
    diffs = {}
    for s, b in befores.items():
        a = text(db, f"SELECT pg_get_functiondef('{s}'::regprocedure)")
        bl, al = b.split('\n'), a.split('\n')
        diffs[s] = (len(al) - len(bl), all(line in al for line in bl))
    record('SAFETY each door only gains lines (every original line survives, none is edited)',
           all(added > 0 and kept for added, kept in diffs.values()), diffs)


# ---------------------------------------------------------------------------
def main():
    try:
        base.start_cluster()
        base.load_fixture()
        base.apply_migration()
        for f in ('door-dependencies.sql', 'live-doors.sql'):
            r = base.run(base.PSQL + ['-d', TEMPLATE, '-f', str(FIXTURE / f)])
            if r.returncode:
                raise SystemExit(f'fixture {f} failed:\n{r.stderr}')
        base.seed()
        for who in (base.A, base.B, base.D, base.P, base.S, base.X):
            psql(TEMPLATE, f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES ('{sid(who)}','{who}',now() + interval '1 day')")

        fidelity = {s: md5_of(TEMPLATE, s) == m for s, m in LIVE_MD5.items()}
        record('FIXTURE the four doors and the admission read are byte-identical to production (md5 of pg_get_functiondef)', all(fidelity.values()), fidelity)

        psql('postgres', f'CREATE DATABASE {RED} TEMPLATE {TEMPLATE}')
        psql('postgres', f'CREATE DATABASE {GREEN} TEMPLATE {TEMPLATE}')
        migration_safety()

        r = base.run(base.PSQL + ['-d', GREEN, '-f', str(MIGRATION)])
        if r.returncode:
            raise SystemExit('admission migration failed:\n' + r.stderr)
        record('INSTALL the migration applies in one transaction with its baseline pins and post-conditions', True)

        run_scenarios(RED, expect_fail=True)
        run_scenarios(GREEN, expect_fail=False)

        # REGRESSION: the original harness, with this migration on top.
        r = base.run(base.PSQL + ['-d', TEMPLATE, '-f', str(MIGRATION)])
        if r.returncode:
            raise SystemExit('admission migration failed on the regression database:\n' + r.stderr)
        base.passed = 0
        base.scenarios()
        record(f'REGRESSION the original commerce harness passes {base.passed} scenarios with admission wired', base.passed >= 155, base.passed)

        print(f'PASS {passed} checks: diamond commerce admission is wired in shadow, qualified in isolation')
        out = os.environ.get('ADMISSION_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'migration': MIGRATION.name}, indent=1))
    except (AssertionError, CheckFailed) as e:
        print('FAIL', e, file=sys.stderr)
        out = os.environ.get('ADMISSION_RESULTS')
        if out:
            Path(out).write_text(json.dumps({'passed': passed, 'results': results, 'failure': str(e)}, indent=1))
        sys.exit(1)
    finally:
        base.stop_cluster()


if __name__ == '__main__':
    main()
