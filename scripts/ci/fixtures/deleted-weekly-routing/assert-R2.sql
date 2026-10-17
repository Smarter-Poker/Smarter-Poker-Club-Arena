SELECT dr_assert((SELECT chip_treasury=910 FROM clubs WHERE id=dr_u('club')),'treasury910 after independent140 bank claims');
SELECT dr_assert((SELECT chip_balance=90 FROM club_members WHERE user_id=dr_u('agent3')),'sub keeps published90');
SELECT dr_assert((SELECT sum(chip_balance)=90 FROM club_members),'only reserved90 remains');
SELECT dr_assert((SELECT sum(amount)=510 AND count(*)=3 FROM chip_ledger WHERE category='commission'),'gross3legs510');
SELECT dr_assert((SELECT sum(amount)=140 AND count(*)=3 FROM chip_ledger WHERE category='club_bank_claim'),'netclaims140');
SELECT dr_assert((SELECT bool_and(membership_lifecycle_status='departed' AND NOT is_active AND status='inactive' AND departure_reason='native') FROM club_members WHERE role<>'player'),'departed unchanged');
SELECT dr_assert(coalesce(current_setting('app.deleted_wallet_routing_stage',true),'')='','deferral restored');
SELECT dr_assert(coalesce(current_setting('app.accounting_routing_context',true),'')='','routing restored');
