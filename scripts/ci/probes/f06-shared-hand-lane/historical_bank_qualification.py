"""Exact historical cohort uses ordinary current eligibility once, under native ownership."""
import hashlib
import json
from pathlib import Path
import re
import runpy

def qualify(root,out,cmd,command,run,probe,require,results):
    cohort=json.loads((root/'scripts/ci/probes/f06-historical-bank-loss-cohorts.json').read_text())
    build=runpy.run_path(str(root/'scripts/ci/build-f06-historical-bank-loss.py'))
    service="SET request.jwt.claims='{\"role\":\"service_role\"}';SET app.smarter_data_actor='service';"
    module=(root/'scripts/ci/probes/f06-shared-hand-lane/retired_origin_qualification.py').read_text()
    # Reuse the maintained exact-owner scenario. Its financial amounts are
    # synthetic; only this immutable cohort's user/occupancy identities are real.
    module=module.replace("len(catalog['functions'])==24", "len(catalog['functions'])==29")
    def actual_function(path,name,tag):
        source=(root/path).read_text(); start=source.index('CREATE OR REPLACE FUNCTION public.'+name+'(')
        end=re.search(re.escape('$'+tag+'$')+r'\s*;',source[source.index('AS $'+tag+'$',start)+len(tag)+5:]); end=source.index('AS $'+tag+'$',start)+len(tag)+5+end.end()
        return source[start:end]
    def adapted(name,sql,expected=None,error=None):
        if name=='retired-origin-completion-reply-lost-1401':
            pending=cohort['5a387a75-754a-416e-8fee-b85b15fc2702']['pending_arrivals'][0]
            actor=service+"SET app.smarter_data_actor='tournament-manager';SET app.smarter_tournament_id='5a387a75-754a-416e-8fee-b85b15fc2702';SET app.smarter_tournament_lease_generation='"+str(__import__('uuid').UUID(hashlib.md5(b'origin-successor1401').hexdigest()))+"';"
            move="SELECT fn_move_tournament_player(fixture_origin_t(1401),'"+pending['user_id']+"','"+pending['table_id']+"','"+pending['destination_table_id']+"',2,'"+pending['request_id']+"','live_source')->>'replayed';"
            run('historical-pending-actual-move-lost-reply',actor+move,'false')
            run('historical-pending-actual-move-replay',actor+move,'true')
            run('historical-pending-one-canonical-winner',"SELECT count(*)=1 AND bool_and(stack=45000) FROM tournament_seat_move_receipts WHERE request_id='"+pending['request_id']+"';",'t')
            run('historical-pending-close-original',actor+"SELECT fn_f06_close_break(fixture_origin_t(1401),md5('origin-successor1401')::uuid,'"+pending['break_id']+"')->>'state';",'close_confirmed')
            run('historical-pending-custody-original',actor+"SELECT fn_f06_claim_custody(fixture_origin_t(1401),md5('origin-successor1401')::uuid,'"+pending['break_id']+"',md5('history-pending-custody')::uuid,(SELECT revision FROM smarter_private.f06_operations WHERE break_id='"+pending['break_id']+"'));")
            run('historical-pending-ack-original',actor+"SELECT fn_f06_ack_cleanup(fixture_origin_t(1401),md5('origin-successor1401')::uuid,'"+pending['break_id']+"',md5('history-pending-custody')::uuid,(SELECT revision FROM smarter_private.f06_operations WHERE break_id='"+pending['break_id']+"'),'retired')->>'state';",'acknowledged')
        if name=='retired-origin-original-requests-preserved-1401':
            sql="SELECT (SELECT jsonb_agg(value->>'request_id' ORDER BY value->>'request_id') FROM jsonb_array_elements(expected->'attempts'))=(SELECT jsonb_agg(a.request_id::text ORDER BY a.request_id) FROM smarter_private.f06_attempts a JOIN smarter_private.f06_operations o USING(break_id) WHERE o.tournament_id=fixture_origin_t(1401)) AND (SELECT state='winner' FROM smarter_private.f06_attempts WHERE request_id='48b9a0f7-e40e-4163-845e-1a5244a2dac2') AND (SELECT state='fenced' FROM smarter_private.f06_attempts WHERE request_id='04a81643-7124-41e9-9a76-6111e627c288') FROM fixture_origin_inputs WHERE i=1401;"

        if name=='retired-origin-synthetic-fixtures':
            helpers="CREATE FUNCTION fixture_history_scope(i integer) RETURNS jsonb LANGUAGE sql AS $$SELECT $json$"+json.dumps(cohort)+"$json$::jsonb->fixture_origin_t(i)::text$$;"
            # This helper follows fixture_origin_t creation and precedes the seed.
            pos=sql.index('CREATE FUNCTION fixture_origin_c')
            sql=sql[:pos]+helpers+sql[pos:]
            mapping={"1401:1":"23e84589-611a-44ea-99e1-c51ae7ada6c5","1401:2":"c1b575fb-3efd-43b6-b314-353e1d300aaa",
                "1402:1":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","1402:2":"cb35cc6f-3150-48ce-b7dc-887b6aca8327","1402:4":"f8c8eb13-14a0-4478-8771-7d29e71036ca",
                "1402:5":"c49b2414-97ff-461c-8c20-3c05fe09809b","1402:6":"ae0bc48d-f98c-4b25-a9fa-e3522f986173"}
            helpers="CREATE FUNCTION fixture_history_item(i integer,j integer) RETURNS jsonb LANGUAGE sql AS $$ SELECT e FROM jsonb_array_elements(fixture_history_scope(i)->'occupants') e WHERE e->>'user_id'=($map$"+json.dumps(mapping)+"$map$::jsonb->>(i||':'||j)) $$;"
            pos=sql.index('CREATE FUNCTION fixture_origin_c');sql=sql[:pos]+helpers+sql[pos:]
            for prefix,key in [('user','user_id'),('seat','seat_id'),('occupancy','occupancy_id')]:
                for arg in ['j','(j+4)']:
                    old="md5('rm-"+prefix+"'||i||':'||"+arg+")::uuid"
                    sql=sql.replace(old,"COALESCE((fixture_history_item(i,"+arg+")->>'"+key+"')::uuid,"+old+")")
            sql=sql.replace("WHERE key<>fixture_origin_table(i)::text ORDER BY key", "WHERE key<>fixture_origin_table(i)::text AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fixture_history_scope(i)->'occupants') e WHERE e->>'table_id'=key) ORDER BY key")
            sql=sql.replace(" INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at)\n VALUES", " stamp:=COALESCE((fixture_history_item(i,j)->>'joined_at')::timestamptz,stamp);\n INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at,left_at)\n VALUES",1)
        if name=='retired-origin-two-originals':
            # Fixture import uses the retained historical occupancy IDs. Restore
            # the native immutable-stamp trigger before any authority is tested.
            run('historical-fixture-import-start','ALTER TABLE table_seats DISABLE TRIGGER zzz_stamp_seat_occupancy;')
        if name=='retired-origin-local-capture-shape':
            sql=sql.replace('WHERE tab.tournament_id=fixture_origin_t(i)', "WHERE tab.tournament_id=fixture_origin_t(i) AND fixture_origin_c(i)->'engines' ? tab.id::text")
            sql=sql.replace("o.state<>'acknowledged'", "o.state<>'acknowledged' AND fixture_origin_c(i)->'engines' ? o.source_table_id::text")
        result=run(name,sql,expected,error)
        if name=='retired-origin-two-originals':
            run('historical-full-original-occupancy',"""DO $$DECLARE i integer;e jsonb;n integer; BEGIN FOR i IN 1401..1402 LOOP
             FOR e IN SELECT * FROM jsonb_array_elements(fixture_history_scope(i)->'occupants') LOOP
             IF NOT EXISTS(SELECT 1 FROM table_seats WHERE id=(e->>'seat_id')::uuid) THEN
             SELECT count(*)+1 INTO n FROM table_seats WHERE table_id=(e->>'table_id')::uuid;
             INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
             VALUES((e->>'seat_id')::uuid,(e->>'table_id')::uuid,(e->>'user_id')::uuid,n,1000,(e->>'occupancy_id')::uuid,(e->>'joined_at')::timestamptz);
             INSERT INTO tournament_players VALUES(gen_random_uuid(),fixture_origin_t(i),(e->>'table_id')::uuid,(e->>'user_id')::uuid,n,1000,'playing');
             END IF;END LOOP;END LOOP;END$$;ALTER TABLE table_seats ENABLE TRIGGER zzz_stamp_seat_occupancy;""")
            run('historical-pending-original-import',(root/'scripts/ci/probes/f06-shared-hand-lane/historical-pending-fixture.sql').read_text())
            accepted=json.loads((root/'scripts/ci/probes/f06-shared-hand-lane/historical-pending-accepted.json').read_text())
            for key,table in [('history','hand_history'),('atomic','hand_atomic_commits'),('key','settlement_idempotency_keys'),('settlement','ca_settlements')]:
                run('historical-pending-accepted-'+key,"INSERT INTO "+table+" SELECT * FROM jsonb_populate_record(NULL::"+table+",$json$"+json.dumps(accepted[key])+"$json$::jsonb);")
            # Production registrations carry the elimination outcome columns the
            # transfer guard now reads (chip_count, prize, position, eliminated_at,
            # elimination_sequence); the native table gets them before attestation
            # so the attested rows and the live rows carry the same keys.
            run('historical-registration-outcome-schema',"ALTER TABLE tournament_players ADD COLUMN chip_count numeric DEFAULT 0,ADD COLUMN prize numeric DEFAULT 0,ADD COLUMN position integer,ADD COLUMN eliminated_at timestamptz,ADD COLUMN elimination_sequence bigint;UPDATE tournament_players SET chip_count=chips;")
            run('historical-move-support-schema',"ALTER TABLE table_seats ALTER COLUMN id SET DEFAULT gen_random_uuid();ALTER TABLE table_seats ADD COLUMN leave_pending boolean,ADD COLUMN is_sitting_out boolean,ADD COLUMN is_away boolean,ADD COLUMN sit_out_at timestamptz,ADD COLUMN scheduled_leave_hands integer,ADD COLUMN player_id uuid,ADD COLUMN member_id uuid,ADD COLUMN horse_id uuid,ADD COLUMN auto_rebuy boolean,ADD COLUMN time_bank_remaining numeric,ADD COLUMN time_bank_uses_remaining integer,ADD COLUMN entry_hold jsonb,ADD COLUMN entry_post_agreed boolean;")
            door=(root/'supabase/migrations/20260910051447_the_seat_move_door_the_engine_calls_exists.sql').read_text()
            start=door.index('CREATE TABLE public.tournament_seat_exit_authorizations (');end=door.index('ALTER TABLE public.tournament_seat_exit_authorizations',start)
            run('historical-move-seat-exit-schema',door[start:end])
            run('historical-move-native-authorities',actual_function('supabase/migrations/20260828090000_the_engine_is_a_role_not_the_absence_of_a_user.sql','fn_caller_is_engine','function')+actual_function('supabase/migrations/20260910173147_the_settlement_lane_is_per_tournament_for_rolling_authorities.sql','fn_ca_open_tournament_seat_exit_authority','function')+actual_function('supabase/migrations/20260910051447_the_seat_move_door_the_engine_calls_exists.sql','fn_ca_close_tournament_seat_exit_authority','close_seat_exit_authority')+actual_function('supabase/migrations/20260910051447_the_seat_move_door_the_engine_calls_exists.sql','fn_ca_tournament_seat_move_receipt','move_receipt')+actual_function('supabase/migrations/20260912100322_tournament_break_original_custody_and_hand_authority.sql','fn_move_tournament_player','function'))

        if name=='retired-origin-local-capture-shape':
            run('historical-native-allowance-schema',"""CREATE TABLE profiles(id uuid PRIMARY KEY,is_vip boolean,vip_tier text,vip_expires_at timestamptz);
             CREATE TABLE vip_feature_usage_monthly(user_id uuid,feature text,month text,usage_count integer);
             CREATE TABLE feature_purchases(user_id uuid,feature text,uses_remaining integer,expires_at timestamptz);
             CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT NULL::uuid$$;
             INSERT INTO profiles SELECT DISTINCT (e->>'user_id')::uuid,true,'lifetime',NULL::timestamptz FROM generate_series(1401,1402)i CROSS JOIN LATERAL jsonb_array_elements((fixture_history_scope(i)->'occupants')||(fixture_history_scope(i)->'pending_arrivals'))e;
             INSERT INTO vip_feature_usage_monthly SELECT id,'time_bank_seconds',to_char(now(),'YYYY-MM'),1620 FROM profiles;""")
            allowance=(root/'supabase/migrations/20260907081603_marketplace_phase8_lifetime_vip_unlimited_digital_benefits.sql').read_text()
            allowance=allowance[allowance.index('CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance_v2'):allowance.index('CREATE OR REPLACE FUNCTION public.fn_consume_time_bank')]
            run('historical-native-allowance-authority',allowance)
            forward=runpy.run_path(str(root/'scripts/ci/build-f06-stopped-bank-custody.py'));run('historical-forward-input',forward['render'](root))
            build=runpy.run_path(str(root/'scripts/ci/build-f06-historical-bank-loss.py'));run('historical-install',build['render'](root))
            # Production then applied 20260921040823, which rewrites the two
            # retained-original snapshot functions in place from their installed
            # text and pins the resulting md5 pair of each. Its pre-image census and
            # its proof read production-only rows (the Noon snapshot row, the
            # cohort's reserved permit), so this lane installs the byte-exact
            # predicate plus the self-pinning edit and post-image blocks sliced from
            # the migration file; the post-image raises unless both functions carry
            # exactly the digests production reports.
            noon=(root/'supabase/migrations/20260921040823_only_the_reviewed_noon_hand_may_abort_without_its_hole_cards.sql').read_text()
            noon=noon[noon.index('CREATE OR REPLACE FUNCTION smarter_private.f06_zero_cards_abort_is_inert('):noon.index('END $inert_postimage$;')+len('END $inert_postimage$;')]
            run('historical-noon-only-cards-install','BEGIN;\n'+noon+'\nCOMMIT;')
            run('historical-noon-only-cards-identity',"SELECT string_agg(p.oid::regprocedure::text||' '||md5(prosrc)||' '||md5(pg_get_functiondef(p.oid)),E'\\n' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN (to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'),to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)'));",
                'smarter_private.f06_retained_mtt_abort_snapshot(jsonb) 1339225a48748a2e8cedd9ad882f35d9 269b7f20c326e04788c003f2a8b081ad\nsmarter_private.f06_retired_origin_snapshot(jsonb) af779e9bdaa72cefab1026b6fd236885 f1dc5d4b2a952ebb783e6ae66b844b94')
            # Production then applies 20260921155216, which replaces the prepare RPC
            # with the byte-exact 20260919033536 text carrying interval '245 seconds'
            # in place of '285 seconds' (the 285 s entry threshold less the 40 s
            # checkpoint budget: ~15 s of measured entry, 20 s of work, 5 s of
            # cleanup; the guard and the post-checkpoint certificate hold the same
            # figure). Its pre-image refuses unless the
            # installed body is exactly 3f78b42b..., which this clone holds after
            # the historical install and the noon edit, so the whole transaction is
            # applied as written: pre-image, CREATE OR REPLACE, post-image.
            reserve=(root/'supabase/migrations/20260921155216_the_mixed_custody_prepare_accepts_the_legacy_checkpoint_rese.sql').read_text()
            reserve=reserve[reserve.index('DO $reserve_preimage$'):reserve.index('END $reserve_postimage$;')+len('END $reserve_postimage$;')]
            run('historical-legacy-reserve-install','BEGIN;\n'+reserve+'\nCOMMIT;')
            run('historical-legacy-reserve-identity',"SELECT p.oid::regprocedure::text||' '||md5(prosrc)||' '||md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb)');",
                'fn_f06_prepare_mixed_manager_custody(uuid,uuid,uuid,uuid,jsonb,jsonb) 30ad38da71405fdc960599802310e662 4f20f5a2f6d7249578931bc877869981')
            # Production then applies 20260924225647, which replaces the mixed
            # custody snapshot with the byte-exact 20260919033536 text plus the
            # never-reserved witness (an allocator epoch with no permit row is an
            # engine that dealt nothing in the generation, and is witnessed by that
            # absence under the same locks). Its pre-image refuses unless the
            # installed body is exactly 4e678c1f..., which this clone holds after
            # the historical install, so the whole transaction is applied as
            # written: pre-image, CREATE OR REPLACE, post-image.
            never=(root/'supabase/migrations/20260924225647_an_epoch_that_never_reserved_a_hand_is_witnessed_by_its_abse.sql').read_text()
            never=never[never.index('DO $pins$'):never.index('END $verify$;')+len('END $verify$;')]
            run('historical-never-reserved-install','BEGIN;\n'+never+'\nCOMMIT;')
            run('historical-never-reserved-identity',"SELECT p.oid::regprocedure::text||' '||md5(prosrc)||' '||md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)');",
                'smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb) 5422e7f73fdbdd34bf73d46e514e844e 23d15f8c833cf1d3ef6737cb9c758964')
            # Production then applies 20260925130323, which replaces the retired
            # origin transfer guard with the byte-exact 20260919024642 text carrying
            # one relaxed comparison: for registrations only, a stored playing row
            # with chips=0 and chip_count=0 may match a live eliminated row that is
            # identical in every field except status, a positive integer position,
            # eliminated_at and elimination_sequence (the Afternoon 615783bf bust of
            # an already-zero stack recorded after attestation). Its pre-image refuses
            # unless the installed body is exactly 62d8d93f..., which this clone
            # holds after the historical install, so the whole transaction is
            # applied as written: pre-image, CREATE OR REPLACE, post-image.
            regbust=(root/'supabase/migrations/20260925130323_a_bust_of_a_zero_stack_recorded_after_attestation_is_the_sam.sql').read_text()
            regbust=regbust[regbust.index('DO $regbust_preimage$'):regbust.index('END $regbust_postimage$;')+len('END $regbust_postimage$;')]
            run('historical-registration-bust-install','BEGIN;\n'+regbust+'\nCOMMIT;')
            run('historical-registration-bust-identity',"SELECT p.oid::regprocedure::text||' '||md5(prosrc)||' '||md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb)');",
                'smarter_private.f06_retired_origin_transfer(uuid,uuid,jsonb,jsonb) ce9c8da18aa4b596b62cc436fd22348d 61bd389d3c261ee6422a9e2336c58e89')
            # Production then applies 20260926043127, which replaces the movement
            # assert with the byte-exact installed text carrying two relaxed
            # comparisons: a key absent from a stored movement proof whose live
            # value is JSON null (a column added after the proof was taken, such as
            # hand_history.kill_pot from 20260924034010) no longer refuses the
            # sealed history or atomic row. Its pre-image refuses unless the
            # installed body is exactly 1bc767e2..., which this clone holds, so the
            # whole transaction is applied as written: pre-image, CREATE OR
            # REPLACE, post-image.
            added=(root/'supabase/migrations/20260926043127_a_column_added_after_a_movement_proof_was_taken_is_not_a_cha.sql').read_text()
            added=added[added.index('DO $movement_proof_preimage$'):added.index('$movement_proof_postimage$;',added.index('DO $movement_proof_postimage$')+30)+len('$movement_proof_postimage$;')]
            run('historical-added-column-install','BEGIN;\n'+added+'\nCOMMIT;')
            run('historical-added-column-identity',"SELECT p.oid::regprocedure::text||' '||md5(prosrc)||' '||md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.oid=to_regprocedure('smarter_private.f06_assert_movement(uuid)');",
                'smarter_private.f06_assert_movement(uuid) 0cbea76808f835945a63f91f03e7d91c 611ab479ccb52d5211145e8ffc0ec912')
        if name=='retired-origin-local-proof-store':
            run('historical-explicit-loss',"""UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{engines}',(SELECT jsonb_agg(jsonb_set(e,'{bank_custody,historical_loss}',fixture_history_scope(i)-ARRAY['occupants','pending_arrivals']) ORDER BY e->>'table_id') FROM jsonb_array_elements(local_proof->'engines')e));""")
            run('historical-pending-physical-capture',"""UPDATE fixture_origin_inputs SET local_proof=local_proof||jsonb_build_object('historical_loss_pending_arrivals',(SELECT COALESCE(jsonb_agg(jsonb_build_object('original',e,'durable_presence',NULL,'absence',jsonb_build_object('kind','all_current_engine_maps_absent_v1','source',local_proof#>>'{release_checkpoint,source}','instance_id','1-3846b8bb','table_id',e->>'table_id','global_absent',true,'owned_absent',true,'retirement_absent',true,'managers',(SELECT jsonb_agg(jsonb_build_object('manager_id',fixture_origin_c(j)->>'manager_id','absent',true)) FROM generate_series(1401,1402)j)))),'[]') FROM jsonb_array_elements(fixture_history_scope(i)->'pending_arrivals')e));""")
            run('historical-cohort-identity-check',"SELECT e,s.id,s.table_id,s.user_id,s.occupancy_id,s.joined_at FROM generate_series(1401,1402)i CROSS JOIN LATERAL jsonb_array_elements(fixture_history_scope(i)->'occupants')e LEFT JOIN table_seats s ON s.id=(e->>'seat_id')::uuid WHERE (s.table_id,s.user_id,s.occupancy_id,s.joined_at) IS DISTINCT FROM ((e->>'table_id')::uuid,(e->>'user_id')::uuid,(e->>'occupancy_id')::uuid,(e->>'joined_at')::timestamptz);")
            prepare="SELECT fn_f06_prepare_mixed_manager_custody(md5('origin-transfer1401')::uuid,fixture_origin_t(1401),(fixture_origin_c(1401)->>'generation')::uuid,md5('origin-successor1401')::uuid,(SELECT local_proof FROM fixture_origin_inputs WHERE i=1401),NULL);"
            for label,change,reason in [
                ('downgrade',"UPDATE profiles SET vip_tier='monthly';",'ALLOWANCE_UNPROVEN'),
                ('missing-profile','DELETE FROM profiles;','ALLOWANCE_UNPROVEN'),
                ('purchased-changed',"INSERT INTO feature_purchases SELECT id,'time_bank_seconds',1,NULL FROM profiles;",'ALLOWANCE_UNPROVEN'),
                ('changed-occupancy',"UPDATE table_seats SET occupancy_id=gen_random_uuid() WHERE id=(fixture_history_scope(1401)#>>'{occupants,0,seat_id}')::uuid;",'SEAT_OCCUPANCY_IMMUTABLE'),
                ('arbitrary-version',"UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,historical_loss,kind}','\"invented\"') WHERE i=1401;",'ORIGINAL_UNPROVEN'),
                ('outage',"CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance_v2(p_user_ids uuid[]) RETURNS TABLE(user_id uuid,is_vip boolean,is_lifetime boolean,unlimited_activations boolean,vip_seconds_remaining integer,purchased_seconds integer,extra_seconds integer) LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'allowance unavailable';END$$;",'allowance unavailable'),
            ]:probe('historical-refuses-'+label,service+change+prepare,error=reason)
            pending=cohort['5a387a75-754a-416e-8fee-b85b15fc2702']['pending_arrivals'][0]
            for label,change,reason in [
                ('missing-absence',"UPDATE fixture_origin_inputs SET local_proof=local_proof-'historical_loss_pending_arrivals' WHERE i=1401;",'PENDING_SCOPE_CHANGED'),
                ('present-engine',"UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{historical_loss_pending_arrivals,0,absence,global_absent}','false') WHERE i=1401;",'PENDING_ABSENCE_UNPROVEN'),
                ('unknown-manager-maps',"UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{historical_loss_pending_arrivals,0,absence,managers}','[]') WHERE i=1401;",'PENDING_ABSENCE_UNPROVEN'),
                ('new-table-lease',"INSERT INTO engine_table_leases VALUES('"+pending['table_id']+"');",'PENDING_ABSENCE_UNPROVEN'),
                ('pending-downgrade',"UPDATE profiles SET vip_tier='monthly' WHERE id='"+pending['user_id']+"';",'ALLOWANCE_UNPROVEN'),
                ('pending-allowance-missing',"DELETE FROM profiles WHERE id='"+pending['user_id']+"';",'ALLOWANCE_UNPROVEN'),
                ('altered-request-hash',"UPDATE hand_atomic_commits SET post_commit_request_hash=repeat('0',64) WHERE hand_id='"+pending['atomic_hand_id']+"';",'BANK_WITNESS_CHANGED'),
                ('altered-payload-hash',"UPDATE hand_atomic_commits SET post_commit_payload_hash=repeat('0',64) WHERE hand_id='"+pending['atomic_hand_id']+"';",'BANK_WITNESS_CHANGED'),
                ('altered-payload',"UPDATE hand_atomic_commits SET post_commit_payload=jsonb_set(post_commit_payload,'{time_banks,0,seconds_remaining}','41') WHERE hand_id='"+pending['atomic_hand_id']+"';",'BANK_WITNESS_CHANGED'),
                ('ambiguous-hand',"INSERT INTO hand_history SELECT * FROM hand_history WHERE id='"+pending['atomic_hand_id']+"';",'BANK_WITNESS_CHANGED'),
                ('lost-financial-key',"DELETE FROM settlement_idempotency_keys WHERE table_id='"+pending['table_id']+"';",'BANK_WITNESS_CHANGED'),
                ('arbitrary-cohort',"UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{historical_loss_pending_arrivals,0,original,user_id}',to_jsonb(gen_random_uuid())) WHERE i=1401;",'PENDING_ABSENCE_UNPROVEN'),
            ]:probe('historical-refuses-'+label,service+change+prepare,error=reason)
            # The installed reserve, at the RPC's own clock: 244 s remaining refuses,
            # 245.5 s is admitted (half a second covers the statements between the
            # UPDATE's clock_timestamp() and the RPC's), so the figure is 245 exactly.
            def remaining(seconds):
                return f"UPDATE engine_maintenance_break SET break_ends_at=clock_timestamp()+interval '{seconds} seconds';UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{{release_checkpoint,break_ends_at}}',(SELECT to_jsonb(break_ends_at) FROM engine_maintenance_break)) WHERE i=1401;"
            probe('historical-legacy-reserve-refuses-244',service+remaining(244)+prepare,error='F06_MIXED_FROZEN_CHECKPOINT_UNPROVEN')
            probe('historical-legacy-reserve-admits-245',service+remaining('245.5')+'SELECT ('+prepare.rstrip(';')+")->'receipt';",'null')
            old=runpy.run_path(str(root/'scripts/ci/build-f06-historical-bank-loss.py'))['definitions'](root)[0]['smarter_private.f06_mixed_bank_proof']
            # An actually initialized old bank with no durable park is the red
            # preimage; the historical marker does not manufacture that witness.
            red="UPDATE fixture_origin_inputs SET local_proof=jsonb_set(local_proof,'{engines,0,bank_custody,time_bank_metadata}','[[\"lost-user\",{}]]') WHERE i=1401;"
            probe('historical-red-before',old+service+red+prepare,error='ORIGINAL_EVIDENCE_MISSING')
            run('historical-usage-before',"SELECT jsonb_agg(to_jsonb(u) ORDER BY user_id) FROM vip_feature_usage_monthly u;")
            # The installed transfer guard, through the prepare RPC on 1402, whose
            # attested registrations hold exactly one playing zero-stack row. The
            # engine's recording of that bust after attestation (status eliminated,
            # a position, an eliminated_at, an elimination_sequence; chips, chip_count,
            # prize and seat unchanged) is admitted; the same edit on a live stack,
            # any money or seat difference, a bust without its position or
            # eliminated_at, a registration added, removed or swapped, and a changed
            # original operation still refuse. The roster source guard is disabled
            # inside each rolled-back probe only to write the row the engine wrote.
            zero="(SELECT id FROM tournament_players WHERE tournament_id=fixture_origin_t(1402) AND status='playing' AND chips=0)"
            run('historical-registration-one-attested-zero',"SELECT count(*) FROM tournament_players WHERE tournament_id=fixture_origin_t(1402) AND status='playing' AND chips=0 AND chip_count=0 AND prize=0 AND position IS NULL AND eliminated_at IS NULL AND elimination_sequence IS NULL;",'1')
            unguard="ALTER TABLE tournament_players DISABLE TRIGGER a00_f06_source_roster;"
            def bust(where=zero,extra='',position='12',eliminated_at="'2026-09-18T22:12:05.712905+00'"):
                return f"UPDATE tournament_players SET status='eliminated',position={position},eliminated_at={eliminated_at},elimination_sequence=151476{extra} WHERE id={where};"
            prepare_1402="SELECT (fn_f06_prepare_mixed_manager_custody(md5('origin-transfer1402')::uuid,fixture_origin_t(1402),(fixture_origin_c(1402)->>'generation')::uuid,md5('origin-successor1402')::uuid,(SELECT local_proof FROM fixture_origin_inputs WHERE i=1402),NULL))->'receipt';"
            origin=runpy.run_path(str(root/'scripts/ci/build-f06-retired-origin.py'))
            strict=origin['definition']((root/origin['AUTHORITY']).read_text(),'smarter_private.f06_retired_origin_transfer','$$').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
            probe('historical-registration-bust-red-before',strict+service+unguard+bust()+prepare_1402,error='F06_RETIRED_CANONICAL_CHANGED: registrations')
            probe('historical-registration-bust-admitted',service+unguard+bust()+prepare_1402,'null')
            probe('historical-registration-unchanged-admitted',service+prepare_1402,'null')
            live="(SELECT id FROM tournament_players WHERE tournament_id=fixture_origin_t(1402) AND status='playing' AND chips>0 ORDER BY id LIMIT 1)"
            for label,change in [
                ('live-stack',bust(live)),
                ('chips',bust(extra=',chips=1')),
                ('chip-count',bust(extra=',chip_count=1')),
                ('prize',bust(extra=',prize=1')),
                ('seat',bust(extra=',seat_number=9')),
                ('no-position',bust(position='NULL')),
                ('zero-position',bust(position='0')),
                ('no-eliminated-at',bust(eliminated_at='NULL')),
                ('still-playing',f"UPDATE tournament_players SET position=12 WHERE id={zero};"),
                ('added',f"INSERT INTO tournament_players(id,tournament_id,table_id,user_id,seat_number,chips,status) SELECT gen_random_uuid(),tournament_id,table_id,gen_random_uuid(),9,0,'playing' FROM tournament_players WHERE id={zero};"),
                ('removed',f"DELETE FROM tournament_players WHERE id={zero};"),
                ('swapped',f"WITH gone AS (DELETE FROM tournament_players WHERE id={zero} RETURNING tournament_id,table_id) INSERT INTO tournament_players(id,tournament_id,table_id,user_id,seat_number,chips,status) SELECT gen_random_uuid(),tournament_id,table_id,gen_random_uuid(),9,0,'playing' FROM gone;"),
            ]:probe('historical-registration-refuses-'+label,service+unguard+change+prepare_1402,error='F06_RETIRED_CANONICAL_CHANGED: registrations')
            # The seven other keys keep the strict whole-row comparison: with the
            # admitted bust in place, one chip on one live seat still refuses.
            probe('historical-registration-bust-refuses-changed-seat',service+unguard+bust()+"UPDATE table_seats SET stack=stack+1 WHERE id=(SELECT id FROM table_seats WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t(1402)) AND left_at IS NULL ORDER BY id LIMIT 1);"+prepare_1402,error='F06_RETIRED_CANONICAL_CHANGED: seats')
            # A changed original operation is refused before the transfer guard is
            # reached, by the mixed snapshot's own reservation check.
            probe('historical-registration-bust-refuses-late-changed-operation',service+unguard+bust()+"UPDATE smarter_private.f06_operations SET revision=revision+1 WHERE tournament_id=fixture_origin_t(1402);"+prepare_1402,error='F06_MIXED_RESERVATION_CHANGED')
        if name.startswith('retired-origin-completion-reply-lost-'):
            i=int(name.rsplit('-',1)[1])
            value=run('historical-materialized-'+str(i),f"SELECT count(*)=jsonb_array_length(fixture_history_scope({i})->'occupants')+jsonb_array_length(fixture_history_scope({i})->'pending_arrivals') AND bool_and((b.value->>'remainingSeconds')::integer=40 AND b.value->>'unlimitedActivations'='true') FROM engine_presence_parked p CROSS JOIN LATERAL jsonb_each(p.time_bank_snapshot->'players') b WHERE p.table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t({i}));",'t')
            run('historical-spend-before-replay-'+str(i),f"UPDATE engine_presence_parked SET time_bank_snapshot=jsonb_set(time_bank_snapshot,'{{players}}',(SELECT jsonb_object_agg(key,jsonb_set(value,'{{remainingSeconds}}','20')) FROM jsonb_each(time_bank_snapshot->'players'))) WHERE table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t({i}));")
        if name.startswith('retired-origin-completion-replay-') or name.startswith('retired-origin-later-ordinary-restart-'):
            i=int(name.rsplit('-',1)[1])
            run('historical-no-refill-'+name,f"SELECT bool_and(b.value->>'remainingSeconds'='20') FROM engine_presence_parked p CROSS JOIN LATERAL jsonb_each(p.time_bank_snapshot->'players') b WHERE p.table_id IN(SELECT id FROM tables WHERE tournament_id=fixture_origin_t({i}));",'t')
        return result
    ns={'__file__':str(root/'scripts/ci/probes/f06-shared-hand-lane/retired_origin_qualification.py')}
    exec(compile(module,ns['__file__'],'exec'),ns)
    ns['qualify'](root,out,cmd,command,adapted,probe,require,results)
    run('historical-no-usage-reversal',"SELECT bool_and(usage_count=1620) FROM vip_feature_usage_monthly;",'t')
    # The publisher's pre-intent read-only comparison pins this installed
    # 29-function catalogue, the one production holds after this migration, the
    # reviewed-noon-hand abort migration 20260921040823, the legacy checkpoint
    # reserve migration 20260921155216, the never-reserved witness migration
    # 20260924225647, the registration bust migration 20260925130323 and the
    # added-column movement proof migration 20260926043127.
    catalog=json.loads((out/'qualified-service-contract.json').read_text())
    fixture=json.loads((root/'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json').read_text())
    require(catalog==fixture,'Publisher fixture does not equal actual historical-loss catalogue')
    import ast
    publisher=ast.parse((root/'server/scripts/engine-release-database-proof.py').read_text())
    pinned=next(ast.literal_eval(n.value) for n in publisher.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MIXED_CUSTODY_CONTRACT' for t in n.targets))
    require(catalog==pinned,'Publisher control generation has stale historical-loss definitions')
    results['historicalLoss']={'passed':True,'ordinarySession':True,'originalOccupancies':23,'separatePendingArrival':1,'historicalBalanceClaim':False,'newRpc':False,'publisherCatalogEquality':True}
