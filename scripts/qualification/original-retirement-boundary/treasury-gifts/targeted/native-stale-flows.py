# Preserve ACTUAL old-reader output:84 old-method P&L windows,91 invalid rows.
# Source generations are read from the actual generation owner, never retagged.
for body in originals:q(body)
for owner in json.loads((P/'current-close-window-owners.json').read_text()):q(owner['body'])
report=next(f['body']for f in json.loads((P/'current-generation-cache-owners.json').read_text())if f['signature'].startswith('fn_union_pnl_evidence_report'))
q(report)
old_flow_generation=q('SELECT smarter_private.original_inventory_basis_generation()')
assert old_flow_generation.startswith('original-inventory-245-v1:')
q("INSERT INTO accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,computed_at,value)SELECT 'pnl_flows_window','fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z',w.window_start,w.window_end,clock_timestamp(),jsonb_build_object('generation',"+lit(old_flow_generation)+",'bad',x.bad,'flows',x.flows)FROM fn_accounting_close_windows('2026-10-19 07:00Z','2026-10-26 07:00Z')w CROSS JOIN LATERAL(SELECT count(*)FILTER(WHERE NOT f.valid)bad,coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb)flows FROM smarter_private.union_pnl_original_flow_evidence_window('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z',w.window_start,w.window_end)f)x")
oldbad=json.loads(q("SELECT jsonb_build_object('windows',count(*),'bad',sum((value->>'bad')::int),'generation',min(value->>'generation'))FROM accounting_close_partials WHERE kind='pnl_flows_window'"));assert oldbad['windows']==84 and oldbad['bad']==91,oldbad
(O/'stale-original-84-flow-windows-before.json').write_text(json.dumps(oldbad,indent=2)+'\n')
# Nonfinancial original-stage identities are sentinels here; no paid receipt is
# fabricated. Root must compare ACTUAL paid receipts/pages after human payments.
q("INSERT INTO accounting_close_partials(kind,union_id,period_start,period_end,window_start,window_end,computed_at,value)SELECT k.kind,'fade0000-0000-0000-0000-000000000001','2026-10-19 07:00Z','2026-10-26 07:00Z',w.window_start,w.window_end,clock_timestamp(),jsonb_build_object('external_original_stage_fingerprint',md5(k.kind||w.window_start::text))FROM fn_accounting_close_windows('2026-10-19 07:00Z','2026-10-26 07:00Z')w CROSS JOIN(VALUES('earned_plan_window'),('round2_union_window'))k(kind)")
other_parts_digest=q("SELECT md5(jsonb_agg(to_jsonb(p)ORDER BY kind,window_start)::text)FROM accounting_close_partials p WHERE kind IN('earned_plan_window','round2_union_window')")
