#!/usr/bin/env python3
"""Exercise the exact news migration in a private PostgreSQL instance."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent or (os.uname().sysname == 'Darwin' and not parent.startswith('/Volumes/SmarterWork/agent-work/')):
    raise SystemExit('Set task-owned external SSD TMPDIR or hosted RUNNER_TEMP')
cluster = Path(tempfile.mkdtemp(prefix='news-', dir=parent))
data, sock = cluster/'d', cluster/'s'
sock.mkdir()
started = False
C = '00000000-0000-0000-0000-000000000001'
U = C
OTHER = '00000000-0000-0000-0000-000000000002'
POST = '00000000-0000-0000-0000-000000000003'

def run(args, sql=None):
    p = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True, timeout=60)
    if p.returncode:
        raise RuntimeError(p.stdout+p.stderr)
    return p.stdout.strip()

def q(sql):
    return run([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','postgres','-d','postgres'], sql)

def claim(user=U, club=C):
    return json.loads(q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.sub='{user}'; SELECT fn_claim_club_entry_news('{club}');"))

try:
    run([PG/'initdb','-D',data,'-U','postgres','--auth-local=trust','--auth-host=reject','--no-locale','-E','UTF8'])
    with (data/'postgresql.conf').open('a') as f:
        f.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\n")
    run([PG/'pg_ctl','-D',data,'-l',cluster/'server.log','-w','start'])
    started = True
    q('''CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
      CREATE TABLE clubs(id uuid PRIMARY KEY, lobby_message text, message_revision bigint, lobby_message_updated_at timestamptz);
      CREATE TABLE club_members(club_id uuid, user_id uuid);
      CREATE TABLE club_message_dismissals(user_id uuid, club_id uuid, dismissed_revision bigint);
      CREATE TABLE club_announcements(id uuid PRIMARY KEY, club_id uuid, title text, content text,
        is_active boolean DEFAULT true, is_pinned boolean DEFAULT false, expires_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE FUNCTION fn_can_manage_club_message(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    ''')
    original = (ROOT/'supabase/migrations/20260905000730_the_club_message_has_one_rule_and_one_door.sql').read_text()
    reader = re.search(r'CREATE OR REPLACE FUNCTION public.fn_get_club_entry_message\(.*?\n\$\$;', original, re.S).group()
    q(reader)
    q(f"INSERT INTO clubs VALUES ('{C}','First News',1,now()),('{OTHER}',null,0,null); INSERT INTO club_members VALUES ('{C}','{U}'),('{C}','{OTHER}');")
    # Baseline demonstrates repeated eligibility without explicit dismissal.
    baseline = f"SET request.jwt.claim.sub='{U}'; SELECT fn_get_club_entry_message('{C}')->>'should_show';"
    assert q(baseline) == 'true' and q(baseline) == 'true'
    migration = ROOT/'supabase/migrations/20261021180854_club_entry_news_automatically_shown_once.sql'
    q(migration.read_text())
    assert q("SELECT md5(prosrc) FROM pg_proc WHERE oid='fn_claim_club_entry_news(uuid)'::regprocedure") == 'b9a8f7eb97b9a83a8e3f6de1c0c16a41'
    assert claim()['message'] == 'First News'
    assert claim()['should_show'] is False
    q("UPDATE club_entry_news_receipts SET shown_at='2020-01-01'; UPDATE clubs SET message_revision=2;")
    assert claim()['should_show'] is False  # neither next day nor unchanged save
    assert claim(OTHER)['message'] == 'First News'  # per person, fresh DB connection/device
    assert claim(club=OTHER)['reason'] == 'not_authorized'
    assert claim(user='')['reason'] == 'not_authenticated'
    q(f"UPDATE clubs SET lobby_message='Changed News',message_revision=3 WHERE id='{C}';")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: claim(), range(2)))
    assert sum(r['should_show'] for r in results) == 1
    q(f"INSERT INTO club_announcements(id,club_id,title,content) VALUES ('{POST}','{C}','Title','Body');")
    assert len(claim()['announcements']) == 1
    assert claim()['announcements'] == []
    q(f"UPDATE club_announcements SET is_pinned=true WHERE id='{POST}';")
    assert claim()['announcements'] == []
    q(f"UPDATE club_announcements SET content='Edited Body' WHERE id='{POST}';")
    assert claim()['announcements'][0]['content'] == 'Edited Body'
    q(f"UPDATE club_announcements SET content='Body' WHERE id='{POST}';")
    assert len(claim()['announcements']) == 1  # edited back is still changed copy
    q(f"UPDATE club_announcements SET content='Hidden',is_active=false WHERE id='{POST}';")
    assert claim()['announcements'] == []
    q(f"UPDATE club_announcements SET is_active=true,expires_at=now()-interval '1 day' WHERE id='{POST}';")
    assert claim()['announcements'] == []
    q(f"UPDATE club_announcements SET expires_at=null WHERE id='{POST}';")
    assert len(claim()['announcements']) == 1
    q(f"UPDATE clubs SET lobby_message='Legacy Dismissed',message_revision=4 WHERE id='{C}'; INSERT INTO club_message_dismissals VALUES ('{U}','{C}',4);")
    assert claim()['should_show'] is False
    assert q("SELECT has_function_privilege('anon','fn_claim_club_entry_news(uuid)','EXECUTE')") == 'f'
    assert q("SELECT has_table_privilege('authenticated','club_entry_news_receipts','INSERT')") == 'f'
    assert q(f"SET SESSION AUTHORIZATION authenticated; SET request.jwt.claim.sub='{U}'; SELECT count(*) FROM club_entry_news_receipts WHERE user_id<>'{U}';") == '0'
    print('PASS: baseline replay; once across days/devices; changed/unchanged/cleared copy; concurrent claims; announcements create/edit/pin/hide/expiry; prior dismissals; auth/RLS/ACL')
finally:
    if started:
        run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
    shutil.rmtree(cluster)
