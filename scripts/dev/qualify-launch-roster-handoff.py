#!/usr/bin/env python3
"""Native qualification of the locked launch cohort and its accepted-entry handoff.

Runs against a PRIVATE local PostgreSQL 17 cluster that holds the production
public schema (functions, tables, triggers) at the migration's exact preimage;
the preimage digests are checked before anything is written. It never connects
to a remote host.

Proves, with the real installed functions and every trigger enabled:
  1. reproduction: before the migration an entry accepted after the launch
     claim makes completion refuse (the 2026-10-18 23:00 freeroll stall);
  2. the migration installs, and a second install refuses on its preimage;
  3. after it, completion succeeds with the post-claim entry handed off by a
     durable late_registration wake, the database seating door seats it with
     its full stack, and a completion replay emits nothing more;
  4. a completion that waited behind a concurrently committing registration
     still hands that registration off (the proof -> complete window);
  5. a legacy receipt (no captured cohort) keeps the strict full-roster proof;
  6. an unseated member of the captured cohort still refuses completion;
  7. a post-cohort entry that is already seated must be fully funded;
  8. the captured cohort is immutable and replays unchanged from begin;
  9. the seating door refuses while the platform is frozen and seats after.
"""
import json, subprocess, sys, time, uuid
from pathlib import Path

psql, socket, port, database, out, migration = sys.argv[1:7]
out = Path(out); out.mkdir(parents=True, exist_ok=True)
if not socket.startswith('/'):
    raise SystemExit('A private Unix-socket cluster is required')
base = [psql, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-U', 'postgres', '-d', database]
results = []
# The unchanged funding floor and roster proof both refuse an unseated active entry.
STRICT_REFUSALS = ('launch_stacks_uncredited', 'launch_roster_unproven')

def sql(text, label=None, expect_error=None):
    r = subprocess.run(base, input="SET timezone='UTC';\n" + text, capture_output=True, text=True, timeout=120)
    if label:
        (out / f'{label}.log').write_text(text + '\n---\n' + r.stdout + r.stderr)
    if expect_error:
        if r.returncode == 0 or expect_error not in r.stderr:
            raise AssertionError(f'{label}: expected error {expect_error!r}, got rc={r.returncode} {r.stderr[-800:]}')
        return r.stderr
    if r.returncode:
        raise AssertionError(f'{label}: {r.stderr[-3000:]}')
    return r.stdout.strip()

def check(name, cond, detail=''):
    results.append({'case': name, 'pass': bool(cond), 'detail': detail})
    print(('PASS ' if cond else 'FAIL ') + name + (f' :: {detail}' if detail and not cond else ''), flush=True)
    if not cond:
        (out / 'results.json').write_text(json.dumps(results, indent=2))
        raise SystemExit(1)

PRE = {
    'fn_begin_tournament_launch_before_lease_generation(uuid,uuid,timestamp with time zone)': '97a2d8bf6fbf8e6b13bb620869f3e1e6',
    'fn_complete_tournament_launch_before_lease_generation(uuid,uuid)': '34524f5a0e0a7b8aed2f47cf69dfb1e7',
    'trg_tournament_launch_receipt_is_immutable()': '1d7c6bbe680abdb190fd418d4276016f',
}
for sig, digest in PRE.items():
    got = sql(f"SELECT md5(prosrc) FROM pg_proc WHERE oid='public.{sig}'::regprocedure")
    if got != digest:
        raise SystemExit(f'Database is not at the production preimage for {sig}: {got}')

CLUB = str(uuid.uuid4())
# A real production mtt-v2 event's published configuration (the 23:00 Chip freeroll).
TEMPLATE = json.loads((Path(__file__).resolve().parents[2] / 'tests/fixtures/launch-roster-handoff/tournament-template.json').read_text())
sql(f"""SET session_replication_role=replica;
INSERT INTO public.clubs(id,name) VALUES ('{CLUB}','Qualification Club');
INSERT INTO public.ca_mtt_admission_contract(singleton,abi)
  SELECT true,'unlimited-mtt-v2' WHERE NOT EXISTS (SELECT 1 FROM public.ca_mtt_admission_contract);""", 'fixture-club')

def users(n):
    ids = [str(uuid.uuid4()) for _ in range(n)]
    sql('SET session_replication_role=replica;\n' + ''.join(f"INSERT INTO public.profiles(id) VALUES ('{u}');\n" for u in ids))
    return ids

def make_event(name, cohort_size=4):
    t = str(uuid.uuid4()); g = str(uuid.uuid4())
    row = dict(TEMPLATE, id=t, name=name, club_id=CLUB, union_id=None, status='REGISTERING', current_level=0,
               current_players=cohort_size, started_at=None, level_started_at=None, prize_pool_finalized=False,
               satellite_target_id=None, restart_source_id=None, add_on_available=False,
               blind_level_state=None)
    row_json = json.dumps(row).replace("'", "''")
    players = users(cohort_size)
    sql(f"""SET session_replication_role=replica;
INSERT INTO public.tournaments SELECT * FROM jsonb_populate_record(NULL::public.tournaments, '{row_json}'::jsonb);
UPDATE public.tournaments SET start_time=date_trunc('second',clock_timestamp())+interval '10 minutes' WHERE id='{t}';
INSERT INTO public.engine_tournament_leases(tournament_id,instance_id,lease_generation,protocol_version,heartbeat_at,acquired_at)
  VALUES ('{t}','qualification','{g}',2,clock_timestamp(),clock_timestamp());
""" + ''.join(f"INSERT INTO public.tournament_players(tournament_id,user_id,status,chips) VALUES ('{t}','{u}','registered',0);\n" for u in players), f'fixture-{name}')
    return {'t': t, 'g': g, 'players': players, 'launch': str(uuid.uuid4())}

def beat(e):
    sql(f"UPDATE public.engine_tournament_leases SET heartbeat_at=clock_timestamp() WHERE tournament_id='{e['t']}'")

def begin(e):
    beat(e)
    return json.loads(sql(f"""SELECT public.fn_begin_tournament_launch_atomic('{e['t']}','{e['launch']}',
      (SELECT start_time FROM public.tournaments WHERE id='{e['t']}'),'{e['g']}','mtt-v2')"""))

def seat_field(e, who):
    tb = str(uuid.uuid4()); e['table'] = tb
    sql(f"""INSERT INTO public.tables(id,club_id,tournament_id,name,game_type,game_variant,stakes,small_blind,big_blind,ante,
      min_buy_in,max_buy_in,max_players,current_players,status,action_time_seconds)
      VALUES ('{tb}','{CLUB}','{e['t']}','Q Table 1','tournament','nlh','25/50',25,50,0,0,0,9,0,'waiting',15);""", 'table-' + e['t'][:8])
    for i, u in enumerate(who, 1):
        r = json.loads(sql(f"SELECT public.fn_assign_tournament_player_seat_atomic('{e['t']}','{u}','{tb}',{i})"))
        if r.get('ok') is not True:
            raise AssertionError(f'cohort seat refused: {r}')

def accept_entry(e):
    u = users(1)[0]
    sql(f"""SET session_replication_role=replica;
INSERT INTO public.tournament_players(tournament_id,user_id,status,chips) VALUES ('{e['t']}','{u}','registered',0);
UPDATE public.tournaments SET current_players=current_players+1 WHERE id='{e['t']}';""")
    return u

def complete(e, label=None):
    beat(e)
    return json.loads(sql(f"SELECT public.fn_complete_tournament_launch_atomic('{e['t']}','{e['launch']}','{e['g']}','mtt-v2')", label))

def wakes(e):
    return json.loads(sql(f"""SELECT coalesce(jsonb_agg(jsonb_build_object('reason',reason,'generation',generation,'consumed',consumed_at IS NOT NULL)),'[]')
      FROM public.tournament_manager_wakes WHERE tournament_id='{e['t']}'"""))

def state(e, u):
    return json.loads(sql(f"""SELECT jsonb_build_object(
      'status',(SELECT status FROM public.tournaments WHERE id='{e['t']}'),
      'receipt_completed',(SELECT completed_at IS NOT NULL FROM public.tournament_launch_receipts WHERE tournament_id='{e['t']}'),
      'entry',(SELECT jsonb_build_object('status',status,'chips',chips,'table',table_id IS NOT NULL) FROM public.tournament_players WHERE tournament_id='{e['t']}' AND user_id='{u}'),
      'live_seat',(SELECT jsonb_build_object('stack',s.stack) FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
                   WHERE tb.tournament_id='{e['t']}' AND s.user_id='{u}' AND s.left_at IS NULL))"""))

# ---- 1. reproduction on the installed preimage -------------------------------------------
old = make_event('Q Reproduction')
check('preimage begin claims a receipt', begin(old).get('claimed') is True)
seat_field(old, old['players'])
late = accept_entry(old)
r = complete(old, 'reproduction-complete')
check('preimage completion refuses an entry accepted after the claim', r.get('ok') is False and r.get('reason') in STRICT_REFUSALS, json.dumps(r))
legacy = old  # its receipt predates the migration: no captured cohort

# ---- 2. install ------------------------------------------------------------------------------
mig = Path(migration).read_text()
sql(mig, 'migration-install')
check('migration installs on the exact preimage', True)
sql(mig, 'migration-reinstall', expect_error='LAUNCH_COHORT_PREIMAGE_DRIFT')
check('a second install refuses on its changed preimage', True)

# ---- 3. the handoff ------------------------------------------------------------------------
e = make_event('Q Handoff')
b = begin(e)
check('begin returns the locked cohort', sorted(b.get('launch_player_ids') or []) == sorted(json.loads(sql(
    f"SELECT jsonb_agg(id) FROM public.tournament_players WHERE tournament_id='{e['t']}'"))), json.dumps(b))
seat_field(e, e['players'])
late = accept_entry(e)
r = complete(e, 'handoff-complete')
check('completion succeeds with the post-claim entry handed off', r.get('ok') is True and r.get('completed') is True
      and r.get('post_claim_pending_entries') == 1 and r.get('post_claim_wake_id') is not None, json.dumps(r))
s = state(e, late)
check('the event is RUNNING with its receipt completed', s['status'] == 'RUNNING' and s['receipt_completed'] is True, json.dumps(s))
check('the handed-off entry is still registered and owns no chair yet', s['entry']['status'] == 'registered' and s['live_seat'] is None, json.dumps(s))
w = wakes(e)
check('one durable late_registration wake retains the handoff', [x['reason'] for x in w] == ['late_registration'] and not w[0]['consumed'], json.dumps(w))
seat = json.loads(sql(f"SELECT public.fn_seat_late_registrant('{e['t']}','{late}')", 'handoff-seat'))
s = state(e, late)
check('the database seating door seats it with the full starting stack', seat.get('ok') is True and s['entry']['status'] == 'playing'
      and float(s['live_seat']['stack']) == 5000 and s['entry']['chips'] == 5000, json.dumps([seat, s]))
again = json.loads(sql(f"SELECT public.fn_seat_late_registrant('{e['t']}','{late}')"))
check('seating is idempotent', again.get('ok') is False and again.get('reason') == 'already_seated_or_missing', json.dumps(again))
r2 = complete(e)
check('a completion replay succeeds and emits nothing more', r2.get('ok') is True and r2.get('replay') is True and wakes(e) == w, json.dumps([r2, wakes(e)]))
b2 = begin(e)
check('a begin replay returns the same cohort', sorted(b2.get('launch_player_ids') or []) == sorted(b['launch_player_ids']), json.dumps(b2))

# ---- 4. a registration committing while completion waits on the tournament lock ------------
c = make_event('Q Concurrent')
begin(c); seat_field(c, c['players'])
waiter_user = users(1)[0]
holder = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
holder.stdin.write(f"""BEGIN;
SELECT id FROM public.tournaments WHERE id='{c['t']}' FOR UPDATE;
SET LOCAL session_replication_role=replica;
INSERT INTO public.tournament_players(tournament_id,user_id,status,chips) VALUES ('{c['t']}','{waiter_user}','registered',0);
SELECT pg_sleep(4);
COMMIT;
""")
holder.stdin.close()
time.sleep(1)
beat(c)
t0 = time.time()
r = complete(c, 'concurrent-complete')
waited = time.time() - t0
holder.wait(timeout=30)
check('completion waited behind the committing registration', waited > 1.5, f'{waited:.2f}s')
check('and handed that registration off instead of refusing', r.get('ok') is True and r.get('post_claim_pending_entries') == 1, json.dumps(r))

# ---- 5. legacy receipt ---------------------------------------------------------------------
r = complete(legacy, 'legacy-complete')
check('a receipt with no captured cohort keeps the strict proof', r.get('ok') is False and r.get('reason') in STRICT_REFUSALS, json.dumps(r))

# ---- 6. an unseated member of the cohort ---------------------------------------------------
m = make_event('Q Missing Member')
begin(m); seat_field(m, m['players'][:3]); accept_entry(m)
r = complete(m, 'missing-member-complete')
check('an unseated captured entrant still refuses completion', r.get('ok') is False and r.get('reason') in STRICT_REFUSALS, json.dumps(r))
check('and nothing is handed off by a refused completion', wakes(m) == [])

# ---- 7. a seated post-cohort entry must be funded ------------------------------------------
f = make_event('Q Funded')
begin(f); seat_field(f, f['players'])
extra = accept_entry(f)
seat = json.loads(sql(f"SELECT public.fn_assign_tournament_player_seat_atomic('{f['t']}','{extra}','{f['table']}',5)"))
r = complete(f, 'funded-complete')
check('a fully funded seated post-cohort entry completes with no handoff', seat.get('ok') is True and r.get('ok') is True
      and r.get('post_claim_pending_entries') == 0 and wakes(f) == [], json.dumps([seat, r]))

# ---- 8. immutability -----------------------------------------------------------------------
i = make_event('Q Immutable')
begin(i)
sql(f"UPDATE public.tournament_launch_receipts SET launch_player_ids=ARRAY[]::uuid[] WHERE tournament_id='{i['t']}'", 'immutable-update',
    expect_error='immutable')
check('the captured cohort cannot be rewritten', True)

# ---- 9. freeze -----------------------------------------------------------------------------
z = make_event('Q Freeze')
begin(z); seat_field(z, z['players']); held = accept_entry(z)
r = complete(z)
check('freeze case completes with a handoff', r.get('ok') is True and r.get('post_claim_pending_entries') == 1, json.dumps(r))
sql(f"""SET session_replication_role=replica;
INSERT INTO public.engine_maintenance_break(id,phase,reason,announced_at,break_started_at,break_ends_at,enforce_freeze,declared_by,ownership_token,updated_at)
VALUES (true,'counting_down','Qualification',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '30 seconds',clock_timestamp()+interval '4 minutes',true,'q','{uuid.uuid4()}',clock_timestamp());""", 'freeze-on')
frozen = json.loads(sql(f"SELECT public.fn_seat_late_registrant('{z['t']}','{held}')"))
check('the seating door refuses while frozen and writes nothing', frozen.get('reason') == 'platform_frozen' and state(z, held)['live_seat'] is None, json.dumps(frozen))
sql("SET session_replication_role=replica; DELETE FROM public.engine_maintenance_break;", 'freeze-off')
thawed = json.loads(sql(f"SELECT public.fn_seat_late_registrant('{z['t']}','{held}')"))
check('and seats the entry after the thaw', thawed.get('ok') is True and state(z, held)['entry']['status'] == 'playing', json.dumps(thawed))

(out / 'results.json').write_text(json.dumps(results, indent=2))
print(f'LAUNCH_ROSTER_HANDOFF_NATIVE_PASS: {len(results)} cases')
