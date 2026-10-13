from pathlib import Path
import json
import sys

source, output = map(Path, sys.argv[1:3])
raw = source.read_text()
tables = json.loads(raw)
sql = "CREATE TEMP TABLE original_capture(v jsonb);\nINSERT INTO original_capture VALUES ($capture$" + raw + "$capture$::jsonb);\n"
for name, rows in tables.items():
    if rows is None:
        continue
    if not name.replace('_', '').isalnum():
        raise SystemExit('invalid captured relation')
    sql += f"INSERT INTO public.{name} SELECT r.* FROM original_capture c CROSS JOIN LATERAL jsonb_populate_recordset(NULL::public.{name},c.v->'{name}') r;\n"
if len(sys.argv) == 4:
    moves = Path(sys.argv[3]).read_text()
    sql += "INSERT INTO public.cash_seat_move_receipts SELECT r.* FROM jsonb_populate_recordset(NULL::public.cash_seat_move_receipts,$moves$" + moves + "$moves$::jsonb) r;\n"
output.write_text(sql)
