#!/usr/bin/env python3
"""One explicit private canonical-cohort snapshot. SELECT only; no source rows,
credentials, actor IDs or database errors are printed. This is not capture or
15-phase qualification. The installed journal observer owns that separate read.
"""
import hashlib,json,os,re,subprocess,sys
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
 SELECT horse_id::text FROM public.ca_horse_active_roster ORDER BY horse_id LIMIT 1001
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
    attestation={'version':1,'authority':'canonical_database_snapshot','rosterTable':'public.ca_horse_active_roster','snapshot':rows['snapshot'],'readAt':rows['readAt'],'sourceSha':sha,'packetDigest':digest,'rosterCount':1000,'selectedHands':len(keys),'sourceOwnerCounts':{owner:sum(h['source_owner']==owner for h in hands) for owner in ('classic','lightning')},'completePopulation':False,'allPhasesVerified':False}
    return packet,attestation

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
        phases[key]=axes
    return {'status':'reported','schema':'horse-fleet-phase-summary-v1','counterUnit':'selected_accepted_decisions','acceptedDecisions':n,'phases':phases,'allPhasesVerified':False}

# Maintained fleet/reconciler closed literals only; never emit arbitrary keys.
CAPTURE_GAP_REASONS = frozenset(['accepted_hand_conflict', 'accepted_hand_missing', 'action_origin_unavailable', 'actor_outside_roster', 'binding_unavailable', 'bound_reached', 'capture_outside_window', 'capture_unavailable', 'decision_missing', 'decision_outside_window', 'discard_binding_unavailable', 'discard_capture_conflict', 'discard_decision_missing', 'discard_execution_missing', 'discard_input_mismatch', 'execution_conflict', 'execution_missing', 'fallback_lineage_unavailable', 'hand_bound_reached', 'input_mismatch', 'invalid_records', 'multiple_decisions_for_action', 'plan_receipt_conflict', 'plan_receipt_missing', 'plan_receipt_unbound', 'read_frame_unavailable', 'record_conflict', 'request_lifecycle_missing', 'source_mismatch', 'storage_close_unavailable', 'turn_conflict', 'unmatched_discard_action', 'unmatched_horse_action'])
def capture_diagnostics(attestation, observation):
    def count(value, maximum):
        if type(value) is not int or not 0<=value<=maximum:raise ValueError('capture_counts')
        return value
    selected=count(attestation.get('selectedHands'),10000)
    owners=attestation.get('sourceOwnerCounts')
    if not isinstance(owners,dict) or set(owners)!={'classic','lightning'} or sum(count(v,10000) for v in owners.values())!=selected:raise ValueError('capture_source_counts')
    out={'selectedHands':selected,'sourceOwnerCounts':dict(owners),'inspectedHandsIsContinuationCursor':False,'inspectionMayIncludeIncompleteHand':True}
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

def summarize(attestation,result):
    observation=(result.get('execution') or {}).get('observation') or {}
    count=observation.get('observedHorses')
    if not isinstance(count,int) or isinstance(count,bool) or not 0<=count<=1000:raise ValueError('counts')
    canonical=(attestation.get('authority')=='canonical_database_snapshot' and attestation.get('rosterCount')==1000 and bool(attestation.get('snapshot')) and re.fullmatch('[0-9a-f]{64}',attestation.get('packetDigest','')) is not None and attestation.get('packetDigest')==result.get('packetDigest') and attestation.get('sourceSha')==result.get('sourceSha') and result.get('qualifiedExecution') is True)
    complete=canonical and observation.get('completeHorseCoverage') is True and count==1000
    return {'canonicalRosterVerified':bool(canonical),'packetDigest':attestation.get('packetDigest') if canonical else None,'observedHorses':count,'unobservedHorses':1000-count,'completeCanonicalHorseCoverage':bool(complete),'completePopulation':False,'allPhasesVerified':False,'captureDiagnostics':capture_diagnostics(attestation,observation) if canonical else {'status':'unknown','reason':'canonical_binding_unverified'},'phaseEvidence':phase_summary(observation) if canonical else {'status':'unknown','reason':'canonical_binding_unverified'}}

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
        if len(sys.argv)==4 and sys.argv[1]=='--summarize':
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
