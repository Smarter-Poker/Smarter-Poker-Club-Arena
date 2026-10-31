"""Real chip union overlay and paid-award closeout through the new public API."""
import json
from tournament_abort_native import sql_file,prepare_quiesced,SERVICE
EVENT='ac300000-0000-4000-8000-000000000001'
UNION='ac200000-0000-4000-8000-000000000001'
CLUB='ac200000-0000-4000-8000-000000000002'
USER='d1000000-0000-4000-8000-000000000001'
OP='ac400000-0000-4000-8000-000000000001'
TABLE='ac500000-0000-4000-8000-000000000001'
def run_chip_overlay(e,db,root):
 store=json.loads((root/'scripts/ci/fixtures/tournament-abort/union-bank-store.json').read_text())[0]
 store_sql="INSERT INTO public.ca_chip_store_coverage(store,treatment,counted_by,notes) SELECT store,treatment,counted_by,notes FROM jsonb_to_record('"+json.dumps(store).replace("'","''")+"'::jsonb) AS x(store text,treatment text,counted_by text,notes text) ON CONFLICT(store) DO NOTHING;"
 setup="""BEGIN;"""+SERVICE+store_sql+"""
SET LOCAL session_replication_role=replica;
INSERT INTO public.unions(id,name,owner_id,slug) VALUES('"""+UNION+"""','Native abort funding union','"""+USER+"""','native-abort-union');
INSERT INTO public.union_wallets(union_id,chip_balance) VALUES('"""+UNION+"""',1000);
INSERT INTO public.clubs(id,club_id,name,owner_id,union_id,chip_treasury) VALUES('"""+CLUB+"""',991007,'Native abort union member','"""+USER+"""','"""+UNION+"""',0);
SET LOCAL session_replication_role=origin;
INSERT INTO public.union_clubs(union_id,club_id) VALUES('"""+UNION+"""','"""+CLUB+"""');
COMMIT;BEGIN;"""+SERVICE+"""
SET LOCAL session_replication_role=replica;
INSERT INTO public.club_members(club_id,user_id,role,status,chip_balance,joined_at) VALUES('"""+CLUB+"""','"""+USER+"""','player','active',200,now()-interval '2 days'),('"""+CLUB+"""','d1000000-0000-4000-8000-000000000002','player','active',200,now()-interval '2 days');
INSERT INTO public.tournaments(id,name,buy_in_amount,buy_in_fee,starting_chips,start_time,status,current_players,max_players,min_players,current_level,club_id,union_id,prize_pool,total_rake,bounty_pool,guaranteed_prize,entry_contract_locked,is_rebuy,is_reentry,rebuy_levels,late_reg_levels,late_reg_mins)
VALUES('"""+EVENT+"""','Native original union overlay',90,10,1000,now()+interval '1 day','REGISTERING',0,100,2,1,'"""+CLUB+"""','"""+UNION+"""',0,0,0,200,false,false,false,0,0,0);
UPDATE public.tournaments SET blind_structure='[{"smallBlind":1,"bigBlind":2,"duration":300}]',payout_structure='[{"place":1,"percentage":97.5},{"place":2,"percentage":2.5}]',payout_percent=20 WHERE id='"""+EVENT+"""';
SET LOCAL session_replication_role=origin;
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"d4000000-0000-4000-8000-000000000001"}',true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub','"""+USER+"""',true);
SET LOCAL ROLE authenticated;
SELECT public.fn_register_for_tournament_request('"""+EVENT+"""','ac600000-0000-4000-8000-000000000001');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"d4000000-0000-4000-8000-000000000003"}',true),set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000002',true);
SELECT public.fn_register_for_tournament_request('"""+EVENT+"""','ac600000-0000-4000-8000-000000000002');
RESET ROLE;"""+SERVICE+"""
-- Only the already-accepted launch scene is synthetic. The exact captured
-- financier executes with every real public monetary trigger enabled.
CREATE TEMP TABLE native_overlay_opening ON COMMIT DROP AS SELECT * FROM public.tournaments WHERE id='"""+EVENT+"""';
CREATE TRIGGER actual_native_overlay BEFORE UPDATE OF status ON native_overlay_opening FOR EACH ROW EXECUTE FUNCTION public.fn_ca_fund_overlay_on_lock();
UPDATE native_overlay_opening SET status='RUNNING',started_at=clock_timestamp();
SET LOCAL session_replication_role=replica;
UPDATE public.tournaments SET status='RUNNING',started_at=clock_timestamp(),prize_pool=(SELECT prize_pool FROM native_overlay_opening),payout_structure=(SELECT payout_structure FROM native_overlay_opening) WHERE id='"""+EVENT+"""';
SET LOCAL session_replication_role=origin;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM public.chip_ledger WHERE tournament_id='"""+EVENT+"""' AND category='overlay' AND from_type='union_bank' AND from_entity_id='"""+UNION+"""' AND amount=20)
 OR NOT EXISTS(SELECT 1 FROM public.union_wallets WHERE union_id='"""+UNION+"""' AND chip_balance=980) THEN RAISE EXCEPTION 'actual union source did not fund20';END IF;END$$;
SET LOCAL session_replication_role=replica;
UPDATE public.tournament_players SET status='eliminated',eliminated_at=now()-interval '1 minute',position=2,prize=5,chips=0 WHERE tournament_id='"""+EVENT+"""' AND user_id='"""+USER+"""';
SET LOCAL session_replication_role=origin;
DO $$DECLARE r jsonb;BEGIN r:=public.fn_settle_tournament_obligation('"""+EVENT+"""','place',2,'"""+USER+"""',5,'engine.eliminatePlayer','Native original earned place preserved');IF r->>'ok' IS DISTINCT FROM 'true' OR (r->>'paid')::numeric IS DISTINCT FROM 5::numeric THEN RAISE EXCEPTION 'actual prior prize failed:%',r;END IF;END$$;
COMMIT;"""
 sql_file(e,db,'chip-real-union-overlay-and-prior-award',setup)
 money_hash=prepare_quiesced(e,db,EVENT,OP,TABLE)
 def read():
  _,out,_=e.sql(db,"SELECT jsonb_build_object('wallet',(SELECT chip_balance FROM public.club_members WHERE club_id='"+CLUB+"' AND user_id='"+USER+"'),'bank',(SELECT chip_balance FROM public.union_wallets WHERE union_id='"+UNION+"'),'escrow',(SELECT to_jsonb(x) FROM public.tournament_escrow x WHERE tournament_id='"+EVENT+"'),'ledger',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.chip_ledger x WHERE tournament_id='"+EVENT+"'),'players',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.tournament_players x WHERE tournament_id='"+EVENT+"'),'obligations',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM public.tournament_obligations x WHERE tournament_id='"+EVENT+"'));",label='chip-overlay-financial-witness')
  return json.loads(out.strip())
 before=read();call="SELECT public.fn_ca_settle_tournament_abort('"+OP+"','"+EVENT+"','"+money_hash+"');"
 prefix="BEGIN;SET LOCAL statement_timeout='8s';SET LOCAL lock_timeout='1s';"+SERVICE
 sql_file(e,db,'chip-union-overlay-full-rollback',prefix+call+'ROLLBACK;')
 if read()!=before:raise AssertionError('chip overlay rollback moved money/history')
 _,out,_=sql_file(e,db,'chip-union-overlay-commit',prefix+call+'COMMIT;')
 receipt=[json.loads(x) for x in out.splitlines() if x.startswith('{') and 'total_refunded' in x][-1]
 if receipt['total_refunded']!=200 or receipt['fees_reversed']!=20 or receipt['financial']['unused_overlay_returned']!=15:raise AssertionError('chip original overlay refund mismatch')
 after=read()
 if before['wallet']!=105 or after['wallet']!=205 or before['bank']!=980 or after['bank']!=995:raise AssertionError('chip source/recipient mismatch')
 original=next(p for p in before['players'] if p['user_id']==USER);closed=next(p for p in after['players'] if p['user_id']==USER)
 for field in ['eliminated_at','position','prize','elimination_sequence']:
  if original.get(field)!=closed.get(field):raise AssertionError('original earned result changed:'+field)
 if len([r for r in after['ledger'] if r.get('category')=='reversal' and (r.get('metadata') or {}).get('kind')=='reviewed_void_overlay_return' and r['to_type']=='union_bank' and r['to_entity_id']==UNION and r['amount']==15])!=1:raise AssertionError('one exact original-union return required')
 _,out,_=sql_file(e,db,'chip-union-overlay-replay',prefix+call+'COMMIT;')
 replay=[json.loads(x) for x in out.splitlines() if x.startswith('{') and 'total_refunded' in x][-1]
 if replay!=receipt or read()!=after:raise AssertionError('chip overlay replay moved money/history')
 e.report['chip_union_overlay_cases']=['real-union-overlay20','real-earned-place5','full-original-refund200-including-fee20','unused15-returned-original-union','rollback','terminal-commit','no-duplicate-replay','prior-results-preserved']
