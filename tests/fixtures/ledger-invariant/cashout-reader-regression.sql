DO $$ BEGIN
 IF (SELECT count(*) FROM fn_ca_trial_balance() WHERE difference IS DISTINCT FROM 0) <> 0
 OR NOT EXISTS(SELECT 1 FROM fn_ca_trial_balance() WHERE account='cashout_escrow' AND balance_delta=23.75 AND ledger_net=23.75)
 OR NOT EXISTS(SELECT 1 FROM fn_ca_trial_balance() WHERE account='ticket_escrow' AND balance_delta=0 AND ledger_net=0)
 THEN RAISE EXCEPTION 'cashout hold did not balance separately from ticket float'; END IF;
 IF EXISTS(SELECT 1 FROM fn_ca_trial_balance('2099-01-01') WHERE balance_delta IS NOT NULL OR ledger_net IS NOT NULL OR difference IS NOT NULL)
 THEN RAISE EXCEPTION 'different accounting bases were compared'; END IF;
END $$;
INSERT INTO public.ca_supply_snapshots(id,taken_at,basis_version,member_wallets,cashout_escrow,ticket_escrow)
VALUES(4,'2099-01-04','cashout-escrow-v5',93,0,7);
INSERT INTO public.chip_ledger VALUES
 ('escrow','player_wallet',23.75,'escrow_release','{}','fixture','authenticated','2099-01-03 12:00Z'),
 ('player_wallet','escrow',7,'ticket_issued','{}','fixture','authenticated','2099-01-03 13:00Z');
DO $$ BEGIN
 IF (SELECT count(*) FROM fn_ca_trial_balance() WHERE difference IS DISTINCT FROM 0) <> 0
 OR NOT EXISTS(SELECT 1 FROM fn_ca_trial_balance() WHERE account='cashout_escrow' AND balance_delta=-23.75 AND ledger_net=-23.75)
 OR NOT EXISTS(SELECT 1 FROM fn_ca_trial_balance() WHERE account='ticket_escrow' AND balance_delta=7 AND ledger_net=7)
 THEN RAISE EXCEPTION 'cashout release or concurrent ticket issuance was misattributed'; END IF;
END $$;
