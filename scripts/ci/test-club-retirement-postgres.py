#!/usr/bin/env python3
"""Native PG17 acceptance for retained-club retirement; isolated fixtures only.

On macOS PostgreSQL still needs one tiny System-V segment even with mmap. A
machine whose global SHMMNI table is exhausted cannot start another private
postmaster. Prefer an already-running Unix-socket test server when available,
but always create and drop a uniquely named database so no shared state is
read or changed. PG_EXISTING_SOCKET/PG_EXISTING_PORT can select one explicitly.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'supabase/migrations/20261002152925_club_retirement_unwinds_unused_welcome_and_closes_lifecycle_gaps.sql'
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
SCRATCH = ROOT / '.native-test-tmp'
SCRATCH.mkdir(exist_ok=True)
CLUSTER = Path(tempfile.mkdtemp(prefix='club-retirement-', dir=SCRATCH))
DATA = CLUSTER / 'data'
SOCKET = CLUSTER / 'socket'
SOCKET.mkdir(mode=0o700)
PORT = '55753'
EXISTING_SOCKET = os.environ.get('PG_EXISTING_SOCKET')
if EXISTING_SOCKET:
    SOCKET = Path(EXISTING_SOCKET)
    PORT = os.environ.get('PG_EXISTING_PORT', '5432')
else:
    candidates = []
    if os.environ.get('PGHOST', '').startswith('/'):
        candidates.append((os.environ['PGHOST'], os.environ.get('PGPORT', '5432')))
    candidates.extend([('/tmp', '55433'), ('/tmp', '5432'), ('/var/run/postgresql', '5432')])
    for candidate_socket, candidate_port in candidates:
        ready = subprocess.run(
            [str(PG/'pg_isready'), '-q', '-h', candidate_socket, '-p', candidate_port,
             '-U', 'postgres', '-d', 'postgres'],
            capture_output=True, timeout=3,
        )
        if ready.returncode == 0:
            EXISTING_SOCKET = candidate_socket
            SOCKET = Path(candidate_socket)
            PORT = candidate_port
            break
DB = f"club_retirement_{os.getpid()}" if EXISTING_SOCKET else 'postgres'
ENV = {'PATH': f'{PG}:/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGCONNECTTIMEOUT': '5'}
OWNER = '00000000-0000-4000-8000-000000000001'
MEMBER = '00000000-0000-4000-8000-000000000002'
CLUB = '10000000-0000-4000-8000-000000000001'
CUSTOM = '10000000-0000-4000-8000-000000000002'
USED = '10000000-0000-4000-8000-000000000003'
started = False


def command(argv, sql=None):
    return subprocess.run([str(v) for v in argv], input=sql, text=True,
                          capture_output=True, env=ENV, timeout=60)


def query(sql, error=None):
    result = command([PG/'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                      '-h', SOCKET, '-p', PORT, '-U', 'postgres', '-d', DB], sql)
    if error:
        assert result.returncode != 0 and error in result.stderr, result.stderr + result.stdout
        return result.stderr
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout)
    return result.stdout.strip()


def as_owner(sql):
    claims = json.dumps({'sub': OWNER, 'role': 'authenticated'}).replace("'", "''")
    return query(f"SET request.jwt.claims='{claims}'; SET ROLE authenticated; {sql}")


FIXTURE = r"""
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END$$;
GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
ALTER FUNCTION auth.uid() OWNER TO postgres;

CREATE TABLE public.ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
CREATE TABLE public.clubs(
 id uuid PRIMARY KEY,name text NOT NULL,owner_id uuid NOT NULL,club_id text DEFAULT '1',
 lifecycle_status text NOT NULL DEFAULT 'active',retired_at timestamptz,retired_by uuid,
 retirement_reason text,is_public boolean DEFAULT true,requires_approval boolean DEFAULT false,
 union_id uuid,is_union boolean DEFAULT false,chip_treasury numeric DEFAULT 0,
 chip_pool numeric DEFAULT 0,promo_balance numeric DEFAULT 0,insurance_balance numeric DEFAULT 0,
 spins_enabled boolean DEFAULT true,bbj_enabled boolean DEFAULT true,bbj_rake_enabled boolean DEFAULT true,
 updated_at timestamptz DEFAULT now());
CREATE TABLE public.club_members(id uuid DEFAULT gen_random_uuid(),club_id uuid,user_id uuid,
 role text DEFAULT 'member',status text DEFAULT 'active',is_active boolean DEFAULT true);
CREATE TABLE public.unions(id uuid PRIMARY KEY,owner_id uuid);
CREATE TABLE public.union_clubs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,union_id uuid);
CREATE TABLE public.union_admins(union_id uuid,user_id uuid);
CREATE TABLE public.cash_games(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,
 enabled boolean DEFAULT true,state text DEFAULT 'live');
CREATE TABLE public.tournament_schedules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,
 active boolean DEFAULT true);
CREATE TABLE public.tournament_schedule_spawns(id bigserial PRIMARY KEY,schedule_id uuid,spawn_key text);
CREATE TABLE public.tables(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,cluster_id uuid);
CREATE TABLE public.tournaments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,status text DEFAULT 'scheduled');
CREATE TABLE public.managed_game_schedules(schedule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 game_kind text,game_id uuid,status text DEFAULT 'scheduled');
CREATE TABLE public.club_opening_checklists(club_id uuid PRIMARY KEY);
CREATE TABLE public.club_welcome_entitlements(club_id uuid PRIMARY KEY,pristine boolean DEFAULT true);
CREATE TABLE public.club_welcome_package_items(club_id uuid,slot_key text,retired_at timestamptz,
 PRIMARY KEY(club_id,slot_key));
CREATE TABLE public.club_welcome_package_funding(club_id uuid,destination text,amount numeric,
 PRIMARY KEY(club_id,destination));
CREATE TABLE public.wheel_configs(host_id uuid PRIMARY KEY,host_kind text,enabled boolean DEFAULT false);
CREATE TABLE public.wheel_pools(host_id uuid PRIMARY KEY,spins bigint DEFAULT 0);
CREATE TABLE public.diamond_game_configs(host_id uuid,game text,host_kind text,enabled boolean DEFAULT false,
 PRIMARY KEY(host_id,game));
CREATE TABLE public.diamond_game_pools(host_id uuid,game text,rounds bigint DEFAULT 0,
 PRIMARY KEY(host_id,game));
CREATE TABLE public.chip_transactions(id uuid DEFAULT gen_random_uuid(),club_id uuid,amount numeric,
 transaction_type text,balance_after numeric,metadata jsonb DEFAULT '{}');
CREATE TABLE public.ca_mint_ledger(op_id text PRIMARY KEY,action text,asset text,holder_type text,
 holder_id uuid,amount numeric,balance_before numeric,balance_after numeric);
CREATE TABLE public.declared_ops(id bigserial PRIMARY KEY,category text,counterparty text,op_id text);
CREATE TABLE public.game_management_events(id bigserial PRIMARY KEY,event_type text,club_id uuid,
 recipient_id uuid,payload jsonb);

CREATE FUNCTION public.fn_club_union_context(uuid)
RETURNS TABLE(own_union_id uuid,member_union_id uuid) LANGUAGE sql STABLE AS $$SELECT NULL::uuid,NULL::uuid$$;
CREATE FUNCTION public.is_club_admin(p_club uuid,p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club AND owner_id=p_user)
$$;
CREATE FUNCTION public.fn_club_is_staff(p_club uuid,p_user uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT public.is_club_admin(p_club,p_user)
$$;
CREATE FUNCTION public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])
RETURNS void LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO public.declared_ops(category,counterparty,op_id) VALUES($1,$2,$5);
END$$;
CREATE FUNCTION public.fn_ca_lock_settlement_lane_global() RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(719927577,2147483000)
$$;
CREATE FUNCTION public.fn_emit_game_management_event(text,uuid,uuid,uuid,text,uuid,uuid,jsonb)
RETURNS void LANGUAGE plpgsql AS $$BEGIN
 INSERT INTO public.game_management_events(event_type,club_id,recipient_id,payload)
 VALUES($1,$2,$4,$8);
END$$;
CREATE FUNCTION public.fn_unwind_unused_first_club_welcome_package(p_club uuid,p_op uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN
 IF EXISTS(SELECT 1 FROM public.club_welcome_entitlements WHERE club_id=p_club AND NOT pristine) THEN
   RAISE EXCEPTION 'WELCOME_PACKAGE_HAS_PLAY_OR_REGISTRATION_HISTORY' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.club_welcome_entitlements WHERE club_id=p_club) THEN
   RETURN jsonb_build_object('ok',true,'reason','no_welcome_package');
 END IF;
 UPDATE public.cash_games SET enabled=false,state='dormant' WHERE club_id=p_club;
 UPDATE public.tournament_schedules SET active=false WHERE club_id=p_club;
 UPDATE public.clubs SET chip_treasury=chip_treasury+
   (SELECT coalesce(sum(amount),0) FROM public.club_welcome_package_funding WHERE club_id=p_club)
   WHERE id=p_club;
 UPDATE public.club_welcome_package_items SET retired_at=now() WHERE club_id=p_club;
 RETURN jsonb_build_object('ok',true,'opening_grant_unwound',false);
END$$;
REVOKE ALL ON FUNCTION public.fn_unwind_unused_first_club_welcome_package(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_unwind_unused_first_club_welcome_package(uuid,uuid) TO service_role;
CREATE FUNCTION public.fn_get_club_welcome_package_reset_impact(p_club uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$BEGIN
 RETURN jsonb_build_object('authorized',auth.uid()=(SELECT owner_id FROM public.clubs WHERE id=p_club),
   'can_reset',EXISTS(SELECT 1 FROM public.club_welcome_entitlements WHERE club_id=p_club AND pristine),
   'cash_game_ids',coalesce((SELECT jsonb_agg(id) FROM public.cash_games WHERE club_id=p_club),'[]'::jsonb),
   'schedule_ids',coalesce((SELECT jsonb_agg(id) FROM public.tournament_schedules WHERE club_id=p_club),'[]'::jsonb),
   'tournament_ids','[]'::jsonb);
END$$;

CREATE FUNCTION public.fn_club_retirement_impact(p_club uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$DECLARE c public.clubs%ROWTYPE; BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
 SELECT * INTO c FROM public.clubs WHERE id=p_club;
 IF c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'owner only'; END IF;
 RETURN jsonb_build_object('members',(SELECT count(*) FROM public.club_members WHERE club_id=p_club),
 'running_tables',0,'active_tournaments',0,
 'wallet_chips',abs(coalesce(c.chip_treasury,0))+abs(coalesce(c.chip_pool,0))+
   abs(coalesce(c.promo_balance,0))+abs(coalesce(c.insurance_balance,0))+
   CASE WHEN EXISTS(SELECT 1 FROM public.club_welcome_package_items WHERE club_id=p_club AND retired_at IS NULL)
     THEN (SELECT coalesce(sum(amount),0) FROM public.club_welcome_package_funding WHERE club_id=p_club)
     ELSE 0 END,
 'diamonds',0,'inventory_items',0,'open_obligations',0,'union_affiliated',false,
 'already_retired',c.lifecycle_status='retired');
END$$;
CREATE FUNCTION public.fn_club_deletion_impact(uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$
 SELECT public.fn_club_retirement_impact($1)
$$;
CREATE FUNCTION public.fn_retire_settled_club(p_club uuid,p_name text,p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$DECLARE c public.clubs%ROWTYPE;i jsonb;BEGIN
 SELECT * INTO c FROM public.clubs WHERE id=p_club FOR UPDATE;
 IF c.owner_id IS DISTINCT FROM auth.uid() OR btrim(c.name) IS DISTINCT FROM btrim(p_name) THEN
   RETURN jsonb_build_object('success',false,'error','auth');
 END IF;
 IF c.lifecycle_status='retired' THEN RETURN jsonb_build_object('success',true,'already_retired',true); END IF;
 i:=public.fn_club_retirement_impact(p_club);
 IF (i->>'wallet_chips')::numeric<>0 THEN RETURN jsonb_build_object('success',false,'error','balance'); END IF;
 UPDATE public.clubs SET lifecycle_status='retired',retired_at=now(),retired_by=auth.uid(),
   retirement_reason=p_reason,is_public=false,requires_approval=true WHERE id=p_club;
 RETURN jsonb_build_object('success',true,'already_retired',false,'records_retained',true);
END$$;
GRANT EXECUTE ON FUNCTION public.fn_club_retirement_impact(uuid),
 public.fn_club_deletion_impact(uuid),public.fn_retire_settled_club(uuid,text,text) TO authenticated,service_role;
"""


try:
    version = command([PG/'postgres', '--version']).stdout
    assert ' 17.' in version, version
    if EXISTING_SOCKET:
        result = command([PG/'createdb', '-h', SOCKET, '-p', PORT, '-U', 'postgres', DB])
        assert result.returncode == 0, result.stderr
    else:
        result = command([PG/'initdb', '-D', DATA, '-U', 'postgres', '--auth-local=trust',
                          '--auth-host=reject', '--no-locale', '--encoding=UTF8',
                          '-c', 'shared_memory_type=mmap',
                          '-c', 'dynamic_shared_memory_type=mmap'])
        assert result.returncode == 0, result.stderr
        with (DATA/'postgresql.conf').open('a') as config:
            config.write(
                f"\nlisten_addresses=''\nunix_socket_directories='{SOCKET}'\nport={PORT}\n"
                "shared_memory_type=mmap\ndynamic_shared_memory_type=mmap\nshared_buffers='16MB'\n"
            )
        started = True
        result = command([PG/'pg_ctl', '-D', DATA, '-l', CLUSTER/'server.log', '-w', 'start'])
        assert result.returncode == 0, result.stderr
    query(FIXTURE)
    query(MIGRATION.read_text())

    # A visible, unused welcome club retires in one atomic owner call.
    query(f"""
      INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES('{CLUB}','Fresh Club','{OWNER}',99700);
      INSERT INTO public.club_members(club_id,user_id,role) VALUES('{CLUB}','{OWNER}','owner'),('{CLUB}','{MEMBER}','member');
      INSERT INTO public.club_welcome_entitlements VALUES('{CLUB}',true);
      INSERT INTO public.club_welcome_package_items VALUES('{CLUB}','nlh-1',NULL);
      INSERT INTO public.club_welcome_package_funding VALUES('{CLUB}','bbj_main',100),('{CLUB}','spin_reserve',200);
      INSERT INTO public.cash_games(club_id) VALUES('{CLUB}');
      INSERT INTO public.tournament_schedules(club_id) VALUES('{CLUB}');
      INSERT INTO public.wheel_configs VALUES('{CLUB}','club',false);
      INSERT INTO public.wheel_pools VALUES('{CLUB}',0);
      INSERT INTO public.diamond_game_configs VALUES('{CLUB}','plinko','club',false);
      INSERT INTO public.diamond_game_pools VALUES('{CLUB}','plinko',0);
      INSERT INTO public.chip_transactions(club_id,amount,transaction_type,balance_after,metadata)
       VALUES('{CLUB}',100000,'club_opening_grant',100000,
         jsonb_build_object('mint_op_id','club-opening-grant:{CLUB}'));
      INSERT INTO public.ca_mint_ledger VALUES('club-opening-grant:{CLUB}','mint','chips','club','{CLUB}',100000,0,100000);
    """)
    preview = json.loads(as_owner(f"SELECT public.fn_club_retirement_impact('{CLUB}');"))
    assert preview['pristine_welcome_retire_available'] is True
    retired = json.loads(as_owner(f"SELECT public.fn_retire_settled_club('{CLUB}','Fresh Club','done');"))
    assert retired['success'] and retired['opening_grant_retired'] and retired['records_retained']
    assert query(f"SELECT lifecycle_status||':'||chip_treasury FROM public.clubs WHERE id='{CLUB}';") == 'retired:0'
    assert query(f"SELECT enabled||':'||state FROM public.cash_games WHERE club_id='{CLUB}';") == 'false:dormant'
    assert query(f"SELECT active FROM public.tournament_schedules WHERE club_id='{CLUB}';") == 'f'
    assert query(f"SELECT count(*) FROM public.declared_ops WHERE op_id='club-owner-retire-opening:{CLUB}' AND category='burn' AND counterparty='chip_retirement';") == '1'
    assert query(f"SELECT count(*) FROM public.clubs WHERE id='{CLUB}';") == '1'
    assert query(f"SELECT count(*) FROM public.club_members WHERE club_id='{CLUB}';") == '2'
    assert query(f"SELECT count(*) FROM public.game_management_events WHERE club_id='{CLUB}' AND recipient_id IS NOT NULL;") == '2'

    # Lost-response retry is idempotent: no second burn or invalidation.
    replay = json.loads(as_owner(f"SELECT public.fn_retire_settled_club('{CLUB}','Fresh Club','done');"))
    assert replay['success'] and replay['already_retired']
    assert query(f"SELECT count(*) FROM public.declared_ops WHERE op_id='club-owner-retire-opening:{CLUB}';") == '1'
    assert query(f"SELECT count(*) FROM public.game_management_events WHERE club_id='{CLUB}' AND recipient_id IS NOT NULL;") == '2'

    # Every later authoritative game/schedule relation is frozen.
    query(f"INSERT INTO public.cash_games(club_id) VALUES('{CLUB}');", 'CLUB_RETIRED')
    query(f"INSERT INTO public.tournament_schedules(club_id) VALUES('{CLUB}');", 'CLUB_RETIRED')
    schedule = query(f"SELECT id FROM public.tournament_schedules WHERE club_id='{CLUB}' LIMIT 1;")
    query(f"INSERT INTO public.tournament_schedule_spawns(schedule_id,spawn_key) VALUES('{schedule}','late');", 'CLUB_RETIRED')
    table_id = query(f"INSERT INTO public.tables(club_id) VALUES('{CLUB}') RETURNING id;")
    query(f"INSERT INTO public.managed_game_schedules(game_kind,game_id) VALUES('table','{table_id}');", 'CLUB_RETIRED')
    query(f"UPDATE public.wheel_configs SET enabled=true WHERE host_id='{CLUB}';", 'CLUB_RETIRED')
    query(f"UPDATE public.wheel_pools SET spins=1 WHERE host_id='{CLUB}';", 'CLUB_RETIRED')
    query(f"UPDATE public.diamond_game_configs SET enabled=true WHERE host_id='{CLUB}';", 'CLUB_RETIRED')
    query(f"UPDATE public.diamond_game_pools SET rounds=1 WHERE host_id='{CLUB}';", 'CLUB_RETIRED')

    # A non-welcome active game blocks a settled club; no lifecycle flip occurs.
    query(f"INSERT INTO public.clubs(id,name,owner_id) VALUES('{CUSTOM}','Custom','{OWNER}'); INSERT INTO public.cash_games(club_id) VALUES('{CUSTOM}');")
    custom_preview = json.loads(as_owner(f"SELECT public.fn_club_retirement_impact('{CUSTOM}');"))
    assert custom_preview['pristine_welcome_retire_available'] is False
    blocked = json.loads(as_owner(f"SELECT public.fn_retire_settled_club('{CUSTOM}','Custom',NULL);"))
    assert not blocked['success'] and 'Disable Every Cash Game' in blocked['error']
    assert query(f"SELECT lifecycle_status FROM public.clubs WHERE id='{CUSTOM}';") == 'active'

    # A used welcome package refuses atomically, retaining its grant and rows.
    query(f"""
      INSERT INTO public.clubs(id,name,owner_id,chip_treasury) VALUES('{USED}','Used','{OWNER}',100000);
      INSERT INTO public.club_welcome_entitlements VALUES('{USED}',false);
      INSERT INTO public.chip_transactions(club_id,amount,transaction_type,balance_after,metadata)
       VALUES('{USED}',100000,'club_opening_grant',100000,jsonb_build_object('mint_op_id','club-opening-grant:{USED}'));
      INSERT INTO public.ca_mint_ledger VALUES('club-opening-grant:{USED}','mint','chips','club','{USED}',100000,0,100000);
    """)
    used_preview = json.loads(as_owner(f"SELECT public.fn_club_retirement_impact('{USED}');"))
    assert used_preview['pristine_welcome_retire_available'] is False
    used = json.loads(as_owner(f"SELECT public.fn_retire_settled_club('{USED}','Used',NULL);"))
    assert not used['success'] and 'Welcome Games' in used['error']
    claims = json.dumps({'sub': OWNER, 'role': 'authenticated'}).replace("'", "''")
    assert query(f"SELECT lifecycle_status||':'||chip_treasury FROM public.clubs WHERE id='{USED}';") == 'active:100000'

    # A concurrent stale insert waits behind the club lock and then fails closed.
    race = '10000000-0000-4000-8000-000000000004'
    query(f"INSERT INTO public.clubs(id,name,owner_id) VALUES('{race}','Race','{OWNER}');")
    with ThreadPoolExecutor(max_workers=2) as workers:
        holder = workers.submit(query, f"SET application_name='retire-holder'; BEGIN; SET request.jwt.claims='{claims}'; SET ROLE authenticated; SELECT public.fn_retire_settled_club('{race}','Race',NULL); SELECT pg_sleep(1); COMMIT;")
        for _ in range(100):
            if query("SELECT count(*) FROM pg_stat_activity WHERE application_name='retire-holder' AND wait_event='PgSleep';") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('retirement holder did not reach commit boundary')
        query(f"SET lock_timeout='100ms'; INSERT INTO public.cash_games(club_id) VALUES('{race}');", 'lock timeout')
        holder.result()
    query(f"INSERT INTO public.cash_games(club_id) VALUES('{race}');", 'CLUB_RETIRED')

    print('club-retirement-native-acceptance-passed')
finally:
    if EXISTING_SOCKET:
        command([PG/'dropdb', '--if-exists', '-h', SOCKET, '-p', PORT, '-U', 'postgres', DB])
    if started and (DATA/'postmaster.pid').exists():
        command([PG/'pg_ctl', '-D', DATA, '-m', 'fast', '-w', 'stop'])
    shutil.rmtree(CLUSTER, ignore_errors=True)
    try:
        SCRATCH.rmdir()
    except OSError:
        pass
