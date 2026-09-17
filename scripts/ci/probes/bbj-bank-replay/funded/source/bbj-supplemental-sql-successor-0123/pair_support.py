"""Exact extracted inert combined-command helpers; source origin pinned."""
import json
from decimal import Decimal

def outputs(r):
    return r.one("SELECT jsonb_build_object("
      "'snapshots',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.ca_account_snapshots t),'[]'::jsonb),"
      "'meter',COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.ca_currency_meter t),'[]'::jsonb),"
      "'snapshot_sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM public.ca_account_snapshots_id_seq),"
      "'meter_sequence',(SELECT jsonb_build_object('last_value',last_value,'is_called',is_called) FROM public.ca_currency_meter_id_seq))")

def parse_command(out,b,locked=False):
    b.require(out['exit']==0,'Combined real command failed: '+out['stderr'])
    rows=[x for x in out['stdout'].splitlines() if x.strip()]
    b.require(len(rows)==2,'Combined job must return exactly replay and meter results')
    replay=rows[0] if locked else json.loads(rows[0],parse_float=Decimal)
    meter=json.loads(rows[1],parse_float=Decimal)
    b.require(replay=='locked' if locked else isinstance(replay,dict),'Unexpected replay lock result')
    b.require(isinstance(meter,dict),'Actual meter result absent')
    return replay,meter
