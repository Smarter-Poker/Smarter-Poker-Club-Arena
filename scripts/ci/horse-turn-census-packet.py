#!/usr/bin/env python3
"""Private bounded commit-owned action census. No cards or raw actors on stdout.

The database denominator is independent of journal availability. A missing
journal turn must not remove its corresponding accepted action from this packet.
"""
import hashlib, importlib.util, json, math, os, re, subprocess, sys, time
from datetime import datetime
from pathlib import Path

_spec=importlib.util.spec_from_file_location('horse_fleet_packet',Path(__file__).with_name('horse-fleet-packet.py'))
legacy=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(legacy)
MAX_HANDS=1024
MAX_ACTIONS=16384
PARTITION_TURN_LIMIT=256
DIAGNOSTIC_KEYS={'forcedPosts','uncalledReturns','unknownNonDecision'}
MAX_BYTES=1048576
UUID=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
STAGES={'preflop','flop','pineapple_discard','turn','river','showdown'}
ACTIONS={'fold','check','call','bet','raise','all_in','discard'}
VARIANTS={'nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8'}
HISTORY_REASONS={'unknown','loading','load_capacity','packet_ready','worker_acknowledged','packet_after_cutoff','provider_error','provider_empty_response','provider_source_mismatch','provider_invalid_window','provider_deadline','provider_thrown','cache_disposed','retry_load_capacity','retention_invalid_claim','retention_heap_unavailable','retention_heap_headroom','retention_capacity','invalid_window','context_mismatch','packet_size_refused','load_rejected','load_thrown'}
CONTEXT_KEYS={'variant','format','provenance'}
def validate_context(c):
    if not isinstance(c,dict) or set(c)!=CONTEXT_KEYS or c['variant'] not in VARIANTS or c['format'] not in ('cash','tournament') or c['provenance'] not in ('committed_hand_history','retained_submission_and_committed_history'):raise ValueError('original_context')
    return c

ORIGINS={'player','pre_action','horse_policy','horse_fallback','forced','unknown'}

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def transport_digest(value):
    # The installed JS reader hashes recursively sorted JSON.stringify(packet).
    # numeric serializer normalize 1.0 / exponent notation, without exporting
    # the private input or evaluating any input as code.
    raw=json.dumps(value,separators=(',',':'),ensure_ascii=False,allow_nan=False)
    if len(raw.encode())>MAX_BYTES:raise ValueError('packet_byte_bound')
    run=subprocess.run(['node','--input-type=module','-e',
        "import fs from 'node:fs';import{createHash}from'node:crypto';const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;const p=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(createHash('sha256').update(JSON.stringify(sort(p))).digest('hex'));"],input=raw,text=True,capture_output=True,timeout=5)
    if run.returncode or not re.fullmatch('[0-9a-f]{64}',run.stdout):raise ValueError('packet_digest_unavailable')
    return run.stdout

def query(start,end):
    # Reuse the existing exact index gate, transaction, original joins and time
    # grammar. Unnest ONLY the bounded selected hand rows, never global actions.
    sql=legacy.query(start,end)
    sql=sql.replace('SELECT id,table_id,hand_number,created_at FROM public.hand_history',
                    'SELECT id,table_id,hand_number,created_at,actions,game_variant,tournament_id FROM public.hand_history')
    sql=sql.replace('ORDER BY created_at DESC LIMIT 10001','ORDER BY created_at DESC,id LIMIT 1025')
    sql=sql.replace('SELECT h.id::text,h.table_id::text,h.hand_number::text,', '''SELECT h.id::text,h.table_id::text,h.hand_number::text,
        jsonb_build_object('variant',h.game_variant,'format',CASE WHEN h.tournament_id IS NULL THEN 'cash' ELSE 'tournament' END,'provenance',CASE WHEN l.hand_id IS NULL THEN 'retained_submission_and_committed_history' ELSE 'committed_hand_history' END) AS original_context,
        CASE WHEN l.hand_id IS NULL THEN s.original_variant=h.game_variant AND s.original_tournament IS NOT DISTINCT FROM h.tournament_id::text ELSE true END AS original_context_match,
        floor(extract(epoch FROM h.created_at)*1000)::bigint AS committed_at_ms,
        jsonb_typeof(h.actions)='array' AS actions_valid,
        CASE WHEN l.hand_id IS NULL THEN s.original_actions=h.actions ELSE true END AS original_actions_match,
        (SELECT jsonb_build_object(
          'forcedPosts',count(*) FILTER(WHERE kind='forced'),
          'uncalledReturns',count(*) FILTER(WHERE kind='return'),
          'unknownNonDecision',count(*) FILTER(WHERE kind='unknown'))
         FROM (SELECT CASE
           WHEN a.value->>'origin'='forced' AND a.value->>'action' IN ('sb','bb','post','kill_blind','ante','straddle','bomb_ante') AND NOT a.value ? 'historyEvent'
             AND CASE WHEN jsonb_typeof(a.value->'amount')='number' THEN (a.value->>'amount')::numeric>0 ELSE false END THEN 'forced'
           WHEN a.value->>'action'='return' AND a.value->>'historyEvent'='uncalled_bet_returned' AND NOT a.value ? 'origin'
             AND CASE WHEN jsonb_typeof(a.value->'amount')='number' THEN (a.value->>'amount')::numeric>0 ELSE false END THEN 'return'
           ELSE 'unknown' END kind
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.actions)='array' THEN h.actions ELSE '[]'::jsonb END) a(value)
          WHERE (a.value->>'userId' IN (SELECT horse_id FROM cohort) OR a.value->>'origin'='horse_policy')
            AND coalesce(a.value->>'action','') NOT IN ('fold','check','call','bet','raise','all_in','discard')) d) AS non_decision_diagnostics,
        (SELECT coalesce(jsonb_agg(jsonb_build_object(
          'actorId',a.value->>'userId','actionOrdinal',a.ordinality-1,
          'stage',a.value->'stage','action',a.value->'action',
          'origin',coalesce(a.value->>'origin','unknown'),
          'amount',a.value->'amount','seat',a.value->'seat','timestamp',a.value->'timestamp') ORDER BY a.ordinality),'[]'::jsonb)
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h.actions)='array' THEN h.actions ELSE '[]'::jsonb END)
          WITH ORDINALITY a(value,ordinality)
         WHERE (a.value->>'userId' IN (SELECT horse_id FROM cohort) OR a.value->>'origin'='horse_policy')
           AND a.value->>'action' IN ('fold','check','call','bet','raise','all_in','discard')) AS actions,''')
    sql=sql.replace('SELECT lease_generation FROM smarter_private.hand_submissions',
                    "SELECT lease_generation,request#>'{p_hand_row,actions}' AS original_actions,request#>>'{p_hand_row,game_variant}' AS original_variant,request#>>'{p_hand_row,tournament_id}' AS original_tournament FROM smarter_private.hand_submissions")
    sql=sql.replace('WHERE l.hand_id IS NULL AND table_id=h.table_id AND hand_number=h.hand_number',
                    'WHERE l.hand_id IS NULL AND submission_id=h.id AND table_id=h.table_id AND hand_number=h.hand_number')
    if 'LIMIT 1025' not in sql or 'original_actions_match' not in sql:raise ValueError('query_contract')
    return sql

def _number(value,kind):
    if value is None:return None
    if type(value) not in (int,float) or not math.isfinite(value) or value<0:raise ValueError('action_'+kind)
    if kind in ('seat','timestamp') and (type(value) is not int or value>9007199254740991):raise ValueError('action_'+kind)
    if kind=='seat' and not 1<=value<=10:raise ValueError('action_seat')
    return value

def packet_from_rows(rows,sha,start,end):
    legacy.inputs({'FLEET_SOURCE_SHA':sha,'FLEET_FROM_UTC':start,'FLEET_TO_UTC':end})
    if not isinstance(rows,dict) or rows.get('timeIndexValid') is not True or not rows.get('snapshot') or not rows.get('readAt'):raise ValueError('snapshot_or_index')
    ids=rows.get('horseIds');hands=rows.get('hands')
    if not isinstance(ids,list) or len(ids)!=1000 or any(not isinstance(i,str) or not UUID.fullmatch(i) for i in ids) or len(set(ids))!=1000:raise ValueError('canonical_cohort_not_1000')
    ids=sorted(ids);positions={actor:i for i,actor in enumerate(ids)}
    if not isinstance(hands,list) or not 1<=len(hands)<=MAX_HANDS:raise ValueError('accepted_source_hand_bound')
    first=int(datetime.fromisoformat(start.replace('Z','+00:00')).timestamp()*1000)
    last=int(datetime.fromisoformat(end.replace('Z','+00:00')).timestamp()*1000)
    out=[];seen=set();diagnostics={};action_count=0;owners={'classic':0,'lightning':0}
    for h in hands:
        if not isinstance(h,dict) or h.get('source_owner') not in owners or h.get('accepted') is not True:raise ValueError('original_acceptance_unavailable')
        if h.get('actions_valid') is not True or h.get('original_actions_match') is not True:raise ValueError('original_actions_unavailable')
        if any(not isinstance(h.get(k),str) or not UUID.fullmatch(h[k]) for k in ('id','table_id','lease_generation')) or not re.fullmatch('[1-9][0-9]{0,17}',h.get('hand_number') or ''):raise ValueError('original_coordinate')
        if h.get('original_context_match') is not True:raise ValueError('original_context_mismatch')
        context=validate_context(h.get('original_context'))
        if context['provenance']!=('committed_hand_history' if h['source_owner']=='lightning' else 'retained_submission_and_committed_history'):raise ValueError('original_context_provenance')
        at=h.get('committed_at_ms')
        if type(at) is not int or not first<=at<last:raise ValueError('commit_outside_window')
        key=hashlib.sha256(f"{h['table_id']}:{h['hand_number']}:{h['lease_generation']}".encode()).hexdigest()
        if key in seen or h['id'] in seen:raise ValueError('duplicate_coordinate')
        seen.update((key,h['id']));actions=[];ordinals=set()
        d=validate_diagnostics(h.get('non_decision_diagnostics'))
        if d['unknownNonDecision']:raise ValueError('unknown_nondecision')
        diagnostics[key]=d
        if not isinstance(h.get('actions'),list):raise ValueError('accepted_actions')
        for a in h['actions']:
            if not isinstance(a,dict) or set(a)!={'actorId','actionOrdinal','stage','action','origin','amount','seat','timestamp'}:raise ValueError('accepted_action_shape')
            actor=a['actorId'];ordinal=a['actionOrdinal']
            if actor not in positions:raise ValueError('horse_policy_actor_outside_cohort')
            if type(ordinal) is not int or not 0<=ordinal<MAX_ACTIONS or ordinal in ordinals:raise ValueError('action_ordinal')
            if a['stage'] not in STAGES or a['action'] not in ACTIONS or a['origin'] not in ORIGINS:raise ValueError('action_enum')
            ordinals.add(ordinal)
            actions.append({'actorIndex':positions[actor],'actionOrdinal':ordinal,'stage':a['stage'],'action':a['action'],'origin':a['origin'],**{k:_number(a[k],k) for k in ('amount','seat','timestamp')}})
        action_count+=len(actions)
        if action_count>MAX_ACTIONS:raise ValueError('action_bound')
        owners[h['source_owner']]+=1
        out.append({'context':context,'handKey':key,'committedAtMs':at,'actions':sorted(actions,key=lambda a:a['actionOrdinal'])})
    packet={'version':3,'sourceSha':sha,'window':{'startUtc':start,'endUtc':end},'horseIds':ids,'hands':sorted(out,key=lambda h:(h['committedAtMs'],h['handKey']))}
    if len(json.dumps(packet,separators=(',',':')).encode())>MAX_BYTES:raise ValueError('packet_byte_bound')
    partition_packets(packet) # refuse before any event if all original hands cannot fit
    attestation={'version':3,'authority':'canonical_database_snapshot','rosterTable':'public.ca_horse_fleet_register','rosterPredicate':'retired_at IS NULL','snapshot':rows['snapshot'],'readAt':rows['readAt'],'sourceSha':sha,'packetDigest':transport_digest(packet),'cohortDigest':digest({'version':1,'horseIds':ids}),'rosterCount':1000,'selectedHands':len(out),'expectedActions':action_count,'sourceOwnerCounts':owners,'ownership':'accepted_hand_commit_window','handDomains':[{'handKey':h['handKey'],'committedAtMs':h['committedAtMs'],'expectedActions':len(h['actions']),'domainDigest':digest(h['actions']),'nonDecisionDiagnostics':diagnostics[h['handKey']], 'context':h['context']} for h in packet['hands']],'completePopulation':False,'allPhasesVerified':False}
    return packet,attestation

def validate_diagnostics(d):
    if not isinstance(d,dict) or set(d)!=DIAGNOSTIC_KEYS or any(type(v) is not int or not 0<=v<=MAX_ACTIONS for v in d.values()):raise ValueError('nondecision_diagnostics')
    return d

def partition_packets(packet):
    parts=[];hands=[];count=0
    for hand in packet['hands']:
        n=len(hand['actions'])
        if n>PARTITION_TURN_LIMIT:raise ValueError('partition_action_bound')
        if hands and (len(hands)==64 or count+n>PARTITION_TURN_LIMIT):
            parts.append({**packet,'hands':hands});hands=[];count=0
        hands.append(hand);count+=n
    if hands:parts.append({**packet,'hands':hands})
    if not 1<=len(parts)<=16:raise ValueError('partition_bound')
    return parts

TURN_FIELDS={'actorIndex','handKey','actionOrdinal','stage','action','origin','expectedBinding','capture','execution','selection','inputBinding','publicRead','historicalRead','handReconciliation','phases'}
TURN_ENUMS={'expectedBinding':{'unknown','matched','contradictory'},'capture':{'missing','present','ambiguous'},'execution':{'missing','ambiguous','intended','coerced','retired','unknown'},'selection':{'unknown','matched'},'inputBinding':{'unknown','canonical_digest_and_read_frame','original_discard_request_and_controller'},'publicRead':{'unknown','pooled_public','independent','unqualified','not_applicable'},'historicalRead':{'unknown','loaded','pending','unavailable','volatile_only','not_applicable'},'handReconciliation':{'unknown','reconciled','incomplete'}}
PHASE_ENUMS={'status':{'applicable-active','shadow','refused','outside-domain','unobserved','unknown'},'eligibility':{'eligible','outside-domain','unknown'},'application':{'accepted','not-selected','shadow','refused','not-applicable','unknown'},'capability':{'captured','unobserved'},'qualification':{'verified','owner-forced','unknown','refused'}}

def expected_rows(packet):
    return [{**{k:a[k] for k in ('actorIndex','actionOrdinal','stage','action','origin')},'handKey':h['handKey']} for h in packet['hands'] for a in h['actions']]

def validate_turn(row, contextual=False):
    if not isinstance(row,dict) or set(row)!=(TURN_FIELDS|({'contextBinding','historyReason'} if contextual else set())):raise ValueError('turn_shape')
    if type(row['actorIndex']) is not int or not 0<=row['actorIndex']<1000 or type(row['actionOrdinal']) is not int or not 0<=row['actionOrdinal']<MAX_ACTIONS or not isinstance(row['handKey'],str) or not re.fullmatch('[0-9a-f]{64}',row['handKey']) or row['stage'] not in STAGES or row['action'] not in ACTIONS or row['origin'] not in ORIGINS:raise ValueError('turn_domain')
    for k,values in TURN_ENUMS.items():
        if row[k] not in values:raise ValueError('turn_status')
    if contextual and row['contextBinding'] not in ('unknown','matched','contradictory'):raise ValueError('turn_context_binding')
    if contextual and ((row['contextBinding']=='matched' and (row['inputBinding']!='canonical_digest_and_read_frame' or row['capture']!='present' or row['expectedBinding']!='matched' or row['handReconciliation']!='reconciled')) or (row['inputBinding']=='canonical_digest_and_read_frame' and row['contextBinding']!='matched')):raise ValueError('turn_context_consumption')
    if contextual and (row['historyReason'] not in HISTORY_REASONS or (row['historyReason']!='unknown' and row['inputBinding']!='canonical_digest_and_read_frame')):raise ValueError('turn_history_reason')
    discard=row['action']=='discard' and row['stage'] in ('flop','pineapple_discard')
    if row['inputBinding']=='original_discard_request_and_controller' and not discard:raise ValueError('turn_discard_context')
    if (row['publicRead']=='not_applicable' or row['historicalRead']=='not_applicable') and not (discard or row['origin']=='forced'):raise ValueError('turn_read_context')
    if row['inputBinding']=='original_discard_request_and_controller' and (row['capture']!='present' or row['execution']!='intended' or row['selection']!='matched' or row['expectedBinding']!='matched' or row['handReconciliation']!='reconciled' or row['publicRead']!='not_applicable' or row['historicalRead']!='not_applicable'):raise ValueError('turn_discard_binding')
    phases=row['phases']
    if not isinstance(phases,dict) or set(phases)!={f'phase{i}' for i in range(1,16)}:raise ValueError('turn_phases')
    for phase in phases.values():
        if not isinstance(phase,dict) or set(phase)!={*PHASE_ENUMS,'reasonSha256'}:raise ValueError('turn_phase_shape')
        for k,values in PHASE_ENUMS.items():
            if phase[k] not in values:raise ValueError('turn_phase_status')
        reason=phase['reasonSha256']
        if reason is not None and (not isinstance(reason,str) or not re.fullmatch('[0-9a-f]{64}',reason)):raise ValueError('turn_phase_reason')
    return row

def missing_row(expected,contextual=False):
    return {'contextBinding':'unknown','historyReason':'unknown',**missing_row(expected)} if contextual else {**expected,**{k:('missing' if k in ('capture','execution') else 'unknown') for k in TURN_ENUMS},'phases':{f'phase{i}':{'status':'unknown','eligibility':'unknown','application':'unknown','capability':'unobserved','qualification':'unknown','reasonSha256':None} for i in range(1,16)}}

def summarize(packet,attestation,results):
    parts=partition_packets(packet)
    contextual=packet['version']==3
    base_domains=[{'handKey':h['handKey'],'committedAtMs':h['committedAtMs'],'expectedActions':len(h['actions']),'domainDigest':digest(h['actions']),**({'context':h['context']} if contextual else {})} for h in packet['hands']]
    domains=attestation.get('handDomains')
    if not isinstance(domains,list) or len(domains)!=len(base_domains):raise ValueError('census_domains')
    for expected,actual in zip(base_domains,domains):
        if not isinstance(actual,dict) or set(actual)!={*expected,'nonDecisionDiagnostics'} or any(actual[k]!=v for k,v in expected.items()):raise ValueError('census_domain')
        if validate_diagnostics(actual['nonDecisionDiagnostics'])['unknownNonDecision']:raise ValueError('unknown_nondecision')
    if attestation.get('packetDigest')!=transport_digest(packet) or attestation.get('sourceSha')!=packet['sourceSha'] or attestation.get('cohortDigest')!=digest({'version':1,'horseIds':packet['horseIds']}) or attestation.get('rosterCount')!=1000 or attestation.get('authority')!='canonical_database_snapshot' or attestation.get('ownership')!='accepted_hand_commit_window' or attestation.get('selectedHands')!=len(packet['hands']) or attestation.get('expectedActions')!=sum(len(h['actions']) for h in packet['hands']) or attestation.get('handDomains')!=domains:raise ValueError('census_attestation')
    if len(results)>len(parts):raise ValueError('census_partitions')
    turns=[];bindings=[];identity=None;extras=unbound=0
    for index,part in enumerate(parts):
        expected=expected_rows(part)
        if index>=len(results):turns.extend(missing_row(r,contextual) for r in expected);continue
        result=results[index];e=result.get('execution',{});o=e.get('observation',{})
        if (result.get('qualifiedExecution') is not True or result.get('sourceSha')!=packet['sourceSha'] or result.get('packetDigest')!=transport_digest(part)
            or e.get('release')!=packet['sourceSha'] or e.get('exitCode') not in (0,2) or e.get('containerExitCode')!=e.get('exitCode') or e.get('sameServingIdentityAfter') is not True
            or e.get('observerRemoved') is not True or e.get('cleanupExitCode')!=0 or e.get('oomKilled') is not False or e.get('readOnly') is not True or e.get('network')!='none' or e.get('horseJournalMountVerified') is not True):raise ValueError('census_execution_binding')
        current=(e.get('servingContainer'),e.get('imageId'),e.get('servingStartedAt'))
        if not isinstance(current[0],str) or not re.fullmatch('[0-9a-f]{64}',current[0]) or not isinstance(current[1],str) or not re.fullmatch('sha256:[0-9a-f]{64}',current[1]) or not isinstance(current[2],str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z',current[2]):raise ValueError('census_identity')
        if identity is not None and current!=identity:raise ValueError('census_identity_changed')
        identity=current
        allowed={'version','scope','status','rawRecordsExported','replayVerified','completePopulation','strategyCorrectnessVerified','activationAllowed','sourceSha','packetDigest','expectedTurns','validatedBytes','boundReached','missingTurns','contradictoryTurns','extraneousCaptures','unboundCaptures','inspectedHands','remainingHands','turns'}
        if not isinstance(o,dict) or set(o)!=allowed or o['version']!=packet['version'] or o['scope']!='supplied_committed_turn_census' or o['status'] not in ('observed','unknown') or any(o[k] is not False for k in ('rawRecordsExported','replayVerified','completePopulation','strategyCorrectnessVerified','activationAllowed')) or o['sourceSha']!=packet['sourceSha'] or o['packetDigest']!=transport_digest(part) or o['expectedTurns']!=len(expected) or not isinstance(o['turns'],list) or len(o['turns'])!=len(expected):raise ValueError('census_observation')
        for k in ('validatedBytes','missingTurns','contradictoryTurns','extraneousCaptures','unboundCaptures','inspectedHands','remainingHands'):
            if type(o[k]) is not int or o[k]<0:raise ValueError('census_count')
        if type(o['boundReached']) is not bool or o['inspectedHands']+o['remainingHands']!=len(part['hands']):raise ValueError('census_hand_counts')
        for original,row in zip(expected,o['turns']):
            validate_turn(row,contextual)
            if any(row[k]!=v for k,v in original.items()):raise ValueError('census_expected_omission')
            turns.append(row)
        extras+=o['extraneousCaptures'];unbound+=o['unboundCaptures']
        bindings.append({'packetDigest':transport_digest(part),'servingContainer':current[0],'imageId':current[1],'servingStartedAt':current[2]})
    ledger={'schema':('horse-turn-census-ledger-v2' if contextual else 'horse-turn-census-ledger-v1'),'sourceSha':packet['sourceSha'],'cohortDigest':attestation['cohortDigest'],'rosterCount':1000,'observations':[{'packetDigest':transport_digest(packet),'window':packet['window'],'handDomains':domains,'partitions':bindings}],'turns':turns,'extraneousCaptures':extras,'unboundCaptures':unbound,'completePopulation':False,'allPhasesVerified':False,'strategyCorrectnessVerified':False,'durablePersistenceVerified':False}
    return ledger_summary(validate_ledger(ledger))

def validate_ledger(ledger):
    if not isinstance(ledger,dict) or set(ledger)!={'schema','sourceSha','cohortDigest','rosterCount','observations','turns','extraneousCaptures','unboundCaptures','completePopulation','allPhasesVerified','strategyCorrectnessVerified','durablePersistenceVerified'} or ledger['schema'] not in ('horse-turn-census-ledger-v1','horse-turn-census-ledger-v2') or ledger['rosterCount']!=1000 or not re.fullmatch('[0-9a-f]{40}',ledger['sourceSha']) or not re.fullmatch('[0-9a-f]{64}',ledger['cohortDigest']) or any(ledger[k] is not False for k in ('completePopulation','allPhasesVerified','strategyCorrectnessVerified','durablePersistenceVerified')):raise ValueError('census_ledger')
    contextual=ledger['schema']=='horse-turn-census-ledger-v2'
    intervals=[];packets=set();domains={}
    if not isinstance(ledger['observations'],list) or not 1<=len(ledger['observations'])<=16:raise ValueError('census_observations')
    for b in ledger['observations']:
        if set(b)!={'packetDigest','window','handDomains','partitions'} or not re.fullmatch('[0-9a-f]{64}',b['packetDigest']) or b['packetDigest'] in packets or not isinstance(b['partitions'],list) or len(b['partitions'])>16:raise ValueError('census_binding')
        packets.add(b['packetDigest']);w=b['window']
        if set(w)!={'startUtc','endUtc'}:raise ValueError('census_window')
        legacy.inputs({'FLEET_SOURCE_SHA':ledger['sourceSha'],'FLEET_FROM_UTC':w['startUtc'],'FLEET_TO_UTC':w['endUtc']})
        if any(w['startUtc']<end and start<w['endUtc'] for start,end in intervals):raise ValueError('census_overlap')
        intervals.append((w['startUtc'],w['endUtc']))
        first=int(datetime.fromisoformat(w['startUtc'].replace('Z','+00:00')).timestamp()*1000);last=int(datetime.fromisoformat(w['endUtc'].replace('Z','+00:00')).timestamp()*1000)
        if not isinstance(b['handDomains'],list) or not 1<=len(b['handDomains'])<=MAX_HANDS:raise ValueError('census_domains')
        for h in b['handDomains']:
            if not isinstance(h,dict) or set(h)!=({'handKey','committedAtMs','expectedActions','domainDigest','nonDecisionDiagnostics'}|({'context'} if contextual else set())) or not re.fullmatch('[0-9a-f]{64}',h['handKey']) or h['handKey'] in domains or type(h['committedAtMs']) is not int or not first<=h['committedAtMs']<last or type(h['expectedActions']) is not int or not 0<=h['expectedActions']<=PARTITION_TURN_LIMIT or not re.fullmatch('[0-9a-f]{64}',h['domainDigest']):raise ValueError('census_domain')
            if contextual:validate_context(h['context'])
            validate_diagnostics(h['nonDecisionDiagnostics'])
            domains[h['handKey']]=h['expectedActions']
        for p in b['partitions']:
            if set(p)!={'packetDigest','servingContainer','imageId','servingStartedAt'} or not re.fullmatch('[0-9a-f]{64}',p['packetDigest']) or not re.fullmatch('[0-9a-f]{64}',p['servingContainer']) or not re.fullmatch('sha256:[0-9a-f]{64}',p['imageId']) or not isinstance(p['servingStartedAt'],str):raise ValueError('census_partition_binding')
    keys=set();counts={k:0 for k in domains}
    if not isinstance(ledger['turns'],list) or len(ledger['turns'])>16*MAX_ACTIONS:raise ValueError('census_turn_bound')
    for row in ledger['turns']:
        validate_turn(row,contextual);key=(row['actorIndex'],row['handKey'],row['actionOrdinal'])
        if key in keys:raise ValueError('census_duplicate_turn')
        keys.add(key)
        if row['handKey'] not in counts:raise ValueError('census_unexpected_turn')
        counts[row['handKey']]+=1
    if counts!=domains:raise ValueError('census_ledger_omission')
    for k in ('extraneousCaptures','unboundCaptures'):
        if type(ledger[k]) is not int or ledger[k]<0:raise ValueError('census_ledger_count')
    return ledger

def ledger_summary(ledger):
    rows=ledger['turns'];observed={r['actorIndex'] for r in rows if r['expectedBinding']=='matched' and r['capture']=='present'}
    diagnostics={k:sum(h['nonDecisionDiagnostics'][k] for o in ledger['observations'] for h in o['handDomains']) for k in DIAGNOSTIC_KEYS}
    by_context={}
    contexts={h['handKey']:h.get('context') for o in ledger['observations'] for h in o['handDomains']}
    for r in rows:
        context=contexts[r['handKey']];key=(context['variant']+':'+context['format']) if context else 'unknown:unknown'
        cell=by_context.setdefault(key,{'expectedTurns':0,'matchedContextTurns':0,'actors':set()});cell['expectedTurns']+=1
        if r.get('contextBinding')=='matched':cell['matchedContextTurns']+=1;cell['actors'].add(r['actorIndex'])
    by_context={k:{**v,'actors':sorted(v['actors'])} for k,v in by_context.items()}
    return {'contextEvidence':by_context,'turnCensusLedger':ledger,'nonDecisionDiagnostics':diagnostics,'expectedTurns':len(rows),'observedHorses':len(observed),'unobservedHorses':1000-len(observed),'missingTurns':sum(r['capture']=='missing' for r in rows),'contradictoryTurns':sum(r['expectedBinding']=='contradictory' for r in rows),'inputBoundTurns':sum(r['inputBinding']=='canonical_digest_and_read_frame' for r in rows),'discardInputBoundTurns':sum(r['inputBinding']=='original_discard_request_and_controller' for r in rows),'completePopulation':False,'allPhasesVerified':False,'durablePersistenceVerified':False,'strategyCorrectnessVerified':False}

def union_ledgers(ledgers):
    if not 1<=len(ledgers)<=16:raise ValueError('census_union_bound')
    values=list({digest(validate_ledger(v)):v for v in ledgers}.values());out=json.loads(json.dumps(values[0]))
    for v in values[1:]:
        if any(v[k]!=out[k] for k in ('schema','sourceSha','cohortDigest','rosterCount')):raise ValueError('census_union_mismatch')
        out['observations'].extend(v['observations']);out['turns'].extend(v['turns']);out['extraneousCaptures']+=v['extraneousCaptures'];out['unboundCaptures']+=v['unboundCaptures'];validate_ledger(out)
    return ledger_summary(out)

def observe_bounded(packet_path,attestation_path,ssh_command,output_path):
    packet=legacy.private_json(packet_path,MAX_BYTES);attestation=legacy.private_json(attestation_path,MAX_BYTES);parts=partition_packets(packet)
    summarize(packet,attestation,[]) # authenticate independent denominator before any observer
    output=Path(output_path);transport=Path(ssh_command)
    if not output.is_absolute() or output.exists() or output.parent!=Path(packet_path).parent or not transport.is_absolute() or not transport.is_file() or transport.is_symlink():raise ValueError('private_output')
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);results=[];deadline=time.monotonic()+1800
    try:
        for index,part in enumerate(parts):
            if deadline-time.monotonic()<115:raise ValueError('census_deadline')
            path=output.parent/f'turn-partition-{index:02d}.json';result_path=output.parent/f'turn-partition-{index:02d}-result.json'
            part_fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(part_fd,'w') as f:json.dump(part,f,separators=(',',':'))
            run=subprocess.run(['node','server/scripts/phase6d-population.mjs','fleet-turns','--packet',str(path),'--ssh-command',str(transport),'--out',str(result_path)],capture_output=True,timeout=115)
            if run.returncode!=0:raise ValueError('census_observer_unavailable')
            result=legacy.private_json(result_path,2097152);summarize(packet,attestation,[*results,result]);results.append(result)
        summary=summarize(packet,attestation,results)
    except Exception:
        summary=summarize(packet,attestation,results);summary['partitionObservationUnavailable']=True
    with os.fdopen(fd,'w') as f:json.dump(summary,f,separators=(',',':'));f.write('\n')
    return summary

def main(argv=None):
    try:
        args=sys.argv[1:] if argv is None else argv
        if args and args[0]=='observe' and len(args)==5:
            print(json.dumps(observe_bounded(*args[1:])));return 0
        if args and args[0]=='union' and 2<=len(args)<=17:
            values=[]
            for name in args[1:]:
                path=Path(name)
                if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.stat().st_size>33554432:raise ValueError('census_union_file')
                values.append(json.loads(path.read_text()))
            print(json.dumps(union_ledgers([v.get('turnCensusLedger',v) for v in values])));return 0
        if len(args)!=3 or args[0]!='packet':raise ValueError('arguments')
        paths=[Path(p) for p in args[1:]]
        if any(not p.is_absolute() or p.exists() or p.is_symlink() for p in paths) or paths[0]==paths[1]:raise ValueError('private_output')
        sha,start,end=legacy.inputs(os.environ)
        result=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=query(start,end),text=True,capture_output=True,timeout=15,env=legacy.database_environment(os.environ))
        if result.returncode:raise ValueError('database_unavailable_or_bounds')
        if len(result.stdout.encode())>MAX_BYTES:raise ValueError('database_reply_bound')
        packet,attestation=packet_from_rows(json.loads(result.stdout),sha,start,end)
        for path,value in zip(paths,(packet,attestation)):
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f:json.dump(value,f,separators=(',',':'),allow_nan=False);f.write('\n')
        print(json.dumps({k:attestation[k] for k in ('version','packetDigest','cohortDigest','sourceSha','rosterCount','selectedHands','expectedActions','ownership','completePopulation','allPhasesVerified')}));return 0
    except Exception:
        # Exception strings may contain private database values. Never echo them.
        print(json.dumps({'status':'unavailable','reason':'turn_census_packet_refused','completePopulation':False,'allPhasesVerified':False}));return 2

if __name__=='__main__':sys.exit(main())
