#!/usr/bin/env python3
"""One explicit private canonical-cohort snapshot. SELECT only; no source rows,
credentials, actor IDs or database errors are printed. This is not capture or
15-phase qualification. The installed journal observer owns that separate read.
"""
import hashlib,json,os,re,subprocess,sys,time
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit,unquote,parse_qsl

def inputs(environment):
    sha=environment.get('FLEET_SOURCE_SHA','')
    start=environment.get('FLEET_FROM_UTC','');end=environment.get('FLEET_TO_UTC','')
    if not re.fullmatch('[0-9a-f]{40}',sha): raise ValueError('source')
    def utc(s):
        if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z',s):raise ValueError('utc')
        return datetime.fromisoformat(s.replace('Z','+00:00'))
    a,b=utc(start),utc(end)
    if not 0<(b-a).total_seconds()<=900 or b>datetime.now(timezone.utc):raise ValueError('window')
    return sha,start,end

def database_environment(environment):
    # libpq PGDATABASE is a database NAME, not a connection-URI argument.
    # Consume the configured secret internally into libpq's standard private
    # environment; credentials never become command arguments or output.
    env=dict(environment);url=urlsplit(env.pop('DATABASE_URL'))
    if url.scheme not in ('postgres','postgresql') or not url.hostname or not url.username or not url.path.startswith('/') or len(url.path)<2:raise ValueError('database_configuration')
    for key in ['PGSERVICE','PGSERVICEFILE']:env.pop(key,None)
    env.update(PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=unquote(url.username),PGPASSWORD=unquote(url.password or ''),PGDATABASE=unquote(url.path[1:]),PGCONNECT_TIMEOUT='5',PGAPPNAME='horse-fleet-readonly-observer')
    options={'sslmode':'PGSSLMODE','sslrootcert':'PGSSLROOTCERT','sslcert':'PGSSLCERT','sslkey':'PGSSLKEY','channel_binding':'PGCHANNELBINDING','gssencmode':'PGGSSENCMODE','options':'PGOPTIONS'}
    for key,value in parse_qsl(url.query,keep_blank_values=True,strict_parsing=True):
        if key not in options:raise ValueError('database_option')
        env[options[key]]=value
    return env

def query(start,end):
    # Timestamp literals have already passed a closed UTC grammar. No payload,
    # current player flags or cards are selected, and all joins use original keys.
    # The cash-admission roster is intentionally narrower than the whole fleet.
    # Verify every unretired registered identity without changing its eligibility.
    return fr"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='1500ms';
SET LOCAL lock_timeout='250ms';
SET LOCAL idle_in_transaction_session_timeout='5s';
SELECT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='idx_hand_history_created'
 AND i.indisvalid AND i.indisready AND pg_get_indexdef(c.oid)='CREATE INDEX idx_hand_history_created ON public.hand_history USING btree (created_at DESC)') AND EXISTS(SELECT 1 FROM pg_index j JOIN pg_class d ON d.oid=j.indexrelid JOIN pg_namespace m ON m.oid=d.relnamespace WHERE m.nspname='public' AND d.relname='idx_lightning_hand_hand_history_id' AND j.indisvalid AND j.indisready AND pg_get_indexdef(d.oid)='CREATE INDEX idx_lightning_hand_hand_history_id ON public.lightning_hand USING btree (hand_history_id)') AS fleet_time_index_ok
\gset
\if :fleet_time_index_ok
WITH cohort AS MATERIALIZED (
 SELECT horse_id::text FROM public.ca_horse_fleet_register
 WHERE retired_at IS NULL ORDER BY horse_id LIMIT 1001
), selected AS MATERIALIZED (
 SELECT id,table_id,hand_number,created_at FROM public.hand_history
 WHERE created_at>='{start}'::timestamptz AND created_at<'{end}'::timestamptz
 ORDER BY created_at DESC LIMIT 10001
), originals AS MATERIALIZED (
 SELECT h.id::text,h.table_id::text,h.hand_number::text,
        CASE WHEN l.hand_id IS NOT NULL THEN 'lightning' ELSE 'classic' END AS source_owner,
        CASE WHEN l.hand_id IS NOT NULL THEN
          CASE WHEN c.post_commit_payload #>> '{{accepted_hand_facts,horse_journal_identity,version}}'='1'
               THEN c.post_commit_payload #>> '{{accepted_hand_facts,horse_journal_identity,lease_generation}}' END
          ELSE s.lease_generation::text END AS lease_generation,
        (c.post_commit_completed_at IS NOT NULL AND (l.hand_id IS NULL OR
          (l.settled_at IS NOT NULL AND l.host_table_id=h.table_id AND l.hand_number=h.hand_number))) AS accepted
 FROM selected h LEFT JOIN public.lightning_hand l ON l.hand_history_id=h.id
 LEFT JOIN public.hand_atomic_commits c
 ON c.hand_id=h.id AND c.table_id=h.table_id AND c.hand_number=h.hand_number
 -- A Lightning receipt owns its original lease; do not probe the classic
 -- archive for those hands. OFFSET 0 retains the correlated one-time filter.
 LEFT JOIN LATERAL (
   SELECT lease_generation FROM smarter_private.hand_submissions
   WHERE l.hand_id IS NULL AND table_id=h.table_id AND hand_number=h.hand_number
   OFFSET 0
 ) s ON true
)
SELECT jsonb_build_object('snapshot',pg_current_snapshot()::text,'readAt',statement_timestamp(),
 'timeIndexValid',true,
 'horseIds',(SELECT jsonb_agg(horse_id ORDER BY horse_id) FROM cohort),
 'hands',(SELECT coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) FROM originals o));
\else
\quit
\endif
ROLLBACK;
"""

class PacketGap(ValueError):
    def __init__(self,reason,counts):super().__init__(reason);self.counts=counts

def packet_from_rows(rows,sha,start,end):
    uuid=re.compile('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    ids=rows.get('horseIds');hands=rows.get('hands')
    if rows.get('timeIndexValid') is not True or not rows.get('snapshot') or not rows.get('readAt'):raise ValueError('snapshot_or_index')
    if not isinstance(ids,list) or len(ids)!=1000 or len(set(ids))!=1000 or any(not isinstance(i,str) or not uuid.fullmatch(i) for i in ids):raise ValueError('canonical_cohort_not_1000')
    if not isinstance(hands,list):raise ValueError('accepted_source_reply_invalid')
    if not hands:raise ValueError('accepted_source_selection_empty')
    if len(hands)>10000:raise ValueError('accepted_source_hand_bound_reached')
    if any(not isinstance(h,dict) or h.get('source_owner') not in ('classic','lightning') for h in hands):raise ValueError('accepted_source_reply_invalid')
    pending=sum(h.get('accepted') is not True for h in hands)
    missing=sum(not isinstance(h.get('lease_generation'),str) or not uuid.fullmatch(h['lease_generation']) for h in hands)
    lightning_missing=sum(h['source_owner']=='lightning' and (not isinstance(h.get('lease_generation'),str) or not uuid.fullmatch(h['lease_generation'])) for h in hands)
    counts={'selectedHands':len(hands),'pendingOriginals':pending,'missingOriginalCoordinates':missing,'lightningMissingOriginalCoordinates':lightning_missing}
    if pending:raise PacketGap('original_acceptance_pending',counts)
    if missing:raise PacketGap('lightning_original_lease_unavailable' if lightning_missing else 'original_acceptance_unavailable',counts)
    keys=[]
    for h in hands:
        if h.get('accepted') is not True or not uuid.fullmatch(h.get('table_id') or '') or not uuid.fullmatch(h.get('id') or '') or not uuid.fullmatch(h.get('lease_generation') or '') or not re.fullmatch('[1-9][0-9]{0,17}',h.get('hand_number') or ''):raise ValueError('original_acceptance_unavailable')
        keys.append(hashlib.sha256(f"{h['table_id']}:{h['hand_number']}:{h['lease_generation']}".encode()).hexdigest())
    if len(set(keys))!=len(keys) or len({h['id'] for h in hands})!=len(hands):raise ValueError('duplicate_coordinate')
    packet={'version':1,'sourceSha':sha,'window':{'startUtc':start,'endUtc':end},'horseIds':ids,'handKeys':keys}
    digest=hashlib.sha256(json.dumps(packet,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    attestation={'version':1,'authority':'canonical_database_snapshot','rosterTable':'public.ca_horse_fleet_register','rosterPredicate':'retired_at IS NULL','cashEligibilityInferred':False,'snapshot':rows['snapshot'],'readAt':rows['readAt'],'sourceSha':sha,'packetDigest':digest,'rosterCount':1000,'selectedHands':len(keys),'sourceOwnerCounts':{owner:sum(h['source_owner']==owner for h in hands) for owner in ('classic','lightning')},'completePopulation':False,'allPhasesVerified':False}
    return packet,attestation

# Only maintained literal labels may leave the private observer. Unknown text is
# counted as unknown, never echoed (it could contain a player/card/credential).
PHASE_REASON_LABELS = frozenset([
 'utility_disabled_by_request','utility_refused','utility_context_unsupported',
 'utility_receipt_missing','utility_original_evidence_missing',
 'utility_original_evidence_mismatch','utility_domain_unavailable',
 'supported_uncalibrated_utility_baseline','protected_owner_independently_qualified',
 'owner_forced_not_independently_qualified','outside_domain','no_capability',
 'eligible_owner_did_not_complete','original_read_frame_mismatch',
 'original_owner_input_binding_missing','corrective_original_input_mismatch',
 'authority_withdrawn_before_acceptance','candidate_not_controller_accepted',
 'atlas_qualification_not_verified','preflop_attribution_missing',
])
PHASE_AXES = {
    'capability': {'captured','unobserved'},
    'eligibility': {'eligible','outside-domain','unknown'},
    'qualification': {'verified','owner-forced','unknown','refused'},
    'application': {'accepted','not-selected','shadow','refused','not-applicable','unknown'},
}
def phase_summary(observation):
    """Counts only, bound to the caller's canonical packet/serving-source proof.
    Older 'verified' owner counts did not distinguish forced admission. Preserve
    those reported counts, but never infer independent authority provenance.
    """
    evidence=observation.get('phaseEvidence')
    if evidence is None:return {'status':'unknown','reason':'phase_evidence_unavailable'}
    schema=observation.get('phaseProofSchema')
    if not isinstance(schema,dict) or schema.get('version')!='horse-fleet-phase-proof-v1' or schema.get('counterUnit')!='selected_accepted_decisions':raise ValueError('phase_schema')
    # Existing reader bounds: 10,000 selected hand keys, at most 256 records/hand.
    n=observation.get('acceptedDecisions')
    if type(n) is not int or not 0<=n<=2560000:raise ValueError('phase_counts')
    keys={f'phase{i}' for i in range(1,16)}
    if not isinstance(evidence,dict) or set(evidence)!=keys:raise ValueError('phase_keys')
    phases={}
    for key in sorted(keys,key=lambda x:int(x[5:])):
        row=evidence[key]
        if not isinstance(row,dict) or set(row)!={'capability','eligibility','qualification','application','reasons'}:raise ValueError('phase_axes')
        axes={}
        for axis,allowed in PHASE_AXES.items():
            counts=row[axis]
            if not isinstance(counts,dict) or not set(counts)<=allowed or any(type(v) is not int or not 0<=v<=n for v in counts.values()) or sum(counts.values())!=n:raise ValueError('phase_counts')
            axes[axis]=dict(counts)
        reasons=row['reasons']
        if not isinstance(reasons,dict) or any(not isinstance(k,str) or type(v) is not int or not 0<=v<=n for k,v in reasons.items()) or sum(reasons.values())!=n:raise ValueError('phase_reasons')
        independent=reasons.get('protected_owner_independently_qualified',0)
        forced=reasons.get('owner_forced_not_independently_qualified',0)
        if independent>axes['qualification'].get('verified',0) or forced!=axes['qualification'].get('owner-forced',0) or independent+forced>axes['eligibility'].get('eligible',0) or independent+forced>axes['capability'].get('captured',0):raise ValueError('phase_provenance_counts')
        axes['authorityProvenance']={'independentlyQualified':independent,'ownerForced':forced,'unknown':n-independent-forced}
        safe_reasons={}
        for reason,count in reasons.items():
            label=reason if reason in PHASE_REASON_LABELS else 'other_retained_phase_reason'
            safe_reasons[label]=safe_reasons.get(label,0)+count
        axes['reasons']=safe_reasons
        phases[key]=axes
    return {'status':'reported','schema':'horse-fleet-phase-summary-v1','counterUnit':'selected_accepted_decisions','acceptedDecisions':n,'phases':phases,'allPhasesVerified':False}

# Maintained fleet/reconciler closed literals only; never emit arbitrary keys.
CAPTURE_GAP_REASONS = frozenset(['accepted_hand_conflict', 'accepted_hand_missing', 'action_origin_unavailable', 'actor_outside_roster', 'binding_unavailable', 'bound_reached', 'capture_outside_window', 'capture_unavailable', 'decision_missing', 'decision_outside_window', 'discard_binding_unavailable', 'discard_capture_conflict', 'discard_decision_missing', 'discard_execution_missing', 'discard_input_mismatch', 'execution_conflict', 'execution_missing', 'fallback_lineage_unavailable', 'hand_bound_reached', 'input_mismatch', 'invalid_records', 'multiple_decisions_for_action', 'plan_receipt_conflict', 'plan_receipt_missing', 'plan_receipt_unbound', 'read_frame_unavailable', 'record_conflict', 'request_lifecycle_missing', 'source_mismatch', 'storage_close_unavailable', 'turn_conflict', 'unmatched_discard_action', 'unmatched_horse_action'])
def capture_counts(selected, observation):
    def count(value, maximum):
        if type(value) is not int or not 0<=value<=maximum:raise ValueError('capture_counts')
        return value
    selected=count(selected,10000)
    out={'selectedHands':selected,'inspectedHandsIsContinuationCursor':False,'inspectionMayIncludeIncompleteHand':True}
    fields={'inspectedHands':selected,'remainingHands':selected,'validatedBytes':(64+8)*1024*1024,'acceptedDecisions':256*selected}
    for key,maximum in fields.items():out[key]=count(observation[key],maximum) if key in observation else None
    if 'selectedHands' in observation and count(observation['selectedHands'],10000)!=selected:raise ValueError('capture_counts')
    if out['inspectedHands'] is not None and out['remainingHands'] is not None and out['inspectedHands']+out['remainingHands']!=selected:raise ValueError('capture_counts')
    for key in ['boundReached','captureUnfinished']:
        if key in observation and type(observation[key]) is not bool:raise ValueError('capture_counts')
        out[key]=observation.get(key)
    # fleet.charge increments before refusal; readFleetHand is bounded to
    # 8 MiB, so the diagnostic counter can exceed the unchanged 64 MiB budget
    # by one bounded read. This does not enlarge the observer's read limit.
    out['validatedBytesLimit']=64*1024*1024
    if out['validatedBytes'] is not None and out['validatedBytes']>out['validatedBytesLimit'] and (out['boundReached'] is not True or out['captureUnfinished'] is not True):raise ValueError('capture_counts')
    gaps=observation.get('gaps')
    out['gaps']=None
    if gaps is not None:
        if not isinstance(gaps,dict):raise ValueError('capture_gaps')
        safe={}
        for reason,value in gaps.items():
            number=count(value,256*selected+32)
            key=reason if reason in CAPTURE_GAP_REASONS else 'other_retained_capture_gap'
            safe[key]=safe.get(key,0)+number
        out['gaps']=safe
    out['missingFieldMeaning']='unknown'
    return out

def capture_diagnostics(attestation, observation):
    out=capture_counts(attestation.get('selectedHands'),observation)
    owners=attestation.get('sourceOwnerCounts')
    if not isinstance(owners,dict) or set(owners)!={'classic','lightning'} or any(type(v) is not int or not 0<=v<=10000 for v in owners.values()) or sum(owners.values())!=out['selectedHands']:raise ValueError('capture_source_counts')
    return {**out,'sourceOwnerCounts':dict(owners)}

def read_evidence(attestation,result,observation,packet):
    unknown={'status':'unknown','reason':'retained_read_evidence_unavailable'}
    if packet is None:return dict(unknown),dict(unknown)
    digest=hashlib.sha256(json.dumps(packet,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    ids=packet.get('horseIds');rows=observation.get('horses')
    if digest!=attestation.get('packetDigest') or packet.get('sourceSha')!=attestation.get('sourceSha') or not isinstance(ids,list) or len(ids)!=1000 or any(not isinstance(id,str) or re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',id) is None for id in ids) or len(set(ids))!=1000:raise ValueError('read_packet')
    if rows is None:return dict(unknown),dict(unknown)
    if not isinstance(rows,list) or len(rows)!=1000 or any(not isinstance(h,dict) or not isinstance(h.get('horseId'),str) for h in rows) or {h['horseId'] for h in rows}!=set(ids):raise ValueError('read_cohort')
    def count(v,maximum):
        if type(v) is not int or not 0<=v<=maximum:raise ValueError('read_counts')
        return v
    maximum=256*count(attestation.get('selectedHands'),10000)
    total=count(observation['acceptedDecisions'],maximum) if 'acceptedDecisions' in observation else None
    for h in rows:
        if 'acceptedDecisions' in h:count(h['acceptedDecisions'],total if total is not None else maximum)
    if total is None or any('acceptedDecisions' not in h for h in rows):return dict(unknown),dict(unknown)
    ns=[count(h.get('acceptedDecisions'),total) for h in rows]
    if sum(ns)!=total or sum(n>0 for n in ns)!=observation.get('observedHorses'):raise ValueError('read_counts')
    if any('retainedReceiptCounts' not in h for h in rows) or not any(isinstance(h.get('retainedReceiptCounts'),dict) and set(h['retainedReceiptCounts'])&{'pooledPublicReads','independentPublicReads'} for h in rows):public=dict(unknown)
    else:
        pooled=[];independent=[]
        for h,n in zip(rows,ns):
            counts=h['retainedReceiptCounts']
            if not isinstance(counts,dict):raise ValueError('read_counts')
            a=count(counts.get('pooledPublicReads',0),n);b=count(counts.get('independentPublicReads',0),n)
            if a+b>n:raise ValueError('read_counts')
            pooled.append(a);independent.append(b)
        public={'status':'reported','scope':'selected_accepted_decisions','pooledPublicReadDecisions':sum(pooled),'pooledPublicReadHorses':sum(n>0 for n in pooled),'independentPublicReadDecisions':sum(independent),'independentPublicReadHorses':sum(n>0 for n in independent),'unclassifiedReadDecisions':total-sum(pooled)-sum(independent),'completePopulation':False,'allPhasesVerified':False}
    top=observation.get('riverLearningEvidence')
    if public.get('status')=='unknown' or top is None or any('riverLearning' not in h or 'retainedReceiptCounts' not in h for h in rows):return public,dict(unknown)
    if not isinstance(top,dict) or top.get('scope')!='at_least_one_qualified_observer_context' or top.get('counterMeaning')!='maximum_scoped_opponent_samples_per_accepted_read' or top.get('readBasis')!='original_individual_scoped_basic_counters':raise ValueError('river_schema')
    fields={'qualifiedReadDecisions':'qualifiedReadHorses','ownHistoryLoadedDecisions':'ownHistoryLoadedHorses','positiveSampleDecisions':'positiveSampleHorses','positiveSampleWithHistoryDecisions':'positiveSampleWithHistoryHorses','retainedHistoryRiverSampleDecisions':'retainedHistoryRiverSampleHorses'}
    sums={k:0 for k in fields};horses={v:0 for v in fields.values()};basis_total=0;basis_horses=0
    for h,n in zip(rows,ns):
        learning=h['riverLearning']
        if not isinstance(learning,dict):raise ValueError('river_counts')
        if any(k not in learning for k in fields) or 'qualifiedReadBasisCounts' not in learning:return public,dict(unknown)
        values={k:count(learning[k],n) for k in fields};basis=learning['qualifiedReadBasisCounts']
        if not isinstance(basis,dict) or not set(basis)<={'individual_scoped_basic_component_of_pooled_public_receipt','independent_public_receipt'}:raise ValueError('river_basis')
        b=count(basis.get('individual_scoped_basic_component_of_pooled_public_receipt',0),n);i=count(basis.get('independent_public_receipt',0),n)
        if b+i!=values['qualifiedReadDecisions'] or b>h['retainedReceiptCounts'].get('pooledPublicReads',0) or i>h['retainedReceiptCounts'].get('independentPublicReads',0):raise ValueError('river_basis')
        if values['positiveSampleWithHistoryDecisions']>min(values['positiveSampleDecisions'],values['ownHistoryLoadedDecisions']) or values['positiveSampleDecisions']>values['qualifiedReadDecisions'] or values['ownHistoryLoadedDecisions']>values['qualifiedReadDecisions'] or values['retainedHistoryRiverSampleDecisions']>values['positiveSampleWithHistoryDecisions']:raise ValueError('river_counts')
        basis_total+=b;basis_horses+=int(b>0)
        for k,v in fields.items():sums[k]+=values[k];horses[v]+=int(values[k]>0)
    expected={**horses,'pooledIndividualScopedBasicReadHorses':basis_horses,'pooledIndividualScopedBasicReadDecisions':basis_total}
    for k,v in expected.items():
        if k not in top:return public,dict(unknown)
        if count(top[k],maximum)!=v:raise ValueError('river_totals')
    return public,{'status':'reported','scope':'selected_accepted_decisions','readBasis':'original_individual_scoped_basic_counters',**sums,**expected,'completePopulation':False,'allContextsVerified':False,'durablePersistenceVerified':False,'strategyApplicationVerified':False,'allPhasesVerified':False}

def summarize(attestation,result,packet=None):
    observation=(result.get('execution') or {}).get('observation') or {}
    count=observation.get('observedHorses')
    if not isinstance(count,int) or isinstance(count,bool) or not 0<=count<=1000:raise ValueError('counts')
    canonical=(attestation.get('authority')=='canonical_database_snapshot' and attestation.get('rosterCount')==1000 and bool(attestation.get('snapshot')) and re.fullmatch('[0-9a-f]{64}',attestation.get('packetDigest','')) is not None and attestation.get('packetDigest')==result.get('packetDigest') and attestation.get('sourceSha')==result.get('sourceSha') and result.get('qualifiedExecution') is True)
    public,river=read_evidence(attestation,result,observation,packet) if canonical else ({'status':'unknown','reason':'canonical_binding_unverified'},)*2
    complete=canonical and observation.get('completeHorseCoverage') is True and count==1000
    return {'publicReadEvidence':public,'riverLearningEvidence':river,'canonicalRosterVerified':bool(canonical),'packetDigest':attestation.get('packetDigest') if canonical else None,'observedHorses':count,'unobservedHorses':1000-count,'completeCanonicalHorseCoverage':bool(complete),'completePopulation':False,'allPhasesVerified':False,'captureDiagnostics':capture_diagnostics(attestation,observation) if canonical else {'status':'unknown','reason':'canonical_binding_unverified'},'phaseEvidence':phase_summary(observation) if canonical else {'status':'unknown','reason':'canonical_binding_unverified'}}

# The old 632-hand observation exhausted 64 MiB after 176 hands. A 64-hand
# partition is less than half that observed capacity, not a new reader limit:
# unusually large hands still refuse under the installed 64 MiB/30 s budget.
# Sixteen partitions bound this one operation to 1,024 original hands. Never
# truncate, retry a partial hand, enlarge a reader budget, or treat inspected
# hands as a cursor. All partitions are declared before the first journal read.
FLEET_PARTITION_HANDS=64
FLEET_PARTITIONS=16
FLEET_OPERATION_SECONDS=16*115+30

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def partition_packets(packet,attestation):
    ids=packet.get('horseIds');keys=packet.get('handKeys')
    uuid=r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (packet.get('version')!=1 or not re.fullmatch('[0-9a-f]{40}',packet.get('sourceSha',''))
        or not isinstance(ids,list) or len(ids)!=1000 or len(set(ids))!=1000
        or any(not isinstance(i,str) or not re.fullmatch(uuid,i) for i in ids)
        or not isinstance(keys,list) or not 1<=len(keys)<=FLEET_PARTITION_HANDS*FLEET_PARTITIONS
        or any(not isinstance(k,str) or not re.fullmatch('[0-9a-f]{64}',k) for k in keys)
        or len(set(keys))!=len(keys)):
        raise ValueError('partition_packet_bounds')
    inputs({'FLEET_SOURCE_SHA':packet['sourceSha'],'FLEET_FROM_UTC':packet.get('window',{}).get('startUtc',''),'FLEET_TO_UTC':packet.get('window',{}).get('endUtc','')})
    if (attestation.get('authority')!='canonical_database_snapshot'
        or attestation.get('rosterTable')!='public.ca_horse_fleet_register'
        or attestation.get('rosterPredicate')!='retired_at IS NULL'
        or attestation.get('cashEligibilityInferred') is not False
        or attestation.get('rosterCount')!=1000 or not attestation.get('snapshot')
        or not attestation.get('readAt') or attestation.get('sourceSha')!=packet['sourceSha']
        or attestation.get('packetDigest')!=digest(packet)
        or attestation.get('selectedHands')!=len(keys)):
        raise ValueError('partition_canonical_binding')
    # Lexical ordering is deterministic even when SQL's JSON aggregate order
    # changes. The manifest records these exact subsets, not offsets to retry.
    keys=sorted(keys)
    return [{**packet,'handKeys':keys[i:i+FLEET_PARTITION_HANDS]}
            for i in range(0,len(keys),FLEET_PARTITION_HANDS)]

def union_read_evidence(packet,attestation,parts,results):
    # Validate original evidence against each exact subset before combining.
    # Decision counts are disjoint by hand; horse populations require set union.
    unknown={'status':'unknown','reason':'retained_read_evidence_unavailable'}
    if not results:return dict(unknown),dict(unknown)
    public_known=True;river_known=True;total=0
    counts={'pooledPublicReadDecisions':0,'independentPublicReadDecisions':0}
    public_horses={'pooledPublicReadHorses':set(),'independentPublicReadHorses':set()}
    fields={'qualifiedReadDecisions':'qualifiedReadHorses','ownHistoryLoadedDecisions':'ownHistoryLoadedHorses','positiveSampleDecisions':'positiveSampleHorses','positiveSampleWithHistoryDecisions':'positiveSampleWithHistoryHorses','retainedHistoryRiverSampleDecisions':'retainedHistoryRiverSampleHorses'}
    river_counts={k:0 for k in fields};river_horses={v:set() for v in fields.values()}
    basis_total=0;basis_horses=set()
    for part,result in zip(parts,results):
        o=result['execution']['observation']
        bound={**attestation,'packetDigest':digest(part),'selectedHands':len(part['handKeys'])}
        public,river=read_evidence(bound,result,o,part)
        public_known=public_known and public.get('status')=='reported'
        river_known=river_known and river.get('status')=='reported'
        total+=o['acceptedDecisions']
        if public.get('status')=='reported':
            for h in o['horses']:
                for key,decision,horse in [('pooledPublicReads','pooledPublicReadDecisions','pooledPublicReadHorses'),('independentPublicReads','independentPublicReadDecisions','independentPublicReadHorses')]:
                    n=h['retainedReceiptCounts'].get(key,0);counts[decision]+=n
                    if n:public_horses[horse].add(h['horseId'])
        if river.get('status')=='reported':
            for h in o['horses']:
                for decision,horse in fields.items():
                    n=h['riverLearning'][decision];river_counts[decision]+=n
                    if n:river_horses[horse].add(h['horseId'])
                n=h['riverLearning']['qualifiedReadBasisCounts'].get('individual_scoped_basic_component_of_pooled_public_receipt',0)
                basis_total+=n
                if n:basis_horses.add(h['horseId'])
    public=({'status':'reported','scope':'selected_accepted_decisions',**counts,**{k:len(v) for k,v in public_horses.items()},'unclassifiedReadDecisions':total-sum(counts.values()),'completePopulation':False,'allPhasesVerified':False} if public_known else dict(unknown))
    river=({'status':'reported','scope':'selected_accepted_decisions','readBasis':'original_individual_scoped_basic_counters',**river_counts,**{k:len(v) for k,v in river_horses.items()},'pooledIndividualScopedBasicReadHorses':len(basis_horses),'pooledIndividualScopedBasicReadDecisions':basis_total,'completePopulation':False,'allContextsVerified':False,'durablePersistenceVerified':False,'strategyApplicationVerified':False,'allPhasesVerified':False} if public_known and river_known else dict(unknown))
    return public,river

LEDGER_SCHEMA='horse-fleet-indexed-evidence-v1'
LEDGER_COUNTS=('acceptedDecisions','pooledPublicReadDecisions','independentPublicReadDecisions','qualifiedOriginalReadDecisions')

def indexed_ledger(packet,attestation,results):
    """Retain coverage by stable canonical ordinal, never an actor or payload.
    Counts prove accepted journal/read evidence only, not decision optimality or
    durable plan effects. Raw source rows remain in the private ephemeral owner.
    """
    ids=sorted(packet['horseIds']);positions={actor:i for i,actor in enumerate(ids)}
    rows=[{'index':i,**{k:0 for k in LEDGER_COUNTS},'phaseAcceptedApplications':{}} for i in range(1000)]
    bindings=[]
    for part,result in zip(partition_packets(packet,attestation),results):
        e=result['execution'];o=e['observation']
        bound={**attestation,'packetDigest':digest(part),'selectedHands':len(part['handKeys'])}
        public,river=read_evidence(bound,result,o,part)
        bindings.append({'packetDigest':result['packetDigest'],'window':packet['window'],
            'servingContainer':e['servingContainer'],'imageId':e['imageId'],'servingStartedAt':e['servingStartedAt']})
        for h in o['horses']:
            row=rows[positions[h['horseId']]];n=h['acceptedDecisions']
            row['acceptedDecisions']+=n
            receipts=h.get('retainedReceiptCounts');learning=h.get('riverLearning')
            for output,key in [('pooledPublicReadDecisions','pooledPublicReads'),('independentPublicReadDecisions','independentPublicReads')]:
                value=(receipts.get(key,0) if public.get('status')=='reported' and isinstance(receipts,dict) and any(k in receipts for k in ('pooledPublicReads','independentPublicReads')) else None) if n else 0
                row[output]=None if row[output] is None or value is None else row[output]+value
            value=(learning.get('qualifiedReadDecisions') if river.get('status')=='reported' and isinstance(learning,dict) else None) if n else 0
            row['qualifiedOriginalReadDecisions']=None if row['qualifiedOriginalReadDecisions'] is None or value is None else row['qualifiedOriginalReadDecisions']+value
            for phase,count in h['phaseAcceptedApplications'].items():
                row['phaseAcceptedApplications'][phase]=row['phaseAcceptedApplications'].get(phase,0)+count
    # One operation window owns disjoint hand partitions. Keep that binding
    # together so later unions cannot accidentally sum overlapping windows.
    observation={'packetDigest':digest(packet),'window':packet['window'],
        'partitionDigests':[b['packetDigest'] for b in bindings],
        'servingContainer':bindings[0]['servingContainer'] if bindings else None,
        'imageId':bindings[0]['imageId'] if bindings else None,
        'servingStartedAt':bindings[0]['servingStartedAt'] if bindings else None}
    ledger={'schema':LEDGER_SCHEMA,'cohortDigest':digest({'version':1,'horseIds':ids}),
        'sourceSha':packet['sourceSha'],'rosterCount':1000,'indexBasis':'lexically_sorted_canonical_cohort',
        'observations':[observation] if bindings else [],'rows':rows,
        'decisionCorrectness':'unknown','planEffectPersistence':'unknown','profitability':'unknown',
        'completePopulation':False,'allPhasesVerified':False}
    return validate_indexed_ledger(ledger) if bindings else None

def validate_indexed_ledger(value):
    expected={'schema','cohortDigest','sourceSha','rosterCount','indexBasis','observations','rows',
        'decisionCorrectness','planEffectPersistence','profitability','completePopulation','allPhasesVerified'}
    if (not isinstance(value,dict) or set(value)!=expected or value['schema']!=LEDGER_SCHEMA
        or not re.fullmatch('[0-9a-f]{64}',value.get('cohortDigest',''))
        or not re.fullmatch('[0-9a-f]{40}',value.get('sourceSha','')) or value['rosterCount']!=1000
        or value['indexBasis']!='lexically_sorted_canonical_cohort'
        or any(value[k]!='unknown' for k in ('decisionCorrectness','planEffectPersistence','profitability'))
        or value['completePopulation'] is not False or value['allPhasesVerified'] is not False):raise ValueError('indexed_ledger_header')
    observations=value['observations'];rows=value['rows']
    if not isinstance(observations,list) or not 1<=len(observations)<=16:raise ValueError('indexed_ledger_bindings')
    intervals=[];packets=set()
    for b in observations:
        if (not isinstance(b,dict) or set(b)!={'packetDigest','window','partitionDigests','servingContainer','imageId','servingStartedAt'}
            or not re.fullmatch('[0-9a-f]{64}',b.get('packetDigest','')) or b['packetDigest'] in packets
            or not re.fullmatch('[0-9a-f]{64}',b.get('servingContainer',''))
            or not re.fullmatch('sha256:[0-9a-f]{64}',b.get('imageId',''))
            or not isinstance(b.get('servingStartedAt'),str)
            or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z',b['servingStartedAt'])):raise ValueError('indexed_ledger_binding')
        packets.add(b['packetDigest']);parts=b['partitionDigests'];window=b['window']
        if not isinstance(parts,list) or not 1<=len(parts)<=16 or len(set(parts))!=len(parts) or any(not isinstance(p,str) or not re.fullmatch('[0-9a-f]{64}',p) for p in parts):raise ValueError('indexed_ledger_partitions')
        if not isinstance(window,dict) or set(window)!={'startUtc','endUtc'}:raise ValueError('indexed_ledger_window')
        inputs({'FLEET_SOURCE_SHA':value['sourceSha'],'FLEET_FROM_UTC':window['startUtc'],'FLEET_TO_UTC':window['endUtc']})
        interval=(window['startUtc'],window['endUtc'])
        if any(interval[0]<end and start<interval[1] for start,end in intervals):raise ValueError('indexed_ledger_overlap')
        intervals.append(interval)
    if not isinstance(rows,list) or len(rows)!=1000:raise ValueError('indexed_ledger_rows')
    for index,row in enumerate(rows):
        if not isinstance(row,dict) or set(row)!={'index',*LEDGER_COUNTS,'phaseAcceptedApplications'} or row['index']!=index or type(row['index']) is not int:raise ValueError('indexed_ledger_row')
        n=row['acceptedDecisions']
        if type(n) is not int or not 0<=n<=16*256*1024:raise ValueError('indexed_ledger_count')
        for key in LEDGER_COUNTS[1:]:
            v=row[key]
            if v is not None and (type(v) is not int or not 0<=v<=n):raise ValueError('indexed_ledger_count')
        a=row['pooledPublicReadDecisions'];b=row['independentPublicReadDecisions']
        if a is not None and b is not None and a+b>n:raise ValueError('indexed_ledger_read_count')
        phases=row['phaseAcceptedApplications']
        if not isinstance(phases,dict) or any(k not in {f'phase{i}' for i in range(1,16)} or type(v) is not int or not 0<=v<=n for k,v in phases.items()):raise ValueError('indexed_ledger_phase')
    return value

def union_indexed_ledgers(ledgers):
    """Only disjoint windows are additive. Identical retries count once;
    different source/cohort or overlapping observations remain a refusal.
    """
    if not isinstance(ledgers,list) or not 1<=len(ledgers)<=16:raise ValueError('indexed_ledger_union_bound')
    unique={digest(validate_indexed_ledger(v)):v for v in ledgers}
    values=list(unique.values());first=values[0]
    out=json.loads(json.dumps(first))
    for value in values[1:]:
        if any(value[k]!=first[k] for k in ('cohortDigest','sourceSha','rosterCount','indexBasis')):raise ValueError('indexed_ledger_union_mismatch')
        out['observations'].extend(value['observations'])
        # Reject overlap before adding counts, including partially repeated unions.
        validate_indexed_ledger({**out,'rows':first['rows']})
        for target,row in zip(out['rows'],value['rows']):
            for key in LEDGER_COUNTS:
                target[key]=None if target[key] is None or row[key] is None else target[key]+row[key]
            for phase,count in row['phaseAcceptedApplications'].items():
                target['phaseAcceptedApplications'][phase]=target['phaseAcceptedApplications'].get(phase,0)+count
    return validate_indexed_ledger(out)

def bounded_summary(packet,attestation,results):
    parts=partition_packets(packet,attestation)
    if not isinstance(results,list) or len(results)>len(parts):raise ValueError('partition_results')
    roster=set(packet['horseIds']);observed=set();identity=None
    phase_rows={f'phase{i}':{axis:{} for axis in [*PHASE_AXES,'reasons']} for i in range(1,16)}
    n=0;bytes_read=0;inspected=0;gaps={};complete=len(results)==len(parts)
    partition_status=[]
    for part,result in zip(parts,results):
        e=result.get('execution') or {};o=e.get('observation') or {}
        if (result.get('qualifiedExecution') is not True or result.get('sourceSha')!=packet['sourceSha']
            or result.get('packetDigest')!=digest(part) or o.get('packetDigest')!=digest(part)
            or o.get('sourceSha')!=packet['sourceSha'] or o.get('window')!=packet['window']
            or e.get('exitCode') not in (0,2) or e.get('containerExitCode')!=e.get('exitCode')
            or e.get('release')!=packet['sourceSha'] or e.get('sameServingIdentityAfter') is not True
            or e.get('observerRemoved') is not True or e.get('cleanupExitCode')!=0
            or e.get('oomKilled') is not False or e.get('readOnly') is not True
            or e.get('network')!='none' or e.get('horseJournalMountVerified') is not True
            or not re.fullmatch('[0-9a-f]{64}',e.get('servingContainer',''))
            or not re.fullmatch('sha256:[0-9a-f]{64}',e.get('imageId',''))
            or not e.get('servingStartedAt')
            or o.get('limits')!={'shards':32,'hands':10000,'validatedBytes':64*1024*1024,'elapsedMs':30000}
            or type(o.get('observedHorses')) is not int):raise ValueError('partition_execution_binding')
        current=(e['servingContainer'],e['imageId'],e['servingStartedAt'])
        if identity is not None and identity!=current:raise ValueError('partition_serving_changed')
        identity=current
        # Reuse the original exact bounds and phase-axis checks per partition.
        d=capture_counts(len(part['handKeys']),o)
        if any(d[k] is None for k in ['inspectedHands','remainingHands','validatedBytes','acceptedDecisions','boundReached','captureUnfinished','gaps']):
            raise ValueError('partition_capture_unknown')
        if phase_summary(o).get('status')!='reported':raise ValueError('partition_phase_unknown')
        horses=o.get('horses')
        if not isinstance(horses,list) or len(horses)!=1000:raise ValueError('partition_horses')
        seen=set();horse_count=0;part_observed=0
        accepted_by_phase={f'phase{i}':0 for i in range(1,16)}
        for horse in horses:
            actor=horse.get('horseId');count=horse.get('acceptedDecisions')
            if actor not in roster or actor in seen or type(count) is not int or not 0<=count<=d['acceptedDecisions']:raise ValueError('partition_horses')
            statuses=horse.get('phaseStatusCounts');applications=horse.get('phaseAcceptedApplications')
            if (not isinstance(statuses,dict) or not isinstance(applications,dict)
                or set(statuses)!=(set(accepted_by_phase) if count else set())
                or not set(applications)<=set(accepted_by_phase)):raise ValueError('partition_horse_phases')
            for phase in accepted_by_phase:
                values=statuses.get(phase,[0]*6);accepted=applications.get(phase,0)
                if (not isinstance(values,list) or len(values)!=6
                    or any(type(v) is not int or not 0<=v<=count for v in values) or sum(values)!=count
                    or type(accepted) is not int or not 0<=accepted<=count):raise ValueError('partition_horse_phases')
                accepted_by_phase[phase]+=accepted
            seen.add(actor);horse_count+=count
            if count:observed.add(actor);part_observed+=1
        if seen!=roster or horse_count!=o['acceptedDecisions'] or part_observed!=o.get('observedHorses'):
            raise ValueError('partition_horse_counts')
        for phase,row in o['phaseEvidence'].items():
            if accepted_by_phase[phase]!=row['application'].get('accepted',0):raise ValueError('partition_horse_phase_counts')
            for axis,counts in row.items():
                for label,count in counts.items():
                    phase_rows[phase][axis][label]=phase_rows[phase][axis].get(label,0)+count
        n+=o['acceptedDecisions'];bytes_read+=d['validatedBytes'];inspected+=d['inspectedHands']
        for label,count in d['gaps'].items():gaps[label]=gaps.get(label,0)+count
        finished=(d['remainingHands']==0 and not d['boundReached'] and not d['captureUnfinished'])
        complete=complete and finished and not d['gaps']
        partition_status.append({'packetDigest':digest(part),'selectedHands':len(part['handKeys']),
            'inspectedHands':d['inspectedHands'],'boundReached':d['boundReached'],'captureUnfinished':d['captureUnfinished'],
            'validatedBytes':d['validatedBytes'],'acceptedDecisions':d['acceptedDecisions']})
    public,river=union_read_evidence(packet,attestation,parts,results)
    summary={'schema':'horse-fleet-bounded-summary-v1','canonicalRosterVerified':True,
        'publicReadEvidence':public,'riverLearningEvidence':river,
        'packetDigest':digest(packet),'partitionManifestDigest':digest([digest(p) for p in parts]),
        'sourceSha':packet['sourceSha'],'window':packet['window'],
        'plannedPartitions':len(parts),'completedPartitions':len(results),'partitions':partition_status,
        'selectedHands':len(packet['handKeys']),'inspectedHands':inspected,'validatedBytes':bytes_read,
        'perPartitionValidatedBytesLimit':64*1024*1024,'acceptedDecisions':n,
        'observedHorses':len(observed),'unobservedHorses':1000-len(observed),
        'completeCapture':bool(complete),'completeCanonicalHorseCoverage':bool(complete and len(observed)==1000),
        'completePopulation':False,'allPhasesVerified':False,'gaps':gaps,
        'indexedEvidenceLedger':indexed_ledger(packet,attestation,results),
        'phaseEvidence':phase_summary({'acceptedDecisions':n,'phaseProofSchema':{'version':'horse-fleet-phase-proof-v1','counterUnit':'selected_accepted_decisions'},'phaseEvidence':phase_rows})}
    return summary

def private_json(path,limit=2097152):
    p=Path(path)
    if not p.is_absolute() or not p.is_file() or p.is_symlink() or p.stat().st_size>limit or p.stat().st_mode&0o077:raise ValueError('private_result')
    return json.loads(p.read_text())

FLEET_FAILURE_CODES=frozenset(('fleet_private_paths','fleet_packet','fleet_window','fleet_setup_unavailable',
    'transport_timeout','transport_unavailable','transport_nonzero','transport_output_invalid',
    'remote_observer_unavailable','observer_oom','observer_v8_heap_exhausted','serving_identity_unverified','observer_cleanup_unverified',
    'journal_mount_unverified','observer_exit_unverified','observation_contract_unverified'))

def partition_failure_code(error,run=None):
    if isinstance(error,subprocess.TimeoutExpired):return 'partition_timeout'
    if isinstance(error,OSError):return 'partition_process_unavailable'
    if run is not None and run.returncode!=0:
        try:
            raw=run.stdout
            if len(raw)>4096:return 'partition_cli_unclassified'
            value=json.loads(raw)
            code=value.get('failureCode') if isinstance(value,dict) and value.get('qualifiedExecution') is False else None
            if code in FLEET_FAILURE_CODES:return code
        except (ValueError,TypeError):pass
        return 'partition_cli_unclassified'
    if isinstance(error,ValueError) and str(error)=='partition_deadline':return 'partition_deadline'
    return 'partition_result_unverified'

def observe_bounded(packet_path,attestation_path,ssh_command,output_path):
    packet=private_json(packet_path);attestation=private_json(attestation_path)
    parts=partition_packets(packet,attestation)
    output=Path(output_path);transport=Path(ssh_command)
    if (not output.is_absolute() or output.exists() or output.parent!=Path(packet_path).parent
        or not transport.is_absolute() or not transport.is_file() or transport.is_symlink()):raise ValueError('private_output')
    # Reserve final destination before any read, preserving interrupted attempts.
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    results=[];run=None;deadline=time.monotonic()+FLEET_OPERATION_SECONDS
    try:
        manifest=output.parent/'partition-manifest.json'
        manifest_fd=os.open(manifest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(manifest_fd,'w') as f:
            json.dump({'version':1,'packetDigest':digest(packet),'snapshot':attestation['snapshot'],
                'partitions':[{'index':i,'packetDigest':digest(p),'handKeys':p['handKeys']} for i,p in enumerate(parts)]},f,separators=(',',':'))
        for index,part in enumerate(parts):
            run=None
            if deadline-time.monotonic()<115:raise ValueError('partition_deadline')
            part_path=output.parent/f'partition-{index:02d}.json'
            result_path=output.parent/f'partition-{index:02d}-result.json'
            part_fd=os.open(part_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(part_fd,'w') as f:json.dump(part,f,separators=(',',':'))
            run=subprocess.run(['node','server/scripts/phase6d-population.mjs','fleet','--packet',str(part_path),
                '--ssh-command',str(transport),'--out',str(result_path)],capture_output=True,timeout=115)
            if run.returncode!=0:raise ValueError('partition_observer_unavailable')
            result=private_json(result_path)
            # Validate each prefix before the next remote read. Never combine
            # a changed serving process or an unbound result with prior evidence.
            bounded_summary(packet,attestation,[*results,result])
            results.append(result)
        summary=bounded_summary(packet,attestation,results)
    except Exception as error:
        summary=bounded_summary(packet,attestation,results)
        summary['completeCapture']=False;summary['completeCanonicalHorseCoverage']=False
        summary['gaps']['partition_observation_unavailable']=1
        summary['partitionFailure']={'code':partition_failure_code(error,run),'completedPartitions':len(results)}
    with os.fdopen(fd,'w') as f:json.dump(summary,f,separators=(',',':'));f.write('\n')
    return summary

def database_failure(stderr):
    # VERBOSITY=verbose supplies a machine SQLSTATE. Never return the message,
    # URI, detail, relation, query text or an unrecognized token.
    match=re.search(r'(?:ERROR|FATAL):\s+([0-9A-Z]{5}):',stderr or '')
    state=match.group(1) if match else ''
    if state=='57014':return 'database_statement_cancelled'
    if state=='55P03':return 'database_lock_unavailable'
    if state=='42501':return 'database_permission_denied'
    if state in {'42P01','42703','42883','3F000'}:return 'database_schema_unavailable'
    if state.startswith('28'):return 'database_authentication_failed'
    if state.startswith('08'):return 'database_connection_unavailable'
    return 'database_unavailable_or_bounds'

def main():
    try:
        if 3<=len(sys.argv)<=18 and sys.argv[1]=='--union-ledgers':
            values=[]
            for name in sys.argv[2:]:
                p=Path(name)
                if not p.is_absolute() or p.is_symlink() or not p.is_file() or p.stat().st_size>2097152:raise ValueError('indexed_ledger_file')
                value=json.loads(p.read_text());values.append(value.get('indexedEvidenceLedger',value))
            ledger=union_indexed_ledgers(values)
            print(json.dumps({'indexedEvidenceLedger':ledger,'observedHorses':sum(r['acceptedDecisions']>0 for r in ledger['rows']),
                'allPhasesVerified':False,'decisionCorrectness':'unknown','planEffectPersistence':'unknown'}));return 0
        if len(sys.argv)==6 and sys.argv[1]=='--observe-bounded':
            result=observe_bounded(*sys.argv[2:])
            # The destination contains bounded counts/digests and stable cohort
            # indices, never actor IDs. Raw identities remain ephemeral.
            print(json.dumps(result));return 0 if result['completeCanonicalHorseCoverage'] else 2
        if len(sys.argv) in (4,5) and sys.argv[1]=='--summarize':
            paths=[Path(p) for p in sys.argv[2:]]
            if any(not p.is_absolute() or p.stat().st_size>2097152 or p.stat().st_mode & 0o077 for p in paths):raise ValueError('private_result')
            result=summarize(*[json.loads(p.read_text()) for p in paths])
            print(json.dumps(result));return 0 if result['completeCanonicalHorseCoverage'] else 2
        sha,start,end=inputs(os.environ)
        output=Path(sys.argv[1]);attestation_path=Path(sys.argv[2])
        if not output.is_absolute() or not attestation_path.is_absolute() or output.exists() or attestation_path.exists():raise ValueError('private_output')
        env=database_environment(os.environ)
        result=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input=query(start,end),text=True,capture_output=True,timeout=15,env=env)
        if result.returncode:raise ValueError(database_failure(result.stderr))
        if len(result.stdout.encode())>4194304:raise ValueError('database_reply_bound_reached')
        packet,attestation=packet_from_rows(json.loads(result.stdout),sha,start,end)
        for path,value in [(output,packet),(attestation_path,attestation)]:
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'w') as f:json.dump(value,f,separators=(',',':'));f.write('\n')
        print(json.dumps({'canonicalRosterVerified':True,'rosterCount':1000,'selectedHands':len(packet['handKeys']),'packetDigest':attestation['packetDigest'],'sourceSha':sha,'completePopulation':False,'allPhasesVerified':False}))
    except Exception as error:
        reasons={'source','utc','window','private_output','database_configuration','database_option','snapshot_or_index','canonical_cohort_not_1000','accepted_source_reply_invalid','accepted_source_selection_empty','accepted_source_hand_bound_reached','original_acceptance_unavailable','original_acceptance_pending','lightning_original_lease_unavailable','duplicate_coordinate','counts','private_result','database_unavailable_or_bounds','database_statement_cancelled','database_lock_unavailable','database_permission_denied','database_schema_unavailable','database_authentication_failed','database_connection_unavailable','database_reply_bound_reached'}
        reason=str(error) if isinstance(error,ValueError) and str(error) in reasons else 'canonical_packet_input_or_database_unavailable'
        print(json.dumps({'canonicalRosterVerified':False,'status':'unavailable','gap':reason,'counts':error.counts if isinstance(error,PacketGap) else {},'completePopulation':False,'allPhasesVerified':False}))
        return 3
    return 0
if __name__=='__main__':sys.exit(main())
