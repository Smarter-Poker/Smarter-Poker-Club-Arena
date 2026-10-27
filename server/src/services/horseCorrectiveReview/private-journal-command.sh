set -eu
horse_journal_container=$(docker inspect --format '{{.Id}}' club-arena-engine)
case "$horse_journal_container" in ''|*[!0-9a-f]*) exit 3;; esac
[ "${#horse_journal_container}" -eq 64 ]
horse_journal_image=$(docker inspect --format '{{.Image}}' "$horse_journal_container")
horse_journal_source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$horse_journal_image")
horse_journal_health=$(python3 -c 'import json,re,urllib.request
u="http://127.0.0.1:8080/health"
with urllib.request.urlopen(urllib.request.Request(u,headers={"Cache-Control":"no-cache, no-store"}),timeout=5) as r:
 if r.geturl()!=u: raise ValueError("identity unavailable")
 b=r.read(131073)
 if len(b)>131072: raise ValueError("identity unavailable")
 h=json.loads(b)
s=h.get("releaseSha");i=h.get("instanceId")
if not isinstance(s,str) or not re.fullmatch("[a-f0-9]{40}",s) or not isinstance(i,str) or not re.fullmatch("[A-Za-z0-9-]{1,100}",i): raise ValueError("identity unavailable")
print(s+" "+i)')
[ "${horse_journal_health%% *}" = "$horse_journal_source" ]
printf '%s %s %s\n' "$horse_journal_source" "$horse_journal_container" "${horse_journal_health#* }"
docker exec -i "$horse_journal_container" node dist/scripts/horsePrivateJournalExport.js
