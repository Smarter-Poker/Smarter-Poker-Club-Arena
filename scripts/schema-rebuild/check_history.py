#!/usr/bin/env python3
"""Fingerprint immutable history; never execute historical financial SQL."""
import argparse,hashlib,json,sys
from pathlib import Path
import forward as pending_schema
def check(root,repo,inventory,forward):
 if forward:
  if repo!='arena':raise ValueError('No pending Hub schema is admitted')
  pending_schema.validate(root,forward)
 expected={x['path']:x['sha256'] for x in inventory['repositories'][repo]['files']};actual={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'supabase/migrations').rglob('*.sql')};admitted={x['path']:x['sha256'] for x in forward}
 missing=sorted(set(expected)-set(actual));changed=sorted(p for p in expected.keys()&actual.keys() if expected[p]!=actual[p]);new=sorted(set(actual)-set(expected));unadmitted=[p for p in new if admitted.get(p)!=actual[p]];stale=sorted(set(admitted)-set(new))
 return {'missing':missing,'changed':changed,'unadmittedNew':unadmitted,'staleForwardEntries':stale}
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--checkout',required=True);ap.add_argument('--repo',choices=['hub','arena'],required=True);ap.add_argument('--inventory',required=True);ap.add_argument('--forward',required=True);a=ap.parse_args();result=check(Path(a.checkout),a.repo,json.loads(Path(a.inventory).read_text()),json.loads(Path(a.forward).read_text()).get(a.repo,[]));print(json.dumps(result));return int(any(result.values()))
if __name__=='__main__':sys.exit(main())
