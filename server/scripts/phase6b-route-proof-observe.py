"""Phase 6B bounded observed route proof: one finite read-only observation on the exact serving image.

Runs phase6b-route-proof.mjs (beside this file) inside a throwaway observer container
built from the currently serving engine image, with the private Horse decision journal
bind-mounted read-only, no network, a memory and CPU cap and a hard deadline. Only the
aggregate JSON the script prints leaves the host. Never publishes, never writes to the
journal, never changes the serving container.

    python3 server/scripts/phase6b-route-proof-observe.py <serving-sha40> <since-ISO> <until-ISO> <out-dir> [<records-release-sha40>]

The observer image is always the serving release (first argument). The optional fifth
argument selects retained records written by another release, for a historical-only
window; when omitted, records are selected on the serving release. Both are recorded.

The engine's read-only /health report of the serving release and of the Horse journal
(mode, paused reason, record count) is captured before and after the observation, so a
window with no records states whether the journal was recording at all.

The observer runs detached on the host and this wrapper polls for its completion, so a
dropped SSH session cannot abort or orphan it. Writes
<out-dir>/phase6b-route-proof-<stamp>.json (the envelope with the observation) and prints
the envelope without the observation body. Exit 0 when the observation completed, 2 otherwise.
"""
import base64, datetime, hashlib, json, re, shlex, subprocess, sys, time
from pathlib import Path

ISO = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"
if (
    len(sys.argv) not in (5, 6)
    or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[1])
    or not re.fullmatch(ISO, sys.argv[2])
    or not re.fullmatch(ISO, sys.argv[3])
    or (len(sys.argv) == 6 and not re.fullmatch(r"[0-9a-f]{40}", sys.argv[5]))
):
    raise SystemExit("expected <serving-sha40> <since-ISO-Z> <until-ISO-Z> <out-dir> [<records-release-sha40>]")
release, since, until, out_dir = sys.argv[1], sys.argv[2], sys.argv[3], Path(sys.argv[4])
records_release = sys.argv[5] if len(sys.argv) == 6 else release
script = Path(__file__).resolve().parent / "phase6b-route-proof.mjs"
source = script.read_bytes()
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
name = "phase6b-route-proof-" + stamp.lower()
SSH = ["ssh", "-i", "/Users/smarter.poker/.ssh/hetzner_engine_key", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "root@5.161.252.33"]
DEADLINE_SECONDS = 3000

start_remote = r'''import base64,json,os,re,subprocess,sys,tempfile
p=json.load(sys.stdin)
sha=p["release"]; name=p["name"]; since=p["since"]; until=p["until"]; records=p["recordsRelease"]; deadline=int(p["deadline"])
assert re.fullmatch(r"[0-9a-f]{40}",sha) and re.fullmatch(r"[0-9a-f]{40}",records) and re.fullmatch(r"phase6b-route-proof-[0-9tz]+",name)
assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",since) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",until)
source=base64.b64decode(p["source"],validate=True)
assert len(source)<=65536
mount="/var/lib/club-arena/horse-decisions"
def run(args,**kw):
 return subprocess.run(args,capture_output=True,**kw)
def serving():
 r=run(["docker","inspect","--format","{{.Id}} {{.Image}} {{.State.Running}} {{index .Config.Labels \"sp.release.sha\"}} {{.State.StartedAt}}","club-arena-engine"],timeout=10)
 assert r.returncode==0
 parts=r.stdout.decode().strip().split()
 assert len(parts)==5 and re.fullmatch(r"[0-9a-f]{64}",parts[0]) and re.fullmatch(r"sha256:[0-9a-f]{64}",parts[1]) and parts[2:4]==["true",sha]
 return parts
identity=serving(); image=identity[1]
r=run(["docker","image","inspect","--format","{{index .Config.Labels \"org.opencontainers.image.revision\"}}",image],timeout=10); assert r.returncode==0 and r.stdout.decode().strip()==sha
r=run(["docker","inspect","--format","{{json .Mounts}}",identity[0]],timeout=10); assert r.returncode==0
mounts=[m for m in json.loads(r.stdout) if m.get("Destination")==mount]
assert len(mounts)==1 and mounts[0].get("Type")=="bind" and mounts[0].get("Source")==mount
tmp=tempfile.mkdtemp(prefix="phase6b-observer.")
os.chmod(tmp,0o755)
path=os.path.join(tmp,"phase6b-route-proof.mjs")
with open(path,"wb") as f: f.write(source)
os.chmod(path,0o644)
with open(os.path.join(tmp,"identity.json"),"w") as f: json.dump({"servingContainer":identity[0],"imageId":image,"servingStartedAt":identity[4]},f)
r=run(["docker","create","--name",name,"--network","none","--no-healthcheck","--read-only","--memory","1024m","--memory-swap","1024m","--cpus","1.0","--pids-limit","64","--mount","type=bind,src="+mount+",dst="+mount+",readonly","--mount","type=bind,src="+tmp+",dst=/observer,readonly","--env","HORSE_DECISION_JOURNAL_DIR="+mount,"--entrypoint","node",image,"--no-warnings","--max-old-space-size=768","/observer/phase6b-route-proof.mjs","observe","--release",sha,"--records-release",records,"--since",since,"--until",until],timeout=30)
assert r.returncode==0, "create_failed"
runner="import json,subprocess,time,os\nt=json.loads(" + json.dumps(json.dumps(tmp)) + ");n=json.loads(" + json.dumps(json.dumps(name)) + ");d=" + str(deadline) + "\ns=time.monotonic()\nr=subprocess.run(['timeout',str(d),'docker','start','-a',n],capture_output=True)\nst={'exitCode':r.returncode,'wallSeconds':round(time.monotonic()-s,1),'stderrBytes':len(r.stderr)}\nopen(t+'/out.json','wb').write(r.stdout)\ni=subprocess.run(['docker','inspect','--format','{{json .State}}',n],capture_output=True)\ntry:\n j=json.loads(i.stdout);st['oomKilled']=j['OOMKilled'];st['containerExitCode']=j['ExitCode']\nexcept Exception:\n st['stateUnavailable']=True\nc=subprocess.run(['docker','rm','-f',n],capture_output=True);st['cleanupExitCode']=c.returncode\nopen(t+'/state.json','w').write(json.dumps(st))\nopen(t+'/done','w').write('done')\n"
subprocess.Popen(["setsid","nohup","python3","-c",runner],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,stdin=subprocess.DEVNULL,start_new_session=True)
print(json.dumps({"tmp":tmp,"containerName":name,"release":sha,"recordsRelease":records,"imageId":image,"servingContainer":identity[0],"servingStartedAt":identity[4],"horseJournalMountVerified":True,"readOnly":True,"network":"none","memoryBytes":1073741824,"cpus":1.0,"deadlineSeconds":deadline}))
'''

collect_remote = r'''import json,os,re,shutil,subprocess,sys
p=json.load(sys.stdin); tmp=p["tmp"]; name=p["name"]; sha=p["release"]
assert re.fullmatch(r"/tmp/phase6b-observer\.[A-Za-z0-9_]+",tmp) and re.fullmatch(r"phase6b-route-proof-[0-9tz]+",name)
out={"done":os.path.exists(tmp+"/done")}
if out["done"]:
 out["state"]=json.load(open(tmp+"/state.json"))
 raw=open(tmp+"/out.json","rb").read()
 out["stdoutBytes"]=len(raw)
 try: out["observation"]=json.loads(raw) if len(raw)<=8388608 else {"status":"unavailable","reason":"observation_too_large"}
 except Exception: out["observation"]={"status":"unavailable","reason":"observation_not_json"}
 r=subprocess.run(["docker","inspect","--format","{{.Id}} {{.Image}} {{.State.Running}} {{index .Config.Labels \"sp.release.sha\"}} {{.State.StartedAt}}","club-arena-engine"],capture_output=True,timeout=10)
 parts=r.stdout.decode().strip().split()
 ident=json.load(open(tmp+"/identity.json"))
 out["sameServingIdentityAfter"]=r.returncode==0 and len(parts)==5 and parts[0]==ident["servingContainer"] and parts[1]==ident["imageId"] and parts[2:4]==["true",sha] and parts[4]==ident["servingStartedAt"]
 c=subprocess.run(["docker","ps","-a","--format","{{.Names}}","--filter","name=^/"+name+"$"],capture_output=True,timeout=10)
 out["observerRemoved"]=c.returncode==0 and not c.stdout.strip()
 shutil.rmtree(tmp,ignore_errors=True)
 out["scratchRemoved"]=not os.path.exists(tmp)
print(json.dumps(out))
'''

health_remote = r'''import json,subprocess
r=subprocess.run(["curl","-s","--max-time","10","http://127.0.0.1:8080/health"],capture_output=True,timeout=15)
out={"ok":False}
try:
 h=json.loads(r.stdout)
 j=h.get("horseJournal") or {}
 out={"ok":True,"releaseSha":h.get("releaseSha"),"horseJournal":{k:j.get(k) for k in ("mode","pausedReason","pausedSince","failedSince","lastFailureReason","records","maxRowid","pendingSegments","queued")}}
except Exception:
 pass
print(json.dumps(out))
'''

def ssh_json(remote, payload, timeout):
    run = subprocess.run(SSH + ["python3 -c " + shlex.quote(remote)], input=json.dumps(payload).encode(), capture_output=True, timeout=timeout)
    if run.returncode != 0 or len(run.stdout) > 8388608:
        raise RuntimeError("ssh_" + str(run.returncode))
    return json.loads(run.stdout)

started = datetime.datetime.now(datetime.timezone.utc).isoformat()
result = {"containerName": name, "startedAt": started, "release": release, "recordsRelease": records_release, "scriptSha256": hashlib.sha256(source).hexdigest(), "commandLine": " ".join(["python3", "server/scripts/phase6b-route-proof-observe.py"] + sys.argv[1:])}
try:
    # The engine's own report of the serving release and of the journal that
    # the observation reads (a paused journal records nothing new), taken
    # before and after the observation. Read-only /health on the host.
    result["servingHealthBefore"] = ssh_json(health_remote, {}, 60)
    launch = ssh_json(start_remote, {"release": release, "recordsRelease": records_release, "since": since, "until": until, "name": name, "deadline": DEADLINE_SECONDS, "source": base64.b64encode(source).decode()}, 90)
    result["execution"] = {k: v for k, v in launch.items() if k != "tmp"}
    deadline = time.monotonic() + DEADLINE_SECONDS + 300
    collected = None
    while time.monotonic() < deadline:
        time.sleep(20)
        try:
            polled = ssh_json(collect_remote, {"tmp": launch["tmp"], "name": name, "release": release}, 60)
        except Exception:
            continue
        if polled.get("done"):
            collected = polled
            break
    if collected is None:
        result["executionStatus"] = "unavailable"
        result["reason"] = "observer_deadline"
    else:
        result["execution"].update(collected["state"])
        for key in ("stdoutBytes", "observation", "sameServingIdentityAfter", "observerRemoved", "scratchRemoved"):
            result["execution"][key] = collected.get(key)
    result["servingHealthAfter"] = ssh_json(health_remote, {}, 60)
except Exception as error:
    result["executionStatus"] = "unknown"
    result["errorClass"] = type(error).__name__
result["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
execution = result.get("execution", {})
observation = execution.get("observation") or {}
result["completedObservation"] = (
    "executionStatus" not in result
    and execution.get("exitCode") == 0 and execution.get("containerExitCode") == 0
    and execution.get("oomKilled") is False
    and execution.get("sameServingIdentityAfter") is True
    and execution.get("observerRemoved") is True
    and execution.get("scratchRemoved") is True
    and observation.get("version") == "phase6b-route-proof-v1"
    and observation.get("selector", {}).get("release") == release
    and observation.get("selector", {}).get("recordsRelease") == records_release
    and "status" not in observation
    and result.get("servingHealthBefore", {}).get("releaseSha") == release
    and result.get("servingHealthAfter", {}).get("releaseSha") == release
)
out_dir.mkdir(parents=True, exist_ok=True)
path = out_dir / ("phase6b-route-proof-" + stamp + ".json")
path.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k: v for k, v in result.items() if k != "execution"}))
print(str(path))
raise SystemExit(0 if result["completedObservation"] else 2)
