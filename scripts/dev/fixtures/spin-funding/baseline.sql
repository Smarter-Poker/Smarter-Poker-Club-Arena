
CREATE TRIGGER zz_spin_shortfall_funds_escrow AFTER INSERT ON public.spin_reserve_ledger FOR EACH ROW WHEN (NEW.kind='adjustment') EXECUTE FUNCTION public.fn_spin_shortfall_funds_the_escrow();
INSERT INTO public.clubs(id) VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.spin_bonus_pools(club_id,balance) SELECT id,8 FROM public.clubs;
INSERT INTO public.tournaments(id,club_id,buy_in_amount) VALUES
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1);
INSERT INTO public.tournament_escrow(tournament_id,gross_in,fee_entries_in,reserve_out) SELECT id,3,.24,2.76 FROM public.tournaments;
INSERT INTO public.spin_reserve_ledger(club_id,tournament_id,kind,amount,balance_after) SELECT club_id,id,'contribution',2.76,8 FROM public.tournaments;
SELECT 'already_booked_entry_counted_again' AS case_name,public.fn_spin_draw_multiplier('10000000-0000-4000-8000-000000000001',1,'[{"multiplier":10,"freq":1,"reserveThresholdX":0}]',.08,3) AS receipt;
UPDATE public.spin_bonus_pools SET balance=10 WHERE club_id='10000000-0000-4000-8000-000000000001';
SELECT 'draw_a_before_either_settlement' AS case_name,public.fn_spin_draw_multiplier('10000000-0000-4000-8000-000000000001',1,'[{"multiplier":10,"freq":1,"reserveThresholdX":0}]',.08,0) AS receipt;
SELECT 'draw_b_before_either_settlement' AS case_name,public.fn_spin_draw_multiplier('10000000-0000-4000-8000-000000000001',1,'[{"multiplier":10,"freq":1,"reserveThresholdX":0}]',.08,0) AS receipt;
SELECT 'settlement_a' AS case_name,public.fn_spin_settle_game('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,3,10,.08) AS receipt;
SELECT 'settlement_b' AS case_name,public.fn_spin_settle_game('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1,3,10,.08) AS receipt;
SELECT 'shortfall_overlay_without_bank_debit' AS case_name,e.overlay_in,c.chip_treasury AS bank_balance FROM public.tournament_escrow e CROSS JOIN public.clubs c WHERE e.tournament_id='20000000-0000-4000-8000-000000000002';
DO $$ BEGIN
IF (SELECT balance FROM public.spin_bonus_pools LIMIT 1) <> 0 OR (SELECT overlay_in FROM public.tournament_escrow WHERE tournament_id='20000000-0000-4000-8000-000000000002')<>10 OR (SELECT chip_treasury FROM public.clubs LIMIT 1)<>1000 THEN
RAISE EXCEPTION 'Expected baseline failure sequence did not reproduce';
END IF;
RAISE NOTICE 'BASELINE REPRODUCED: two 10-chip selections used one 10-chip pool; second settlement credited 10 overlay with no bank debit.';
END $$;
