#!/usr/bin/env python3
"""Real admission/offer bodies on disposable PG17; eligibility leaves are fixtures.

No production writes. Fail-before/pass-after uses the retained installed
preimage, then the exact guarded migration. Capacity, queue claims, holds,
notification persistence and concurrent transactions execute in PostgreSQL.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin' if sys.platform == 'darwin' else '/usr/lib/postgresql/17/bin'))
MIGRATION = ROOT / 'supabase/migrations/20261020201931_unattended_cash_game_offers.sql'
work = Path(tempfile.mkdtemp(prefix='uoffer-', dir=os.environ['TMPDIR']))
socket = work / 's'
socket.mkdir()
port = '55793'
started = False
count = 0
G = '10000000-0000-4000-8000-000000000001'
C = '20000000-0000-4000-8000-000000000001'
T = '30000000-0000-4000-8000-000000000001'
T2 = '30000000-0000-4000-8000-000000000002'
U = '40000000-0000-4000-8000-000000000001'
U2 = '40000000-0000-4000-8000-000000000002'

def command(args, sql=None):
    r = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True, timeout=45)
    if r.returncode:
        raise RuntimeError(r.stdout + r.stderr)
    return r.stdout.strip()

def q(sql):
    return command([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres'], sql)

def check(ok, label):
    global count
    if not ok:
        raise AssertionError(label)
    count += 1
    print('PASS', label, flush=True)

def offer(table=T):
    return json.loads(q(f"SELECT fn_offer_open_seat('{table}');"))

def seed():
    q(f"""TRUNCATE cash_games,tables,profiles,table_seats,table_waitlist,cash_game_waitlist,notifications,cash_seat_moves,club_members,clubs;
      INSERT INTO clubs VALUES('{C}',NULL,true,'chips');
      INSERT INTO cash_games VALUES('{G}','{C}',true,'must_move','{{}}',NULL);
      INSERT INTO tables(id,name,cluster_id,max_players) VALUES('{T}','Main 2','{G}',1),('{T2}','Feeder','{G}',1);
      INSERT INTO profiles VALUES('{U}',false,true,false),('{U2}',true,true,false);
      INSERT INTO cash_game_waitlist(game_id,user_id,status,created_at) VALUES
        ('{G}','{U}','waiting',now()-interval '2 minutes'),('{G}','{U2}','waiting',now()-interval '1 minute');""")

try:
    command([PG/'initdb','-D',work/'d','-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    command([PG/'pg_ctl','-D',work/'d','-l',work/'server.log','-o',f"-k {socket} -p {port} -h ''",'-w','start'])
    started = True
    q("""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('fixture.uid',true),'')::uuid$$;
      CREATE TABLE profiles(id uuid PRIMARY KEY,is_horse boolean,funded boolean,barred boolean);
      CREATE TABLE clubs(id uuid,owner_id uuid,is_public boolean,asset text);
      CREATE TABLE club_members(club_id uuid,user_id uuid,status text);
      CREATE TABLE cash_games(id uuid PRIMARY KEY,club_id uuid,enabled boolean,cluster_mode text,ruleset_snapshot jsonb,opening_hold_since timestamptz);
      CREATE TABLE tables(id uuid PRIMARY KEY,name text,cluster_id uuid,max_players integer,current_players integer DEFAULT 0,
        tournament_id uuid,lifecycle text DEFAULT 'live',status text DEFAULT 'running',is_deleted boolean DEFAULT false,
        role text DEFAULT 'main',main_index integer DEFAULT 2,created_at timestamptz DEFAULT now());
      CREATE TABLE table_seats(id uuid DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,seat_number integer,left_at timestamptz);
      CREATE TABLE table_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,position integer,
        status text,created_at timestamptz DEFAULT now(),notified_at timestamptz,hold_expires_at timestamptz);
      CREATE UNIQUE INDEX active_table_queue ON table_waitlist(table_id,user_id) WHERE status IN ('waiting','notified');
      CREATE TABLE cash_game_waitlist(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid,user_id uuid,status text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX active_game_queue ON cash_game_waitlist(game_id,user_id) WHERE status IN ('waiting','notified');
      CREATE TABLE notifications(id uuid DEFAULT gen_random_uuid(),user_id uuid,type text,title text,message text,data jsonb);
      CREATE TABLE waitlist_policy(id boolean,max_concurrent_holds integer); INSERT INTO waitlist_policy VALUES(true,1);
      CREATE TABLE cash_seat_moves(to_table_id uuid,state text,swap_move_id uuid);
      CREATE FUNCTION fn_cash_game_open_seats(p_table_id uuid) RETURNS integer LANGUAGE sql STABLE AS $$
        SELECT greatest(0,coalesce(t.max_players,9)
          -(SELECT count(*) FROM table_seats s WHERE s.table_id=t.id AND s.left_at IS NULL)
          -(SELECT count(*) FROM table_waitlist w WHERE w.table_id=t.id AND w.status='notified' AND w.hold_expires_at>clock_timestamp())
          -(SELECT count(*) FROM cash_seat_moves m WHERE m.to_table_id=t.id AND m.state='pending' AND m.swap_move_id IS NULL))::integer
        FROM tables t WHERE t.id=p_table_id $$;
      CREATE FUNCTION fn_ca_cash_wallet_covers(uuid,uuid,uuid,numeric) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT funded FROM profiles WHERE id=$1$$;
      CREATE FUNCTION fn_ca_cash_entry_need(uuid,uuid) RETURNS numeric LANGUAGE sql STABLE AS $$SELECT 80::numeric$$;
      CREATE FUNCTION fn_cash_game_barred_seconds(uuid,uuid) RETURNS integer LANGUAGE sql STABLE AS $$SELECT CASE WHEN barred THEN 60 ELSE NULL END FROM profiles WHERE id=$2$$;
      CREATE FUNCTION fn_caller_session_is_live() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
      CREATE TABLE diamond_debts(user_id uuid,settled_at timestamptz,amount numeric);""")
    q((ROOT/'scripts/ci/fixtures/unattended-offer-preimage.sql').read_text())
    seed()
    check(offer()['reason']=='nobody_waiting','baseline misses game queue at a real vacancy')
    q(MIGRATION.read_text())
    check(offer()['user_id']==U,'vacancy offers the game FIFO head')
    check(q("SELECT count(*) FROM table_waitlist WHERE status='notified'")=='1','one committed table hold')
    check(q(f"SELECT status FROM cash_game_waitlist WHERE user_id='{U}'")=='notified','game queue transition committed')
    check(q("SELECT count(*) FROM notifications WHERE type='waitlist_seat_open'")=='1','notification written with hold')
    check(offer()['reason']=='open_seats_already_held','repeated vacancy cannot offer a held chair')
    same=json.loads(q(f"SET fixture.uid='{U}'; SELECT fn_cash_game_join('{G}');"))
    check(same['action']=='seat' and same['table_id']==T,'arrival reuses the offered table without another hold')
    check(q('SELECT count(*) FROM table_seats')=='0','opening buy-in has not purchased a seat')
    seed(); q(f"INSERT INTO table_seats(table_id,user_id) VALUES('{T}','{U2}')")
    check(offer()['reason']=='table_full','actual occupancy overrides stale cached count')
    seed(); q(f"INSERT INTO cash_seat_moves VALUES('{T}','pending',NULL)")
    check(offer()['reason']=='open_seats_already_held','pending moves keep their reservation')
    seed(); q(f"INSERT INTO table_waitlist(table_id,user_id,status,position) VALUES('{T}','{U2}','waiting',1)")
    check(offer()['user_id']==U2,'existing table-specific FIFO retains priority')
    seed(); q(f"UPDATE profiles SET funded=false WHERE id='{U}'")
    check(offer()['user_id']==U2,'unfunded queue head is passed over for this chair')
    check(q(f"SELECT status FROM cash_game_waitlist WHERE user_id='{U}'")=='waiting','unfunded player keeps queue place')
    seed(); q(f"INSERT INTO table_waitlist(table_id,user_id,status,hold_expires_at) VALUES('{T2}','{U}','notified',now()+interval '1 minute')")
    check(offer()['user_id']==U2,'live hold elsewhere respects user cap')
    seed(); q(f"UPDATE profiles SET barred=true WHERE id='{U}'")
    check(offer()['user_id']==U2,'barred player receives no game offer')
    seed(); q("UPDATE clubs SET is_public=false")
    check(offer()['reason']=='nobody_waiting','revoked private membership is not admitted')
    seed(); q('UPDATE cash_games SET enabled=false')
    check(offer()['reason']=='nobody_waiting','disabled game grants no new hold')
    seed()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(offer,[T,T2]))
    check(all(r.get('ok') for r in results),'simultaneous vacancies both progress')
    check(len({r['user_id'] for r in results})==2,'simultaneous vacancies cannot double-offer a player')
    check(q("SELECT count(*) FROM table_waitlist WHERE status='notified'")=='2','concurrent holds persist exactly once each')
    seed(); q(f"UPDATE cash_game_waitlist SET status='cancelled' WHERE user_id='{U2}'")
    def join_or_offer(which):
        return json.loads(q(f"SET fixture.uid='{U}'; SELECT fn_cash_game_join('{G}');")) if which==0 else offer(T2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(join_or_offer,[0,1]))
    check(q(f"SELECT count(*) FROM table_waitlist WHERE user_id='{U}' AND status='notified'")=='1','direct join and vacancy share one exclusive user claim')
    # A LIGHTNING CLUSTER'S VACANCY SEATS ITS GAME LIST (2026-10-22). The tick
    # stands down for a Lightning Cluster, so the horse a game-list person is
    # owed stands up at one table and THIS offer is the only door that seats
    # them. A horse further back keeps its place; the person heads the list.
    seed(); q("UPDATE cash_games SET cluster_mode='lightning'")
    r=offer()
    check(r['user_id']==U,'Lightning cluster vacancy offers the game FIFO head')
    check(q(f"SELECT status FROM table_waitlist WHERE user_id='{U}' AND table_id='{T}'")=='notified','Lightning offer holds the freed chair at that table')
    check(q(f"SELECT status FROM cash_game_waitlist WHERE user_id='{U}'")=='notified','Lightning game row becomes notified with the hold')
    check(q("SELECT has_function_privilege('authenticated','fn_offer_open_seat(uuid,interval,interval)','EXECUTE')")=='f','offer remains service-only')
    replay=subprocess.run([str(x) for x in [PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres']],input=MIGRATION.read_text(),text=True,capture_output=True)
    check(replay.returncode!=0 and 'unattended_offer_preimage_changed' in replay.stderr,'migration refuses replay over a changed definition')
    print(json.dumps({'passed':count,'productionWrites':0,'fixture':'native PG17 admission/offer transactions'}))
finally:
    if not started and (work/'server.log').exists():
        print((work/'server.log').read_text(), file=sys.stderr)
    if started:
        command([PG/'pg_ctl','-D',work/'d','-m','immediate','-w','stop'])
    shutil.rmtree(work)
