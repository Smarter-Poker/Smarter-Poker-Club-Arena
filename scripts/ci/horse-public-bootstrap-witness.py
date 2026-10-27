#!/usr/bin/env python3
"""One bounded readonly current-container boot witness; no raw logs leave SSH.
Services-ready is logged before cache admission/READY; never relabel it as those.
"""
import argparse,datetime,json,os,re,selectors,subprocess,sys,time
MAX_BYTES=2*1024*1024

def bounded(args,limit=MAX_BYTES,seconds=4,input=None):
    proc=subprocess.Popen(args,stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    if input is not None:proc.stdin.write(input);proc.stdin.close()
    data=bytearray();selector=selectors.DefaultSelector();selector.register(proc.stdout,selectors.EVENT_READ);end=time.monotonic()+seconds
    try:
        while selector.get_map():
            remaining=end-time.monotonic()
            if remaining<=0:raise ValueError('read_deadline')
            for key,_ in selector.select(min(remaining,.2)):
                chunk=os.read(key.fd,65536)
                if not chunk:selector.unregister(key.fileobj);continue
                data.extend(chunk)
                if len(data)>limit:raise ValueError('read_byte_bound')
        if proc.wait(timeout=max(.01,end-time.monotonic())):raise ValueError('read_unavailable')
        return bytes(data)
    finally:
        selector.close()
        if proc.poll() is None:proc.kill()
        proc.wait()
        proc.stdout.close()

def timestamp(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)',value):raise ValueError('timestamp')
    return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()

def parse_logs(raw,started):
    if len(raw)>MAX_BYTES:raise ValueError('log_bound')
    start=timestamp(started);rows={}
    lines=raw.decode('utf8',errors='strict').splitlines()
    if len(lines)>20000:raise ValueError('log_line_bound')
    for line in lines:
        match=re.fullmatch(r'(\S+) \[HorseDecisionWorker\] shard ([0-7]) (.+)',line)
        if not match:continue
        at=timestamp(match[1]);index=int(match[2]);body=match[3]
        if not start<=at<=start+120:raise ValueError('log_interval')
        row=rows.setdefault(index,{})
        patterns=[('loaded',r'pooled public bootstrap loaded (\d+) profiles at (\d+)'),('step',r'boot step pooled_public_profiles ok in (\d+)ms \((\d+)ms since worker services began\)'),('ready',r'services ready (\d+)ms after they began')]
        if 'pooled public bootstrap' in body and not body.startswith('pooled public bootstrap loaded '):raise ValueError('bootstrap_unavailable')
        if body.startswith('boot step pooled_public_profiles failed'):raise ValueError('bootstrap_failed')
        for key,pattern in patterns:
            hit=re.fullmatch(pattern,body)
            if not hit:continue
            if key in row:raise ValueError('duplicate_boot')
            row[key]=(at,[int(x) for x in hit.groups()])
    if set(rows)!=set(range(8)):raise ValueError('missing_shard')
    output=[]
    for index,row in sorted(rows.items()):
        if set(row)!={'loaded','step','ready'}:raise ValueError('missing_boot_marker')
        loaded,(count,available)=row['loaded'];step,(elapsed,since)=row['step'];ready,(ready_ms,)=row['ready']
        if not loaded<=step<=ready or not 0<=count<=32768 or not start*1000<=available<=loaded*1000+1000 or not 0<=elapsed<=120000 or not elapsed<=since<=ready_ms<=120000:raise ValueError('boot_bounds_or_order')
        output.append({'shard':index,'status':'loaded','profileCount':count,'availableAtMs':available,'bootstrapElapsedMs':elapsed,'servicesReadyElapsedMs':ready_ms,'bootstrapBeforeServicesReady':True})
    return output

def remote(source):
    def identity():
        fields=bounded(['docker','inspect','--format','{{.Id}} {{.Image}} {{.State.Running}} {{index .Config.Labels "sp.release.sha"}} {{.State.StartedAt}}','club-arena-engine'],4096).decode().strip().split()
        if len(fields)!=5 or not re.fullmatch('[0-9a-f]{64}',fields[0]) or not re.fullmatch('sha256:[0-9a-f]{64}',fields[1]) or fields[2:4]!=['true',source]:raise ValueError('container_identity')
        timestamp(fields[4]);return fields
    def health():
        h=json.loads(bounded(['curl','-fsS','--max-time','3','http://127.0.0.1:8080/health']))
        instance=h.get('instanceId');lane=h.get('liveHorseDecision') or {};workers=lane.get('workers')
        if h.get('releaseSha')!=source or h.get('running') is not True or h.get('liveness')!='ok' or not isinstance(instance,str) or not re.fullmatch('[1-9][0-9]*-[0-9a-f]{8}',instance):raise ValueError('health_identity')
        if lane.get('phase')!='ready' or lane.get('workerCount')!=8 or not isinstance(workers,list) or len(workers)!=8 or {w.get('index') for w in workers}!=set(range(8)) or any(w.get('phase')!='ready' for w in workers):raise ValueError('workers_unavailable')
        return instance
    before=identity();instance=health()
    image=bounded(['docker','image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',before[1]],4096).decode().strip()
    if image!=source:raise ValueError('image_identity')
    until=datetime.datetime.fromtimestamp(timestamp(before[4])+120,datetime.timezone.utc).isoformat()
    rows=parse_logs(bounded(['docker','logs','--timestamps','--since',before[4],'--until',until,before[0]]),before[4])
    if identity()!=before or health()!=instance:raise ValueError('identity_changed')
    return {'version':1,'status':'observed','sourceSha':source,'instanceId':instance,'containerId':before[0],'containerStartedAt':before[4],'startupIntervalSeconds':120,'workersReadyAtObservation':8,'shards':rows,'readyMessageOrder':'not_logged','cacheAdmission':'unknown','completePopulation':False,'allPhasesVerified':False}

def validate_receipt(result,source):
    if not isinstance(result,dict) or set(result)!={'version','status','sourceSha','instanceId','containerId','containerStartedAt','startupIntervalSeconds','workersReadyAtObservation','shards','readyMessageOrder','cacheAdmission','completePopulation','allPhasesVerified'}:raise ValueError('remote_receipt')
    if result['version']!=1 or result['status']!='observed' or result['sourceSha']!=source or result['readyMessageOrder']!='not_logged' or result['cacheAdmission']!='unknown' or result['completePopulation'] is not False or result['allPhasesVerified'] is not False or result['startupIntervalSeconds']!=120 or result['workersReadyAtObservation']!=8:raise ValueError('remote_receipt')
    if not re.fullmatch('[1-9][0-9]*-[0-9a-f]{8}',result['instanceId']) or not re.fullmatch('[0-9a-f]{64}',result['containerId']):raise ValueError('remote_receipt')
    start=timestamp(result['containerStartedAt']);rows=result['shards']
    if not isinstance(rows,list) or len(rows)!=8:raise ValueError('remote_receipt')
    for index,row in enumerate(rows):
        if not isinstance(row,dict) or set(row)!={'shard','status','profileCount','availableAtMs','bootstrapElapsedMs','servicesReadyElapsedMs','bootstrapBeforeServicesReady'}:raise ValueError('remote_receipt')
        if row['shard']!=index or type(row['shard']) is not int or row['status']!='loaded' or row['bootstrapBeforeServicesReady'] is not True:raise ValueError('remote_receipt')
        for key,low,high in [('profileCount',0,32768),('availableAtMs',int(start*1000),int((start+120)*1000)),('bootstrapElapsedMs',0,120000),('servicesReadyElapsedMs',0,120000)]:
            if type(row[key]) is not int or not low<=row[key]<=high:raise ValueError('remote_receipt')
        if row['bootstrapElapsedMs']>row['servicesReadyElapsedMs']:raise ValueError('remote_receipt')
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source-sha',required=True);parser.add_argument('--ssh-command');parser.add_argument('--remote',action='store_true');args=parser.parse_args()
    try:
        if not re.fullmatch('[0-9a-f]{40}',args.source_sha):raise ValueError('source')
        if args.remote:result=remote(args.source_sha)
        else:
            path=os.path.abspath(args.ssh_command or '')
            if not os.path.isfile(path):raise ValueError('transport')
            # Fixed remote command; program bytes contain no environment/credentials.
            source=Path(__file__).read_text();command=[path,'python3','-','--remote','--source-sha',args.source_sha]
            result=json.loads(bounded(command,32768,30,input=source.encode()))
            validate_receipt(result,args.source_sha)
        print(json.dumps(result,separators=(',',':')));return 0
    except Exception:
        print(json.dumps({'version':1,'status':'unknown','reason':'bounded_bootstrap_witness_unavailable','completePopulation':False,'allPhasesVerified':False}));return 3
from pathlib import Path
if __name__=='__main__':sys.exit(main())
