SELECT dr_assert((SELECT chip_treasury=910 FROM clubs WHERE id=dr_u('club')),'treasury910 final');
SELECT dr_assert((SELECT sum(chip_balance)=90 FROM club_members WHERE role='player'),'players90');
SELECT dr_assert((SELECT sum(chip_balance)=0 FROM club_members WHERE role<>'player'),'all agents0');
SELECT dr_assert((SELECT sum(payout_amount)=90 AND bool_and(status='paid') FROM rakeback_period_payouts),'actual paid90');
SELECT dr_assert((SELECT sum(amount)=90 FROM chip_ledger WHERE category='rakeback'),'actual certified ledger90');
SELECT dr_assert((SELECT bool_and(status='paid') FROM rakeback_periods),'all periods paid');
SELECT dr_assert((SELECT sum(chip_balance)+(SELECT chip_treasury FROM clubs WHERE id=dr_u('club'))=1000 FROM club_members),'independent total1000');
SELECT dr_assert(coalesce(current_setting('app.deleted_wallet_routing_stage',true),'')='','deferral restored');
