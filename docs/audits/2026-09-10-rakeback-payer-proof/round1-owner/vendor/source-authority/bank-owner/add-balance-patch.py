#!/usr/bin/env python3
from pathlib import Path
p=Path(__file__).resolve().parent/'build-owner.py'
s=p.read_text()
anchor='preflight="""'
patch='''replace("      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)", """      SELECT coalesce(rake_wallet,0) INTO v_bank_before FROM public.union_wallets
       WHERE union_id=v_union_id FOR UPDATE;
      IF NOT FOUND THEN v_bank_before:=0; END IF;
      INSERT INTO public.union_wallets (union_id, chip_balance, rake_wallet, total_rake_collected)""")
replace("      RETURNING rake_wallet INTO v_union_rake;", """      RETURNING rake_wallet INTO v_union_rake;
      IF NOT FOUND OR v_union_rake IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank Union destination credit did not apply exactly once';
      END IF;""")
replace("      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);", """      SELECT coalesce(chip_treasury,0) INTO STRICT v_bank_before FROM public.clubs
       WHERE id=p_club_id FOR UPDATE;
      PERFORM set_config('app.ledger_autoskip_clubs', '1', true);""")
replace("""       WHERE id = p_club_id;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);""","""       WHERE id = p_club_id RETURNING chip_treasury INTO v_bank_after;
      IF NOT FOUND OR v_bank_after IS DISTINCT FROM v_bank_before+p_rake THEN
       RAISE EXCEPTION 'Cash bank club destination credit did not apply exactly once';
      END IF;
      PERFORM set_config('app.ledger_autoskip_clubs', '0', true);""")
'''
assert s.count(anchor)==1
assert 'Union destination credit did not apply exactly once' not in s
p.write_text(s.replace(anchor,patch+anchor))
