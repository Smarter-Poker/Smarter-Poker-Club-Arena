"""Load exact captured JSONB bytes; never reserialize signed numeric scalars."""
from pathlib import Path
import sys
folder, output = map(Path, sys.argv[1:])
raw = (folder / "captured-original-3.json").read_text()
frames = (folder / "captured-original-frames.json").read_text()
lines = ["CREATE TEMP TABLE original_capture(j jsonb);", "INSERT INTO original_capture VALUES($capture$" + raw + "$capture$::jsonb);"]
for table in ["chip_ledger", "cash_participant_funding_receipts", "cash_funding_application_receipts", "cash_seat_move_receipts", "cash_hand_participant_manifests", "cash_hand_provenance_receipts", "union_pnl_cash_outcomes"]:
    lines.append(f"INSERT INTO public.{table} SELECT r.* FROM original_capture c,LATERAL jsonb_populate_recordset(NULL::public.{table},c.j->'{table}')r;")
lines.append("INSERT INTO union_pnl_transaction_frames SELECT * FROM jsonb_populate_recordset(NULL::union_pnl_transaction_frames,$frames$" + frames + "$frames$::jsonb);")
output.write_text("\n".join(lines) + "\n")
