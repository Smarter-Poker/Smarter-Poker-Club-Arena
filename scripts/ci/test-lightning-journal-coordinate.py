#!/usr/bin/env python3
"""Actual Lightning formation -> physical accepted-hand storage -> private lease replay.
Uses the maintained socket-only Phase6 estate. No production writes/connections.
"""
import hashlib,json,os,pathlib,re,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2];M=ROOT/'supabase/migrations'
MIG=M/'20261025200552_lightning_retains_the_original_private_journal_coordinate.sql'
BEFORE=ROOT/'scripts/ci/fixtures/lightning-journal-settle-before.sql'
OUT=ROOT/'work/lightning-journal-coordinate';OUT.mkdir(parents=True,exist_ok=True)
stats=(M/'20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql').read_text()
validator=re.search(r'CREATE FUNCTION public\.fn_lightning_hand_stats_facts\(.*?\$function\$;',stats,re.S).group()
old_stats=(M/'20260821_ca_hand_facts.sql').read_text()
stats_tables='\n'.join(re.search(r'CREATE TABLE public\.'+name+r' \(.*?\n\);',old_stats,re.S).group() for name in ['ca_hand_facts','ca_hand_transfers'])+'\nALTER TABLE ca_hand_facts ADD COLUMN four_bet boolean NOT NULL DEFAULT false;'
patch=re.search(r'DO \$journal_coordinate\$.*?END \$journal_coordinate\$;',MIG.read_text(),re.S).group()
setup=f"""
ALTER TABLE public.lightning_hand_player ADD COLUMN IF NOT EXISTS showed boolean;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(version text PRIMARY KEY);
CREATE OR REPLACE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE OR REPLACE FUNCTION fn_active_maintenance_release_boundary() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
{stats_tables}
{validator}
\\i {BEFORE}
DO $$BEGIN IF md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure))<>'d66cc7cdcfd286fbed16127a6798931d' THEN RAISE EXCEPTION 'actual current preimage mismatch';END IF;END$$;
CREATE TABLE harness.journal_case(k text PRIMARY KEY,game uuid,hand_id uuid,request_id uuid,results jsonb,original_lease uuid,hand_row jsonb,rake numeric,bbj numeric);
CREATE FUNCTION harness.journal_case(p_key text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g uuid;ids uuid[];f jsonb;h uuid;gen uuid;
BEGIN
 g:=harness.cluster('journal '||p_key);
 SELECT array_agg(player_id ORDER BY player_id) INTO ids FROM (SELECT player_id FROM lightning_pool_session WHERE cluster_id=g AND exited_at IS NULL ORDER BY player_id LIMIT 4) q;
 f:=harness.form(g,ids);h:=(f->>'hand_id')::uuid;PERFORM harness.deal((f->>'instance_id')::uuid);
 SELECT lease_generation INTO gen FROM engine_table_leases WHERE table_id=(SELECT host_table_id FROM lightning_hand WHERE hand_id=h);
 INSERT INTO harness.journal_case VALUES(p_key,g,h,gen_random_uuid(),
 CASE WHEN p_key='first' THEN harness.results(h,jsonb_build_object(ids[1]::text,jsonb_build_object('d',.09,'c',.14),ids[2]::text,jsonb_build_object('d',-.14,'c',.14))) ELSE harness.results(h,'{{}}'::jsonb) END,gen,
 CASE WHEN p_key='first' THEN jsonb_build_object('pot_size',.28,'big_blind',.04,'small_blind',.02) ELSE '{{}}'::jsonb END,
 CASE WHEN p_key='first' THEN .03 ELSE 0 END,CASE WHEN p_key='first' THEN .02 ELSE 0 END);

 UPDATE harness.journal_case c SET hand_row=jsonb_set(c.hand_row,'{{_accepted_post_commit_facts}}',jsonb_build_object('stats_facts',jsonb_build_object('version',1,'transfers','[]'::jsonb,'facts',(
 SELECT jsonb_agg(jsonb_build_object('hand_id',c.hand_id,'user_id',hp.player_id,'club_id',t.club_id,'table_id',t.id,'played_at','2026-10-25T12:00:00Z','game_variant','nlh','big_blind',.04,'position','BB','players_dealt',4,'invested',0,'returned',0,'net',0,'net_bb',0,'rake_paid',0,'aggressive_actions',0,'passive_actions',0,'ev_net',0,'ev_net_bb',0)
 ||(SELECT jsonb_object_agg(flag,false) FROM unnest(ARRAY['vpip','pfr','three_bet','four_bet','faced_three_bet','folded_to_three_bet','had_cbet_flop_opp','cbet_flop','saw_flop','went_to_showdown','won_at_showdown','was_all_in']) flag) ORDER BY hp.player_id)
 FROM lightning_hand_player hp JOIN lightning_hand lh ON lh.hand_id=hp.hand_id JOIN tables t ON t.id=lh.host_table_id WHERE hp.hand_id=c.hand_id)))) WHERE c.k=p_key;
END$$;
SELECT harness.journal_case('first');
UPDATE harness.journal_case SET hand_row=jsonb_set(hand_row,'{{_accepted_post_commit_facts,horse_journal_identity}}',jsonb_build_object('version',1,'lease_generation','00000000-0000-0000-0000-00000000ffff')) WHERE k='first';
-- Paired EXACT same original case: preimage settles and processes in a rolled-back
-- transaction; candidate then settles the unchanged case and must match all financial state.
CREATE FUNCTION harness.journal_snapshot() RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'anchors',(SELECT jsonb_agg(jsonb_build_object('id',ts.id,'user',ts.user_id,'stack',ts.stack,'uses',ts.time_bank_uses_remaining,'seconds',ts.time_bank_remaining) ORDER BY ts.id) FROM table_seats ts JOIN lightning_pool_session ps ON ps.anchor_seat_id=ts.id WHERE ps.cluster_id=c.game),
 'players',(SELECT jsonb_agg(jsonb_build_object('player',player_id,'before',stack_before,'after',stack_after,'net',net_result,'fold',fold_type,'showed',showed) ORDER BY player_id) FROM lightning_hand_player WHERE hand_id=c.hand_id),
 'sessions',(SELECT jsonb_agg(jsonb_build_object('id',id,'hands',hands,'fast',fast_folds,'normal',normal_folds,'watch',fold_and_watch,'showdowns',showdowns,'net',net_result) ORDER BY id) FROM lightning_pool_session WHERE cluster_id=c.game),
 'slots',(SELECT jsonb_agg(jsonb_build_object('id',sl.id,'hands',sl.hands,'fast',sl.fast_folds,'normal',sl.normal_folds,'watch',sl.fold_and_watch,'showdowns',sl.showdowns) ORDER BY sl.id) FROM lightning_pool_slot sl JOIN lightning_pool_session ps ON ps.id=sl.pool_session_id WHERE ps.cluster_id=c.game),
 'reservations',(SELECT jsonb_agg(jsonb_build_object('player',player_id,'state',state) ORDER BY player_id) FROM lightning_reservation WHERE lightning_instance_id=(SELECT lightning_instance_id FROM lightning_hand WHERE hand_id=c.hand_id)),
 'instance',(SELECT state FROM lightning_instance WHERE id=(SELECT lightning_instance_id FROM lightning_hand WHERE hand_id=c.hand_id)),
 'markers',(SELECT count(*) FROM lightning_settlement_marker WHERE hand_id=c.hand_id),
 'receipt',(SELECT settle_receipt-ARRAY['commit_hash','post_commit_payload_hash','receipt_hash'] FROM lightning_hand WHERE hand_id=c.hand_id),
 'accepted',(SELECT post_commit_payload#- '{{accepted_hand_facts,horse_journal_identity}}' FROM hand_atomic_commits WHERE hand_id=(SELECT hand_history_id FROM lightning_hand WHERE hand_id=c.hand_id)),
 'rake',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.hand_id) FROM harness.rake_calls r WHERE r.hand_id=c.hand_id),
 'promo',(SELECT jsonb_agg(to_jsonb(p) ORDER BY user_id,wagered) FROM harness.promo_calls p WHERE user_id IN(SELECT player_id FROM lightning_hand_player WHERE hand_id=c.hand_id)),
 'settlement',(SELECT jsonb_agg(jsonb_build_object('state',state,'totals',totals,'key',idempotency_key,'ref',external_ref) ORDER BY external_ref) FROM ca_settlements WHERE hand_id=c.hand_id),
 'rebases',(SELECT jsonb_agg(jsonb_build_object('user',user_id,'before',engine_before,'db',db_before,'after',engine_after,'written',written,'amount',amount) ORDER BY user_id) FROM ca_seat_stack_rebases WHERE hand_id=c.hand_id))
 FROM harness.journal_case c WHERE c.k='first'
$$;
BEGIN;
SELECT harness.settle(hand_id,request_id,results,rake,bbj,hand_row) FROM harness.journal_case WHERE k='first';
SELECT fn_ca_process_hand_post_commit_obligations(hand_history_id) FROM lightning_hand WHERE hand_id=(SELECT hand_id FROM harness.journal_case WHERE k='first');
SELECT harness.journal_snapshot() AS snapshot \\gset original_
ROLLBACK;
CREATE TABLE harness.journal_expected(snapshot jsonb);
INSERT INTO harness.journal_expected VALUES(:'original_snapshot'::jsonb);
\\i {MIG}
DO $first$
DECLARE c record;r jsonb;again jsonb;env jsonb;stored jsonb;saved text;hh uuid;hash text;
BEGIN
 SELECT * INTO c FROM harness.journal_case WHERE k='first';
 r:=harness.settle(c.hand_id,c.request_id,c.results,c.rake,c.bbj,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'true' OR r->>'accepted_lease_generation' IS DISTINCT FROM c.original_lease::text THEN RAISE EXCEPTION 'first response lost original lease:%',r;END IF;
 hh:=(r->>'hand_history_id')::uuid;
 IF fn_ca_process_hand_post_commit_obligations(hh)->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'candidate postcommit processing refused';END IF;
 IF harness.journal_snapshot() IS DISTINCT FROM (SELECT snapshot FROM harness.journal_expected) THEN RAISE EXCEPTION 'paired original/candidate complete financial snapshot differs: before%,after%',(SELECT snapshot FROM harness.journal_expected),harness.journal_snapshot();END IF;
 SELECT post_commit_payload INTO STRICT env FROM hand_atomic_commits WHERE hand_id=hh;
 IF env#>'{{accepted_hand_facts,stats_facts}}' IS DISTINCT FROM c.hand_row#>'{{_accepted_post_commit_facts,stats_facts}}' THEN RAISE EXCEPTION 'accepted stats facts were dropped or changed';END IF;
 IF (env#>>'{{rake,amount}}')::numeric<>.03 OR (env#>>'{{bbj_contribution,amount}}')::numeric<>.02 THEN RAISE EXCEPTION 'nonzero physical fees changed';END IF;
 IF c.original_lease='00000000-0000-0000-0000-00000000ffff'::uuid THEN RAISE EXCEPTION 'fixture forgery must differ from validated lease';END IF;
 IF env#>'{{accepted_hand_facts,horse_journal_identity}}' IS DISTINCT FROM jsonb_build_object('version',1,'lease_generation',c.original_lease) THEN RAISE EXCEPTION 'actual physical private storage lost identity:%',env;END IF;
 IF EXISTS(SELECT FROM hand_history h WHERE h.id=hh AND to_jsonb(h)::text LIKE '%horse_journal_identity%') THEN RAISE EXCEPTION 'private metadata leaked to public history';END IF;
 SELECT settle_receipt,settle_request_hash INTO stored,hash FROM lightning_hand WHERE hand_id=c.hand_id;
 IF stored ? 'accepted_lease_generation' OR stored::text LIKE '%horse_journal_identity%' THEN RAISE EXCEPTION 'private metadata leaked into stored receipt';END IF;
 saved:=harness.stacks(c.game);
 UPDATE engine_table_leases SET lease_generation=gen_random_uuid() WHERE table_id=(SELECT host_table_id FROM lightning_hand WHERE hand_id=c.hand_id);
 again:=harness.settle(c.hand_id,c.request_id,c.results,c.rake,c.bbj,c.hand_row);
 IF again->>'ok' IS DISTINCT FROM 'true' OR again->>'replay' IS DISTINCT FROM 'true' OR again->>'accepted_lease_generation' IS DISTINCT FROM c.original_lease::text OR (again-ARRAY['replay','accepted_lease_generation']) IS DISTINCT FROM stored THEN RAISE EXCEPTION 'replay did not use original receipt:%',again;END IF;
 IF harness.stacks(c.game) IS DISTINCT FROM saved OR (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=hh)<>1 OR (SELECT settle_receipt FROM lightning_hand WHERE hand_id=c.hand_id) IS DISTINCT FROM stored OR (SELECT settle_request_hash FROM lightning_hand WHERE hand_id=c.hand_id) IS DISTINCT FROM hash THEN RAISE EXCEPTION 'replay changed settlement or hash';END IF;
 -- Simulate only a legacy receipt in this isolated fixture; no production backfill.
 UPDATE hand_atomic_commits SET post_commit_payload=post_commit_payload#- '{{accepted_hand_facts,horse_journal_identity}}' WHERE hand_id=hh;
 again:=harness.settle(c.hand_id,c.request_id,c.results,c.rake,c.bbj,c.hand_row);
 IF again->>'ok' IS DISTINCT FROM 'true' OR again->'accepted_lease_generation' IS DISTINCT FROM 'null'::jsonb OR harness.stacks(c.game) IS DISTINCT FROM saved THEN RAISE EXCEPTION 'legacy receipt was invented or refused:%',again;END IF;
END $first$;
\\echo 'PASS journal: paired same-input full financial state and accepted stats preservation, forged caller identity overridden, actual physical private storage, optional handRow number absent, privacy, original lease replay, stored hash/receipt/money unchanged, legacy null'
SELECT harness.journal_case('concurrent');
CREATE EXTENSION IF NOT EXISTS dblink;
DO $concurrent$
DECLARE conn text:='host='||current_setting('unix_socket_directories')||' port='||current_setting('port')||' dbname='||current_database(); query text;r jsonb;replies jsonb[]:=ARRAY[]::jsonb[];c record;
BEGIN
 SELECT * INTO c FROM harness.journal_case WHERE k='concurrent';
 query:=format('SELECT harness.settle(%L,%L,%L::jsonb,%L::numeric,%L::numeric,%L::jsonb)',c.hand_id,c.request_id,c.results,c.rake,c.bbj,c.hand_row);
 PERFORM harness.dblink_connect('journal_a',conn);PERFORM harness.dblink_connect('journal_b',conn);
 PERFORM harness.dblink_send_query('journal_a',query);PERFORM harness.dblink_send_query('journal_b',query);
 SELECT answer INTO r FROM harness.dblink_get_result('journal_a') AS x(answer jsonb);replies:=array_append(replies,r);
 SELECT answer INTO r FROM harness.dblink_get_result('journal_b') AS x(answer jsonb);replies:=array_append(replies,r);
 PERFORM harness.dblink_disconnect('journal_a');PERFORM harness.dblink_disconnect('journal_b');
 IF EXISTS(SELECT FROM unnest(replies)x WHERE x->>'ok' IS DISTINCT FROM 'true' OR x->>'accepted_lease_generation' IS DISTINCT FROM c.original_lease::text) OR (SELECT count(*) FROM unnest(replies)x WHERE x->>'replay'='true')<>1 THEN RAISE EXCEPTION 'concurrent first settlement lost originalidentity:%',replies;END IF;
 IF (SELECT count(*) FROM hand_atomic_commits WHERE hand_id=(replies[1]->>'hand_history_id')::uuid)<>1 THEN RAISE EXCEPTION 'concurrent duplicate physical commit';END IF;
 -- The first acknowledgement can be discarded; original storage still recovers it.
 UPDATE engine_table_leases SET lease_generation=gen_random_uuid() WHERE table_id=(SELECT host_table_id FROM lightning_hand WHERE hand_id=c.hand_id);
 r:=harness.settle(c.hand_id,c.request_id,c.results,c.rake,c.bbj,c.hand_row);
 IF r->>'accepted_lease_generation' IS DISTINCT FROM c.original_lease::text OR r->>'replay' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'unknown-ack recovery used current lease';END IF;
 r:=harness.settle(c.hand_id,gen_random_uuid(),c.results,c.rake,c.bbj,c.hand_row);
 IF r->>'ok' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'different request accepted';END IF;
END $concurrent$;
\\echo 'PASS journal: concurrent first commit, unknown acknowledgement recovery, different request refusal'
DO $guard$
DECLARE message text;
BEGIN
 IF has_function_privilege('anon','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','execute') OR has_function_privilege('authenticated','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','execute') OR NOT has_function_privilege('service_role','public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)','execute') THEN RAISE EXCEPTION 'settlement ACL changed';END IF;
 BEGIN
  EXECUTE $candidate${patch}$candidate$;
  RAISE EXCEPTION 'migration unexpectedly replayed';
 EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  IF message NOT LIKE 'lightning_private_journal_preimage_changed:%' THEN RAISE;END IF;
 END;
END $guard$;
\\echo 'PASS journal: original ACL and exact preimage replay refusal'
"""
with tempfile.TemporaryDirectory(prefix='ljournal-',dir=os.environ.get('TMPDIR',str(ROOT/'work'))) as work:
 follow=pathlib.Path(work)/'followup.sql';follow.write_text(setup)
 env=dict(os.environ,LIGHTNING_P6S_FOLLOWUP_SQL=str(follow))
 result=subprocess.run(['bash',str(ROOT/'scripts/dev/test-lightning-phase6-settlement.sh')],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
 (OUT/'native.log').write_text(result.stdout)
 print(result.stdout[-10000:])
 ok=result.returncode==0 and result.stdout.count('PASS journal:')==3
 (OUT/'RESULTS.json').write_text(json.dumps({'passed':ok,'exit_code':result.returncode,'journal_sections':result.stdout.count('PASS journal:'),'migration_sha256':hashlib.sha256(MIG.read_bytes()).hexdigest(),'preimage_fixture_sha256':hashlib.sha256(BEFORE.read_bytes()).hexdigest(),'production_mutations':False,'scope':'Maintained real Phase6 physical settlement estate plus exact current Lightning producer; original private storage, privacy, lease replay/concurrency/legacy and ACL checks'},indent=2)+'\n')
 if not ok:raise SystemExit(result.returncode or 1)
