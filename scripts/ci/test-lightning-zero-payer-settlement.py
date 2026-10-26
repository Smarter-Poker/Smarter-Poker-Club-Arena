"""Real PostgreSQL chain: a raked Lightning hand includes zero payers.

No production connection. Rebuild the installed producer from its maintained
migrations, reproduce its refusal through the real physical settlement door,
then install the candidate and settle/replay that same refused hand exactly once.
"""
import os
import pathlib
import re
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
M = ROOT / 'supabase/migrations'
SIG = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'
CANDIDATE = M / '20261018230728_lightning_settlement_names_zero_contribution_dealt_players.sql'


def one(pattern):
    rows = list(M.glob(pattern))
    assert len(rows) == 1, rows
    return rows[0].read_text()


base = one('20261001154813_lightning_phase_6_settlement_the_hand_settles_onto_its_ancho.sql')
definition = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_lightning_settle_hand\(.*?AS \$function\$.*?\$function\$;', base, re.S).group()
remediation = one('20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql')
block = re.search(r'DO \$sub_settle\$(.*?)\$sub_settle\$;', remediation, re.S).group(1)
pairs = list(zip(re.findall(r'\$a\$(.*?)\$a\$', block.split('b text[] := ARRAY[')[0], re.S),
                 re.findall(r'\$b\$(.*?)\$b\$', block.split('b text[] := ARRAY[')[1].split('c integer[]')[0], re.S)))
phase8 = one('20261007212735_lightning_phase_8_multi_table_limits_session_statistics_pool.sql')
block = re.search(r"SELECT pg_temp\.lp8_rewrite\(\s*'public\.fn_lightning_settle_hand\(.*?ARRAY\[1\]\);", phase8, re.S).group()
pairs += list(zip(re.findall(r'\$a\$(.*?)\$a\$', block, re.S), re.findall(r'\$b\$(.*?)\$b\$', block, re.S)))
assert len(pairs) == 3
for old, new in pairs:
    assert definition.count(old) == 1
    definition = definition.replace(old, new)

patch_block = re.search(r'DO \$patch\$.*?END \$patch\$;', CANDIDATE.read_text(), re.S).group()

setup = f"""
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS showed boolean;
{definition}
\\i {M / '20261015222121_a_lightning_hand_counts_every_player_dealt_in.sql'}
DO $owner$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres LOGIN SUPERUSER; END IF;
END $owner$;
ALTER FUNCTION {SIG} OWNER TO postgres;
REVOKE ALL ON FUNCTION {SIG} FROM PUBLIC;
GRANT EXECUTE ON FUNCTION {SIG} TO service_role;
SET SESSION AUTHORIZATION postgres;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
CREATE TABLE harness.zero_payer_case(game uuid,hand_id uuid,request_id uuid,results jsonb,hand_row jsonb,before_stacks text);
DO $baseline$
DECLARE g uuid;f jsonb;h uuid;ids uuid[];spec jsonb;r jsonb;req uuid:=gen_random_uuid();saved text;
BEGIN
 IF md5(pg_get_functiondef('{SIG}'::regprocedure))<>'0432654c1fd742eeedb2920140cda3b5' THEN RAISE EXCEPTION 'wrong installed producer baseline'; END IF;
 g:=harness.cluster('zero payer real physical path');
 SELECT array_agg(player_id ORDER BY player_id) INTO ids FROM (SELECT player_id FROM lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL ORDER BY player_id LIMIT 4) q;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 spec:=jsonb_build_object(ids[1]::text,jsonb_build_object('d',.09,'c',.14),ids[2]::text,jsonb_build_object('d',-.14,'c',.14),ids[3]::text,jsonb_build_object('d',0,'c',0,'f','fast'),ids[4]::text,jsonb_build_object('d',0,'c',0,'f','fast'));
 saved:=harness.stacks(g);
 INSERT INTO harness.zero_payer_case VALUES(g,h,req,harness.results(h,spec),jsonb_build_object('pot_size',.28,'big_blind',.04,'small_blind',.02),saved);
 r:=harness.settle(h,req,harness.results(h,spec),.03,.02,jsonb_build_object('pot_size',.28,'big_blind',.04,'small_blind',.02));
 IF r->>'reason'<>'physical_settlement_refused' OR r->>'detail'<>'atomic hand commit refused (post_commit_fee_mismatch)' THEN RAISE EXCEPTION 'baseline did not reproduce exact live refusal: %',r; END IF;
 IF harness.stacks(g) IS DISTINCT FROM saved OR EXISTS(SELECT FROM lightning_hand WHERE hand_id=h AND (settled_at IS NOT NULL OR hand_history_id IS NOT NULL OR settle_receipt IS NOT NULL)) THEN RAISE EXCEPTION 'refusal moved chips or wrote history'; END IF;
END $baseline$;
\\echo 'PASS: baseline reproduces the exact native fee mismatch and rolls back whole'
\\i {CANDIDATE}
DO $after$
DECLARE c record;r jsonb;again jsonb;env jsonb;saved text;hh uuid;post jsonb;
BEGIN
 SELECT * INTO STRICT c FROM harness.zero_payer_case;
 r:=harness.settle(c.hand_id,c.request_id,c.results,.03,.02,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'corrected native settlement refused: %',r; END IF;
 hh:=(r->>'hand_history_id')::uuid;
 SELECT post_commit_payload INTO STRICT env FROM hand_atomic_commits WHERE hand_id=hh;
 IF (env->'rake'->>'num_players')::integer<>4 OR (SELECT count(*) FROM jsonb_object_keys(env->'rake'->'contributions'))<>4 OR (SELECT count(*) FROM jsonb_each(env->'rake'->'contributions') WHERE value::text::numeric=0)<>2 THEN RAISE EXCEPTION 'dealt map/count lost zero payers: %',env; END IF;
 IF jsonb_array_length(env->'promo_playthrough')<>2 OR EXISTS(SELECT FROM jsonb_array_elements(env->'promo_playthrough') x WHERE (x->>'wagered')::numeric<=0) THEN RAISE EXCEPTION 'promo credited a zero payer'; END IF;
 IF (env->'rake'->>'amount')::numeric<>.03 OR (env->'bbj_contribution'->>'amount')::numeric<>.02 THEN RAISE EXCEPTION 'fees changed'; END IF;
 IF EXISTS(SELECT FROM lightning_hand_player WHERE hand_id=c.hand_id AND stack_after IS DISTINCT FROM stack_before+(SELECT (x->>'stack_after')::numeric-hp.stack_before FROM jsonb_array_elements(c.results) x JOIN lightning_hand_player hp ON hp.hand_id=c.hand_id AND hp.player_id=(x->>'player_id')::uuid WHERE hp.player_id=lightning_hand_player.player_id)) THEN RAISE EXCEPTION 'settled player result mismatch'; END IF;
 post:=public.fn_ca_process_hand_post_commit_obligations(hh);
 IF post->>'ok' IS DISTINCT FROM 'true' OR (post->>'promo_playthrough')::integer<>2 OR (SELECT count(*) FROM harness.rake_calls WHERE hand_id=hh AND num_players=4 AND contributions=env->'rake'->'contributions')<>1 THEN RAISE EXCEPTION 'post-commit writer lost the dealt map or positive-only promo: %',post; END IF;
 IF public.fn_ca_process_hand_post_commit_obligations(hh)->>'already_completed' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'post-commit replay not idempotent'; END IF;
 saved:=harness.stacks(c.game);
 again:=harness.settle(c.hand_id,c.request_id,c.results,.03,.02,c.hand_row);
 IF again->>'ok' IS DISTINCT FROM 'true' OR again->>'replay' IS DISTINCT FROM 'true' OR harness.stacks(c.game) IS DISTINCT FROM saved OR (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=hh)<>1 THEN RAISE EXCEPTION 'duplicate settled twice: %',again; END IF;
 again:=harness.settle(c.hand_id,gen_random_uuid(),c.results,.03,.02,c.hand_row);
 IF again->>'ok' IS DISTINCT FROM 'false' OR harness.stacks(c.game) IS DISTINCT FROM saved THEN RAISE EXCEPTION 'conflicting request was accepted'; END IF;
 IF md5(pg_get_functiondef('{SIG}'::regprocedure))<>'0670ed75762f05e7ad3346a1c95e84dc' THEN RAISE EXCEPTION 'wrong installed candidate hash'; END IF;
 IF has_function_privilege('anon','{SIG}','EXECUTE') OR has_function_privilege('authenticated','{SIG}','EXECUTE') OR NOT has_function_privilege('service_role','{SIG}','EXECUTE') THEN RAISE EXCEPTION 'settlement ACL changed'; END IF;
END $after$;
DO $reapply$
DECLARE msg text;
BEGIN
 BEGIN
  EXECUTE $candidate${patch_block}$candidate$;
  RAISE EXCEPTION 'candidate unexpectedly replayed';
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS msg=MESSAGE_TEXT;
  IF msg NOT LIKE 'lightning_settlement_preimage_refused:%' THEN RAISE; END IF;
 END;
END $reapply$;
\\echo 'PASS: Madness zero-payer real settlement, positive-only promo, conservation, replay, conflict, ACL and reapply'
"""
refund_files = list(M.glob('*_lightning_folded_players_keep_their_uncalled_blind_refund.sql'))
assert len(refund_files) == 1, refund_files
setup += f"\n\\set refund_migration {refund_files[0]}\n\\i {ROOT / 'scripts/ci/fixtures/lightning-folded-uncalled-refund.sql'}\n"

with tempfile.TemporaryDirectory(prefix='lp6-zero-') as work:
    followup = pathlib.Path(work) / 'followup.sql'
    followup.write_text(setup)
    socket = os.environ.get('LIGHTNING_ZERO_PAYER_SOCKET')
    if socket:
        # The required Phase 6 accounting step owns this already-qualified
        # disposable database. Keep the regression in that same native chain.
        pg = pathlib.Path(os.environ['PG_BIN'])
        command = [str(pg / 'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                   '-h', socket, '-p', os.environ['LIGHTNING_ZERO_PAYER_PORT'],
                   '-d', 'postgres', '-f', str(followup)]
        env = os.environ.copy()
    else:
        # Explicit standalone invocation uses the very same owner and chain.
        command = ['bash', str(ROOT / 'scripts/dev/test-lightning-phase6-settlement.sh')]
        env = dict(os.environ, LIGHTNING_P6S_FOLLOWUP_SQL=str(followup))
    result = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=180)
    print(result.stdout)
    if result.returncode or 'PASS: Madness zero-payer real settlement' not in result.stdout:
        raise SystemExit(result.returncode or 1)
