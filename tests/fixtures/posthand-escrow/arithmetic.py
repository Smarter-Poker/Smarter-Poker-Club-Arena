from pathlib import Path
import sys
base=Path(__file__).parent
source=Path(sys.argv[1]).read_text(); a=source.index(' movement AS (');b=source.index(' SELECT COALESCE(jsonb_agg',a);tail=source[a:b]
tail=tail.replace("CASE v_terms_value->>'eco_base_mode'","CASE 'winnings_only'").replace("COALESCE(v_close->'holdings','[]')","(SELECT holdings FROM closing_people)").replace("COALESCE(v_open->'holdings','[]')","(SELECT holdings FROM opening_people)")
expected=sys.argv[2]=='true'
projected=sys.argv[3]=='true'
prefix="""WITH original AS(SELECT * FROM cash_hand_provenance_receipts WHERE hand_number=31008564),
 opening_people(holdings) AS(SELECT jsonb_agg(jsonb_build_object('club_id','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','user_id',p->>'user_id','amount',p->'stack_before')) FROM original o CROSS JOIN LATERAL jsonb_array_elements(o.participants) p),
 closing_people(holdings) AS(SELECT jsonb_agg(jsonb_build_object('club_id','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','user_id',p->>'user_id','amount',CASE WHEN p->>'user_id'='0f5f1d65-7ce1-4250-93fe-49078f4f14d1' THEN (SELECT e.after_row->'stack' FROM union_pnl_inventory_events e WHERE e.event_id=57263807) ELSE p->'stack_after' END)) FROM original o CROSS JOIN LATERAL jsonb_array_elements(o.participants) p),
 flows(ledger_id,club_id,user_id,buyins,cashouts,kind,valid) AS(SELECT source_ledger_id,funding_club_id,user_id,amount,0::numeric,'cash_funding',true FROM cash_participant_funding_receipts WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc'),
 hand_players(club_id,user_id,delta) AS(SELECT (p->>'earning_club_id')::uuid,(p->>'user_id')::uuid,fn_pnl_evidence_cents(p->'observed_stack_delta') FROM fn_union_pnl_week_hand_lines('fade0000-0000-0000-0000-000000000001','2026-10-10 18:23:19.475321+00','2026-10-10 18:23:19.475322+00',false) h CROSS JOIN LATERAL jsonb_array_elements(h.hand_participants) p),
 opening(club_id,amount,cash) AS(SELECT (p->>'club_id')::uuid,sum((p->>'amount')::numeric),sum((p->>'amount')::numeric) FROM opening_people o CROSS JOIN LATERAL jsonb_array_elements(o.holdings) p GROUP BY 1),
 closing(club_id,amount,cash) AS(SELECT (p->>'club_id')::uuid,sum((p->>'amount')::numeric),sum((p->>'amount')::numeric) FROM closing_people o CROSS JOIN LATERAL jsonb_array_elements(o.holdings) p GROUP BY 1),
 rake(club_id,generated,earned,cash_rake,tournament_rake) AS(SELECT 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,rake,0::numeric,rake,0::numeric FROM original),
 roster(club_id) AS(SELECT 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid),
"""
prefix=prefix.replace(",false) h CROSS JOIN",","+str(projected).lower()+") h CROSS JOIN")
sql='CREATE TEMP TABLE fourth_arithmetic AS '+prefix+tail+' SELECT * FROM complete;\n'
sql+="DO $test$ DECLARE r record; f cash_participant_funding_receipts; BEGIN SELECT * INTO STRICT r FROM fourth_arithmetic;SELECT * INTO STRICT f FROM cash_participant_funding_receipts WHERE id='f6cd3e20-e3a4-46e0-b4a4-5327794102fc';"
sql+=f"IF r.cash_reconciled IS DISTINCT FROM {str(expected).lower()} OR r.cash_player_pnl IS DISTINCT FROM {'-3.75' if expected else '-60'}::numeric OR r.tournament_player_pnl IS DISTINCT FROM {'0' if expected else '56.25'}::numeric"
sql+=" OR r.net IS DISTINCT FROM 0::numeric OR r.winnings IS DISTINCT FROM 56.25::numeric OR r.losses IS DISTINCT FROM 60::numeric OR r.cash_buyins IS DISTINCT FROM 368.62::numeric OR r.cash_cashouts IS DISTINCT FROM 0::numeric OR r.seated_start IS DISTINCT FROM 1002.25::numeric OR r.seated_end IS DISTINCT FROM 1367.12::numeric OR f.balance_before+r.seated_start IS DISTINCT FROM f.balance_after+r.seated_end+r.rake_paid THEN RAISE EXCEPTION 'original escrow wallet/felt report arithmetic differs';END IF;"
sql+=f"RAISE NOTICE 'PASS report monetary CTE original escrow expected {str(expected).lower()}: buyin368.62, winnings56.25/losses60 once, net0, original wallet debit + felt/rake conserved';END $test$;DROP TABLE fourth_arithmetic;\n"
Path(sys.argv[4]).write_text(sql)
