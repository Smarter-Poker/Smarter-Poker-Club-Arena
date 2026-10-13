SELECT fixture_assert(fn_ca_diamond_economic_on('cash_rake_enabled')
 AND fn_ca_diamond_economic('cash_rake_percent')=10
 AND fn_ca_diamond_economic('cash_rake_cap','bb:10000')=2000,
 'fixture now carries the published active production cash rake answers');
CREATE TEMP TABLE fixture_combined_before AS SELECT sum(balance) AS custody,
 (SELECT fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'main')) AS main,
 (SELECT fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'backup')) AS backup,
 (SELECT fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'promotional')) AS promotional
 FROM poker_diamond_custody;
SELECT fixture_assert((fixture_jackpot_commit(1100300,300,true,false,'none',2000)->>'success')::boolean,
 'active 2000 rake and 300 jackpot drop commit in one real accepted hand');
SELECT fixture_assert((SELECT count(*)=4 AND sum(amount)=2000 AND bool_and(amount=500)
 FROM ca_diamond_rake_accrual WHERE hand_number=1100300 AND kind='rake'),
 'rake accrues exactly500 per equal contributor including the horse');
SELECT fixture_assert((SELECT custody-(SELECT sum(balance) FROM poker_diamond_custody)=2300
 AND fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'main')-main=150
 AND fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'backup')-backup=75
 AND fn_poker_diamond_jackpot_bank(fn_poker_diamond_jackpot_pool_for_table(
 '30000000-0000-0000-0000-000000000002'),'promotional')-promotional=75
 FROM fixture_combined_before),'custody debit equals2000 accrual plus exact150/75/75 jackpot banks');
SELECT fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),
 'combined rake and drop conserve registered Diamond supply');
CREATE TRIGGER fixture_jackpot_late_failure BEFORE INSERT ON notifications
 FOR EACH ROW EXECUTE FUNCTION fixture_jackpot_late_failure();
SELECT fixture_jackpot_rejected(1100301,300,true,false,'fixture_late_jackpot_failure','main',2000);
DROP TRIGGER fixture_jackpot_late_failure ON notifications;
SELECT fixture_assert((fixture_jackpot_commit(1100301,300,true,false,'main',2000)#>>'{diamond_jackpot_receipt,paid}')='true',
 'real active rake and jackpot payout succeed after complete late-failure rollback');
SELECT fixture_assert((SELECT count(*)=4 AND sum(amount)=2000 AND bool_and(amount=500)
 FROM ca_diamond_rake_accrual WHERE hand_number=1100301),
 'payout hand retains one exact accrual per payer after retry');
SELECT fixture_assert((SELECT difference=0 FROM fn_ca_diamond_register_vs_supply()),
 'rake plus drop plus real wallet payout conserve whole supply');
