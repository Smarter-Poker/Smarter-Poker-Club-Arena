from pathlib import Path
import sys
source, prefix, output = map(Path, sys.argv[1:4])
expected = sys.argv[4] == 'true'
s = source.read_text()
a = s.index(' movement AS (')
b = s.index(' SELECT COALESCE(jsonb_agg', a)
tail = s[a:b].replace("CASE v_terms_value->>'eco_base_mode'", "CASE 'winnings_only'")
tail = tail.replace("COALESCE(v_close->'holdings','[]')", "'[ {\"club_id\":\"00000000-0000-0000-0000-000000000001\",\"user_id\":\"00000000-0000-0000-0000-000000000012\",\"amount\":95} ]'::jsonb").replace("COALESCE(v_open->'holdings','[]')", "'[]'::jsonb")
sql = 'CREATE TEMP TABLE arithmetic_result AS ' + prefix.read_text() + tail + ' SELECT * FROM complete;\n'
sql += "DO $test$DECLARE r record; wallet_a numeric:=1000-100+100+5;wallet_b numeric:=1000-100;felt_b numeric:=100-5;BEGIN SELECT * INTO STRICT r FROM arithmetic_result;"
sql += "IF r.cash_reconciled IS DISTINCT FROM " + str(expected).lower() + " OR r.net IS DISTINCT FROM 0::numeric OR r.winnings IS DISTINCT FROM 5::numeric OR r.losses IS DISTINCT FROM 5::numeric OR r.tournament_player_pnl IS DISTINCT FROM 0::numeric OR r.cash_buyins IS DISTINCT FROM 200::numeric OR r.cash_cashouts IS DISTINCT FROM 100::numeric OR wallet_a+wallet_b+felt_b<>2000 OR wallet_a-1000<>r.winnings OR 1000-wallet_b-felt_b<>r.losses THEN RAISE EXCEPTION 'quantitative report/wallet/felt conservation disagrees';END IF;RAISE NOTICE 'PASS original report cash reconciliation expected " + str(expected).lower() + "; wallet 1005/900 + felt 95 conserved 2000; winnings/losses 5 once';END $test$;\nDROP TABLE arithmetic_result;\n"
output.write_text(sql)
