#!/usr/bin/env python3
"""Prepare ONE typed exact20 RPC transaction for the existing trusted operator.

OFFLINE ONLY. It reads no credentials and executes no database/network operation.
The output is a plan, not a seal/custody certificate or permission to execute it.
See docs/runbooks/original-tournament-recovery20.md for required actual evidence.
"""
import argparse,json,re,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OP='d44c4440-2911-430c-8ee7-376611ef3f38'
def main():
 p=argparse.ArgumentParser(description=__doc__)
 for key in ['tournament-id','nonce','instance-id','lease-generation','release-sha','freeze-started','ownership-token','custody-md5']:p.add_argument('--'+key,required=True)
 a=p.parse_args()
 allowed=json.loads((ROOT/'scripts/ci/fixtures/tournament-recovery20/cohort-membership.json').read_text())['natural_finish_twenty']
 for name in ['tournament_id','nonce','lease_generation','ownership_token']:
  try:setattr(a,name,str(uuid.UUID(getattr(a,name))))
  except ValueError:p.error(name+' must be a UUID')
 if a.tournament_id not in allowed:p.error('only the explicitly directed original20 are eligible')
 if not re.fullmatch(r'[1-9][0-9]*-[a-f0-9]{8}',a.instance_id):p.error('actual instance identity required')
 if not re.fullmatch(r'[a-f0-9]{40}',a.release_sha) or a.release_sha=='eed06fe51dea622069c661a6213d5b031ff3a9e3':p.error('containing full release SHA required; old predecessor cannot qualify')
 if not re.fullmatch(r'[a-f0-9]{32}',a.custody_md5):p.error('canonical database custody digest required')
 from datetime import datetime
 try:
  moment=datetime.fromisoformat(a.freeze_started.replace('Z','+00:00'))
  if moment.tzinfo is None:raise ValueError()
  a.freeze_started=moment.isoformat()
 except ValueError:p.error('own actual v3 freeze start must include timezone')
 # Every interpolation is validated; free-form reasons/evidence are not inputs.
 print('-- PLAN ONLY: execute only AFTER the recorded actual host/root prerequisites. No credential is read by this tool.')
 print("BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s';")
 vals=[OP,a.tournament_id,a.nonce,a.instance_id,a.lease_generation,a.release_sha,a.freeze_started,a.ownership_token,a.custody_md5]
 print('SELECT public.fn_ca_withdraw_tournament_abort_for_original_recovery('+','.join("'"+v+"'" for v in vals)+');')
 print('COMMIT;')
if __name__=='__main__':main()
