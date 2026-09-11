"""Native guard probes; every denied mutation rolls back its own transaction."""
from pathlib import Path
import json, subprocess, sys

base=Path(__file__).resolve().parent
state=json.loads((base/'cluster.json').read_text())
assert state['cluster'].startswith('/tmp/ca-e2-owned-') and state['database']=='d1_7aa16fa7'
p=['/opt/homebrew/opt/postgresql@17/bin/psql','-X','-v','ON_ERROR_STOP=1','-h',state['socket'],'-p',str(state['port']),'-U','postgres','-d',state['database'],'-Atc']
phase=sys.argv[1];assert phase in ['pre','post']
bad='bea72c06-dde6-4d97-b3d5-dd003627a676';source='266af3b0-7791-4681-8e49-752a62deeb45'
checks={}
if phase=='pre':
    sql=(base/'D1_7aa16fa7_true_bust.sql').read_text()
    insertion='INSERT INTO public.tournament_knockout_invalidations'+sql.split('INSERT INTO public.tournament_knockout_invalidations',1)[1].split('UPDATE public.tournament_knockout_candidates',1)[0]
    transitions=sql.split('UPDATE public.tournament_knockout_candidates',1)[1].split('SET CONSTRAINTS',1)[0]
    complete=insertion+'UPDATE public.tournament_knockout_candidates'+transitions
    checks={
      'unaudited_invalidation':(f"UPDATE tournament_knockout_candidates SET state='invalidated' WHERE id='{bad}'",'invalidation requires immutable privileged evidence'),
      'ordinary_role_evidence_insert':("SET LOCAL ROLE service_role; INSERT INTO tournament_knockout_invalidations(id) VALUES('11111111-1111-1111-1111-111111111111')",'permission denied for table tournament_knockout_invalidations'),
      'orphan_evidence':(insertion,'both audited knockout transitions must commit together'),
      'one_transition_only':(insertion+f"UPDATE tournament_knockout_candidates k SET state='invalidated',resolved_at=e.created_at FROM tournament_knockout_invalidations e WHERE k.id='{bad}' AND e.invalid_candidate_id=k.id",'both audited knockout transitions must commit together'),
      'false_source_before_image':(insertion.replace('to_jsonb(real_bust),',"(to_jsonb(real_bust)||jsonb_build_object('hand_number',0)),"),'knockout ruling before-images or generation identities changed'),
      'invalid_candidate_wrong_seat':(f"UPDATE tournament_knockout_candidates SET seat_id='59841fb4-0f0b-4ef1-8623-e7bd3e228636' WHERE id='{bad}'; "+insertion,'knockout ruling candidate seat generation differs from its accepted receipt'),
      'source_candidate_wrong_seat':(f"UPDATE tournament_knockout_candidates SET seat_id='c198f227-bb3d-42a2-9bf6-81c31f0f01bf' WHERE id='{source}'; "+insertion,'knockout ruling candidate seat generation differs from its accepted receipt'),
      'invalid_candidate_wrong_generation':(f"UPDATE tournament_knockout_candidates SET seat_joined_at=seat_joined_at+interval '1 second' WHERE id='{bad}'; "+insertion,'knockout ruling candidate seat generation differs from its accepted receipt'),
      'source_candidate_wrong_generation':(f"UPDATE tournament_knockout_candidates SET seat_joined_at=seat_joined_at-interval '1 second' WHERE id='{source}'; "+insertion,'knockout ruling candidate seat generation differs from its accepted receipt'),
      'null_finalized_flag':("UPDATE tournaments SET prize_pool_finalized=NULL; "+insertion,'knockout ruling requires an unpaid running non-bounty event and an eliminated seatless player'),
      'null_chips_before_evidence':("UPDATE tournament_players SET chips=NULL WHERE user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'; "+insertion,'knockout ruling requires an unpaid running non-bounty event and an eliminated seatless player'),
      'null_chips_at_commit':(complete+"UPDATE tournament_players SET chips=NULL WHERE user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'",'player elimination must carry the evidenced real bust time'),
      'unrelated_player_field_rewrite':(complete+"UPDATE tournament_players SET rebuys=rebuys+1 WHERE user_id='373a7bc7-1505-4c4c-b6b0-ba437b569a8a'",'player elimination must carry the evidenced real bust time'),
      'false_commit_receipt':(insertion.replace('to_jsonb(real_hand)-ARRAY',"(to_jsonb(real_hand)||jsonb_build_object('committed_at','2026-01-01T00:00:00Z'))-ARRAY"),'knockout ruling lacks an exact committed zero-stack settlement receipt'),
    }
else:
    checks={
      'evidence_update':("UPDATE tournament_knockout_invalidations SET reason=repeat('x',250)",'knockout invalidation evidence is immutable'),
      'evidence_delete':('DELETE FROM tournament_knockout_invalidations','knockout invalidation evidence is immutable'),
      'evidence_truncate':('TRUNCATE tournament_knockout_invalidations','knockout invalidation evidence is immutable'),
      'invalidated_revival':(f"UPDATE tournament_knockout_candidates SET state='pending' WHERE id='{bad}'",'adjudicated candidate permits only its evidenced terminal transition'),
      'source_rebuy_revival':(f"UPDATE tournament_knockout_candidates SET state='rebought' WHERE id='{source}'",'adjudicated candidate permits only its evidenced terminal transition'),
      'candidate_delete':(f"DELETE FROM tournament_knockout_candidates WHERE id='{bad}'",'an adjudicated knockout generation cannot be deleted'),
      'candidate_identity_rewrite':(f"UPDATE tournament_knockout_candidates SET stack_before=stack_before+1 WHERE id='{bad}'",'adjudicated candidate permits only its evidenced terminal transition'),
    }
tables=['tournaments','tournament_players','tournament_knockout_candidates','tournament_knockout_invalidations','hand_atomic_commits','tournament_escrow','chip_ledger','wallet_transactions','tournament_obligations','tournament_payouts','tournament_manager_wakes','club_members','union_wallets','table_seats']
def hashes():return {t:subprocess.check_output(p+[f"SELECT md5(coalesce(jsonb_agg(j ORDER BY j::text),'[]')::text) FROM (SELECT to_jsonb(x) j FROM {t} x) s"],text=True).strip() for t in tables}
before=hashes();results={}
for name,(sql,expected) in checks.items():
    r=subprocess.run(p+["BEGIN; SET LOCAL timezone='UTC'; "+sql+'; COMMIT;'],capture_output=True,text=True)
    assert r.returncode!=0 and expected in r.stderr,(name,r.returncode,r.stderr)
    assert hashes()==before,name
    results[name]={'refused':True,'unchanged':True,'expectedError':expected}
if phase=='post':
    latest=subprocess.check_output(p+["SELECT fn_ca_latest_committed_knockout_candidate('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d','373a7bc7-1505-4c4c-b6b0-ba437b569a8a')"],text=True).strip()
    assert latest==bad
    r=subprocess.run(p+["SELECT fn_eliminate_tournament_player_atomic('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d','373a7bc7-1505-4c4c-b6b0-ba437b569a8a',36,1.94,0)"],capture_output=True,text=True,check=True)
    assert hashes()==before
    results['native_elimination_replay']={'unchanged':True,'result':json.loads(r.stdout)}
    results['latest_helper_keeps_invalidated_barrier']={'candidateId':latest,'matches':True}
(base/f'negative-{phase}-receipt.json').write_text(json.dumps({'phase':phase,'checks':results,'unchangedHashes':before},indent=2)+'\n')
print(json.dumps({'phase':phase,'checks':len(results),'unchanged':True}))
