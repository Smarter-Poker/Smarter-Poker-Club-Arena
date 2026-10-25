"""Native PostgreSQL proof for unread ordering and certification inbox isolation."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/fixtures/messenger-inbox-equipment'
MIGRATION = ROOT / 'supabase/migrations/20261025185834_messenger_excludes_certification_conversations.sql'
RETIREMENT = ROOT / 'supabase/migrations/20261025201533_messenger_hides_soft_deleted_counterpart_profiles.sql'
PG = Path(os.environ.get('PG_BIN', '/usr/lib/postgresql/17/bin'))
OWNER = ['runuser', '-u', 'postgres', '--'] if os.geteuid() == 0 else []
ENV = dict(os.environ, LC_ALL='C')


def command(args, sql=None, check=True):
    result = subprocess.run([str(arg) for arg in args], input=sql, text=True,
                            capture_output=True, env=ENV, timeout=60)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


with tempfile.TemporaryDirectory(prefix='msg-inbox-') as directory:
    scratch = Path(directory)
    if OWNER:
        shutil.chown(scratch, 'postgres')
    cluster = scratch / 'db'
    command(OWNER + [PG / 'initdb', '-D', cluster, '-U', 'postgres', '-A', 'trust', '--no-locale'])
    command(OWNER + [PG / 'pg_ctl', '-D', cluster, '-l', scratch / 'pg.log',
                    '-o', f"-p 56426 -k {scratch} -c listen_addresses=''", 'start'])
    psql = [PG / 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', scratch,
            '-p', '56426', '-U', 'postgres', '-d', 'postgres']
    try:
        for filename in ['schema.sql', 'production-inbox.sql', 'fixtures.sql']:
            command(psql, (FIXTURE / filename).read_text())
        assertions = (FIXTURE / 'assertions.sql').read_text()
        before = command(psql, assertions, check=False)
        assert before.returncode != 0 and 'Unread first and certification isolation failed' in before.stderr
        state = "SELECT json_build_array((SELECT count(*) FROM profiles),(SELECT count(*) FROM social_messages),(SELECT json_agg(p) FROM social_conversation_participants p))::text;"
        original = command(psql, state).stdout
        command(psql, MIGRATION.read_text())
        command(psql, assertions)
        assert command(psql, state).stdout == original, 'Projection changed stored users/messages/read boundaries'
        # A stale source cannot be silently overwritten or replayed.
        replay = command(psql, MIGRATION.read_text(), check=False)
        assert replay.returncode != 0 and 'preimage changed' in replay.stderr
        command(psql, assertions)
        # Hidden and deleted messages cannot manufacture unread state.
        command(psql, "INSERT INTO messenger_hidden_messages SELECT '10000000-0000-4000-8000-000000000001',id FROM social_messages WHERE conversation_id='20000000-0000-4000-8000-000000000003';")
        result = command(psql, "SET test.actor='10000000-0000-4000-8000-000000000001'; SELECT sum(unread_count) FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',null);")
        assert result.stdout.strip() == '0', result.stdout
        command(psql, 'DELETE FROM messenger_hidden_messages; UPDATE social_messages SET is_deleted=true;')
        result = command(psql, "SET test.actor='10000000-0000-4000-8000-000000000001'; SELECT sum(unread_count) FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',null);")
        assert result.stdout.strip() == '0', result.stdout
        # Group visibility is not decided by any one member's equipment status.
        command(psql, "INSERT INTO social_conversations VALUES('20000000-0000-4000-8000-000000000004','Staff',true,now()); INSERT INTO social_conversation_participants(conversation_id,user_id) VALUES('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002'); INSERT INTO social_messages VALUES('20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000002',false,now());")
        result = command(psql, "SET test.actor='10000000-0000-4000-8000-000000000001'; SELECT count(*) FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',null) WHERE is_group;")
        assert result.stdout.strip() == '1', result.stdout
        # A personal inbox cannot reveal a thread from a club context.
        command(psql, "UPDATE social_conversation_participants SET context_entity_id='30000000-0000-4000-8000-000000000001' WHERE conversation_id='20000000-0000-4000-8000-000000000003';")
        result = command(psql, "SET test.actor='10000000-0000-4000-8000-000000000001'; SELECT count(*) FROM fn_get_user_conversations('10000000-0000-4000-8000-000000000001',null) WHERE conversation_id='20000000-0000-4000-8000-000000000003';")
        assert result.stdout.strip() == '0', result.stdout
        # A separate database reproduces live ledger-backed identity retirement:
        # the profile survives but the reserved certification email is gone.
        command(psql, 'CREATE DATABASE retired_case;')
        retired_psql = [*psql[:-1], 'retired_case']
        for filename in ['schema.sql', 'installed-inbox-pre-retirement.sql', 'fixtures.sql', 'retired-counterparts.sql']:
            command(retired_psql, (FIXTURE / filename).read_text())
        retired_assertions = (FIXTURE / 'retired-assertions.sql').read_text()
        before = command(retired_psql, retired_assertions, check=False)
        assert before.returncode != 0 and 'Retired counterpart remains visible' in before.stderr
        retired_state = state + " SELECT json_agg(u ORDER BY id)::text FROM auth.users u; SELECT json_build_array(proowner,proacl,prosecdef,provolatile,proconfig)::text FROM pg_proc WHERE oid='public.fn_get_user_conversations(uuid,uuid)'::regprocedure;"
        original = command(retired_psql, retired_state).stdout
        command(retired_psql, RETIREMENT.read_text())
        command(retired_psql, retired_assertions)
        assert command(retired_psql, retired_state).stdout == original, 'Retirement projection mutated stored history or identities'
        replay = command(retired_psql, RETIREMENT.read_text(), check=False)
        assert replay.returncode != 0 and 'preimage changed' in replay.stderr
        command(retired_psql, retired_assertions)
        print('PASS: both live preimages reproduce their defects; candidates isolate active equipment and retired counterparts, retain genuine names/groups/history, preserve unread semantics and refuse stale replay.')
    finally:
        command(OWNER + [PG / 'pg_ctl', '-D', cluster, '-m', 'immediate', 'stop'])
