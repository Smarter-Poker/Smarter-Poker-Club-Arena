#!/usr/bin/env python3
"""Emit the exact maintained SQL reader and its finite isolated regression."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
def function(path,name):
    text=(root/path).read_text()
    start=text.index('CREATE OR REPLACE FUNCTION public.'+name+'(')
    end=text.index('$function$;',text.index('AS $function$',start))+len('$function$;')
    return text[start:end]
print((root/'tests/fixtures/ledger-invariant/cashout-readers.sql').read_text())
print(function('supabase/migrations/20260901121430_a_reversal_is_not_a_mint.sql','fn_ca_noncirculating_chip_stores'))
print(function('supabase/migrations/20260912044609_the_supply_meter_counts_the_pending_addon_float.sql','fn_ca_trial_balance'))
print("""DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM fn_ca_trial_balance() WHERE account='ticket_escrow' AND difference=-23.75)
 THEN RAISE EXCEPTION 'old cashout attribution defect was not reproduced'; END IF;
END $$;""")
print(function('supabase/migrations/20261006141326_the_supply_meter_includes_held_cashouts.sql','fn_ca_trial_balance'))
print((root/'tests/fixtures/ledger-invariant/cashout-reader-regression.sql').read_text())
