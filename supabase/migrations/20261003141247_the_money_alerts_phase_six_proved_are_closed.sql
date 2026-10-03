-- 20261003141247_the_money_alerts_phase_six_proved_are_closed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE MONEY ALERTS PHASE SIX PROVED ARE CLOSED (phase 6 of 9: money edges).
-- Full account:
-- docs/changelog/2026-10-03-the-money-alerts-phase-six-proved-are-closed.md.
--
-- Records only. No chips move, no function changes, no job is added.
--
-- 1. Twenty-nine open financial_alerts rows were read against production on
--    2026-10-03, one by one, and every one is settled (the payment exists,
--    named by payout, ledger or receipt id), conserved, or not owed by a
--    standing ruling. Each closes with its own evidence. Two more about
--    WASP's satellites close with their payment in
--    20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites.
-- 2. Adjustment 04069754 (spin 6d688095 runner-up, 2.00) still reads
--    'approved' although obligation fc19154d was settled through it on
--    2026-09-09 11:08:18 (2.00 owed, 2.00 paid: 0.60 + 1.40). It is marked
--    settled so no reader takes it for money still to move.
-- 3. Rejected adjustment 41b3c7a0 (MamaGia, f7412940) carries a decision
--    note written with the wrong adjustment id and a stray correction in it.
--    The note is restated: she was paid through adjustment d8e908a3 (place
--    1 of f7412940, owed 13,441.68, paid 13,441.68, 2026-09-09 06:03:41).
--
-- Every pre-image is asserted; the migration aborts if any row moved.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolution LIKE '%20261003141247_the_money_alerts_phase_six_proved_are_closed%') = 29

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE p6_alert_closures (id uuid PRIMARY KEY, note text NOT NULL) ON COMMIT DROP;
INSERT INTO p6_alert_closures (id, note) VALUES
    ('c9218f6d-7452-4bbc-a3e6-ba2c6501414a'::uuid, 'Settled. f7412940 place 1 (a2bd256e) was owed 13,441.68 and was paid 13,441.68: 13,261.68 on 2026-09-07 04:10 (payout aff505b8) and 180.00 on 2026-09-09 06:03 (payout bf5302e7, funded by a union bank correction leg). Obligation b00c5bb2 reads owed 13,441.68, paid 13,441.68; the event''s prize liability nets to 0.00.'),
    ('33991c6b-db67-4e7b-82d2-45eadfb85098'::uuid, 'Settled. c854b3d1 (NLH HU 1) place 1 (bd7961a3) was paid its 1.90 at 2026-09-09 04:28:21 (payout 618beb94), two seconds after the deadlock this alert reported; 2.00 in, 0.10 rake, 1.90 out, net 0.00.'),
    ('47506cba-a9eb-4152-be02-1c95ed66b951'::uuid, 'Settled. d6f7a7e2 was paid by ruling at 2026-09-09 17:18:58: 126.55 to 316bb405 (payout b5af3df3) and 52.56 to ef5a8ddd (payout 7c19374f). Payouts 765.10 equal the roster''s prizes and the ledger out-legs; escrow 0.00.'),
    ('0a9d77aa-1f5f-4e6a-bfd3-52b5ca0a6458'::uuid, 'Settled. Satellite 65e8497e delivered its seat to 7f2fcb20 at 2026-10-03 02:33:28: payout bbd41543 (200.00, satellite_seat), a 200.00 leg into target 851d664a''s prize liability, and 7f2fcb20 registered in 851d664a with the satellite as source. The receipt shows one seat; escrow closed at 0.00 (125.00 buy-ins + 92.00 overlay = 12.00 rake + 5.00 refund + 200.00 seat).'),
    ('bd0bb791-32d7-47df-a14c-491f067029e8'::uuid, 'Settled. Breakfast Turbo c1f15c30 paid all six places on 2026-09-08 14:35-14:53, 180.00 in total (winner 5a0cd7e0 58.55, payout dec498a9). A terminal settlement receipt exists (2026-09-12 05:15); escrow 0.00, net 0.00.'),
    ('092a8ee5-109d-45a5-b9f1-858bdda40e99'::uuid, 'Settled. Freeroll c5ab79ac winner 257b5b68 was paid 100.00 on 2026-09-02 05:11 (payout 3e5a76da, overlay_backpay), funded from the club treasury. The event disbursed 166.29 against its 100.00 guarantee: overpaid, not short, and nothing is taken back.'),
    ('84b46569-6366-4fc1-b14c-24d0a0b25b43'::uuid, 'Settled. be94502b paid its winner 99be4f5d 3.80 at 2026-09-02 20:52:01 (payout 5938da1e); rake 0.20. The lock timeout reported here was a retry that found the payment done.'),
    ('96f552c4-3430-42c9-ac7b-5ecf08bc9fd5'::uuid, 'Settled. b7a6965f''s rake settlement of 2.00 was written at 2026-08-31 23:51:56 (ledger bb732880); the winner''s 38.00 was paid at 23:14 (c0422c8f).'),
    ('ea4f6976-08d4-4c55-b4ae-e3c907a343f4'::uuid, 'Settled. 173b047e''s rake settlement of 2.40 was written at 2026-08-31 23:52:11 (5a8d5c06); the winner''s 20.00 was paid (07f97bab).'),
    ('7c9622bd-348c-42af-af03-7a197da28abc'::uuid, 'Settled. 614fc8d4''s rake of 1.20 was settled at 2026-09-01 01:18:07 (90bdad4c); the winner''s 15.00 was paid (4739d6b4).'),
    ('cc1fb3cc-c590-4451-ac57-0c119b220ffe'::uuid, 'Not short. f84852af (Sunday $200 Deep Stack, 2026-09-27) paid 12,589.66 and 7,230.34 to places 1-2 and 180.00 to its stone bubble (bubble_protection): 20,000.00, the whole guarantee, escrow closed at 0.00. Bubble protection is reserved from the prize pool and shown on the event page as from the prize pool. The check counted ladder sources only; it now counts the bubble refund and overlay backpay (migration 20261003141003).'),
    ('77bdb12a-c757-4aad-8b35-1baf02754ba7'::uuid, 'Nothing owed. The 30 finishers paid beyond the ladder (688.30) are overpayments to players, absorbed by the house and never taken back (CLAUDE.md 10.9 rule 3); e.g. 4f42d847 place 3 paid to both ad5bd851 and 70be5a51. Nobody was paid less than their place.'),
    ('3fedee22-d0d4-4f68-8bbd-f6e2fc73c1f5'::uuid, 'Obsolete. The paid_but_unrecorded gap query this alert ran (61 events, 5,515.91 on 2026-09-01) returns 0 events when re-run read-only on 2026-10-03.'),
    ('45e48bee-60c3-4ab2-9cbc-28d7b604cf4d'::uuid, 'Obsolete. The truncated sweep left 986 events unexamined on 2026-09-01. On 2026-10-03 there are 0 open obligations and 0 prize or bounty escrow residuals on any COMPLETED tournament.'),
    ('76922a03-0dc8-4dd6-942c-b916d86fe634'::uuid, 'Conserved. Satellite b066f432''s winner 3d15bbe7 received a 200.00 cash ticket (bbcb41fc, 2026-09-07) and on 2026-09-09 21:11 the 85.00 remainder went to the bubble ed3f0662 (8a66d328). Receipt: one cash ticket; 300.00 in = 285.00 out + 15.00 rake, net 0.00.'),
    ('d0d749bd-3be6-441a-9883-8fe5c4c27425'::uuid, 'Conserved. Satellite b066f432''s winner 3d15bbe7 received a 200.00 cash ticket (bbcb41fc, 2026-09-07) and on 2026-09-09 21:11 the 85.00 remainder went to the bubble ed3f0662 (8a66d328). Receipt: one cash ticket; 300.00 in = 285.00 out + 15.00 rake, net 0.00.'),
    ('7063a4cc-cef7-4ca6-b396-d79c88715dfa'::uuid, 'Conserved, nothing paid twice. Satellite db2110a2: 40.00 of buy-ins = 30.00 cash ticket to 223b7d9b + 8.00 remainder to 46887b99 + 2.00 rake. No seat or ticket row exists in the target and the receipt shows seat_count 0, so the ''excess 30'' counted a seat that was never funded.'),
    ('f8e50325-22ec-4865-98a0-5af46a128f85'::uuid, 'Conserved, nothing paid twice. Satellite db2110a2: 40.00 of buy-ins = 30.00 cash ticket to 223b7d9b + 8.00 remainder to 46887b99 + 2.00 rake. No seat or ticket row exists in the target and the receipt shows seat_count 0, so the ''excess 30'' counted a seat that was never funded.'),
    ('179ea940-e2a2-4242-a363-3b5b5b07628e'::uuid, 'Conserved, nothing paid twice. Satellite db2110a2: 40.00 of buy-ins = 30.00 cash ticket to 223b7d9b + 8.00 remainder to 46887b99 + 2.00 rake. No seat or ticket row exists in the target and the receipt shows seat_count 0, so the ''excess 30'' counted a seat that was never funded.'),
    ('7b4857a4-1c7a-4c1b-afc9-5424b9b124d9'::uuid, 'Obsolete. All 14 events named are COMPLETED with no player missing a position; payouts equal roster prizes equal prize_pool and escrow reads 0.00 on every one.'),
    ('a47b57a2-ce8f-4977-bf6f-ad6d8408f72e'::uuid, 'Obsolete. All 3 events named are COMPLETED with no player missing a position; payouts equal roster prizes equal prize_pool and escrow reads 0.00 on every one.'),
    ('71b94744-fe00-4d6f-aabb-c4841fb2ee62'::uuid, 'Not player money. Week 2026-08-31 to 09-07: the cascade re-run at 16:35 paid round 2 (441,230.51); round 1 refused as before_settlement_floor, which records Dan''s 2026-09-02 ruling that the weeks of 08-17, 08-24 and 08-31 are deliberately never settled.'),
    ('de19ec95-8fcd-4245-aa0f-caddd18c9c53'::uuid, 'Not player money. Week 2026-08-31 to 09-07: the cascade re-run at 16:35 paid round 2 (441,230.51); round 1 refused as before_settlement_floor, which records Dan''s 2026-09-02 ruling that the weeks of 08-17, 08-24 and 08-31 are deliberately never settled.'),
    ('2849b60d-3f71-4cf9-8b9e-f04f4c816565'::uuid, 'Not player money. Week 2026-08-31 to 09-07: the cascade re-run at 16:35 paid round 2 (441,230.51); round 1 refused as before_settlement_floor, which records Dan''s 2026-09-02 ruling that the weeks of 08-17, 08-24 and 08-31 are deliberately never settled.'),
    ('ebec3ad9-3639-409e-ae52-10adedc51ddd'::uuid, 'Nothing owed. The 20 sample spins are COMPLETED with exactly one winner each and payouts equal to prize_pool (811.10 in all). The finding was table chips, not money.'),
    ('164c1866-967d-4b40-a7f8-41ffa3ff04b9'::uuid, 'Nothing owed. The 3 sample spins are COMPLETED with exactly one winner each and payouts equal to prize_pool (87.00 in all). The finding was table chips, not money.'),
    ('f25660dc-a545-4101-9e02-8ff274a22c32'::uuid, 'Nothing owed. February Rake Race (prize_pool 5,000, ended 2026-03-03) has no leaderboard rows, no claims and an empty prize structure: nobody qualified, so there is no one to pay.'),
    ('7d3623ec-86c6-43eb-945f-3d3b23dc7ec6'::uuid, 'Informational and done. 10,700 promo chips were retired under Dan''s 2026-09-03 ruling that promo owes nobody anything.'),
    ('248ee0b7-84f1-49c7-8847-88405a0bf817'::uuid, 'Not settled by ruling. The deferred 4.03 is rakeback period a3950b78 (week 2026-08-17) in Midway Union''s union-as-a-club scope. Dan''s 2026-09-02 ruling (20260902172302): the weeks of 08-17, 08-24 and 08-31 are deliberately never settled because they would pay out on the old basis that credited the union-as-a-club; 2026-09-07 is the first clean week. The same player''s 08-17 rakeback in Club JAQK was paid (0.81).');

DO $mig$
DECLARE
  c_mig   CONSTANT text := '20261003141247_the_money_alerts_phase_six_proved_are_closed';
  c_actor CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_n int;
BEGIN
  IF (SELECT count(*) FROM p6_alert_closures) <> 29 THEN
    RAISE EXCEPTION 'closure: expected 29 alerts to close';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts f JOIN p6_alert_closures c ON c.id = f.id
       WHERE f.resolved IS NOT TRUE) <> 29 THEN
    RAISE EXCEPTION 'closure pre-image: not all 29 alerts are still open';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_obligations o
                  WHERE o.id = 'fc19154d-89e7-4ce4-80f8-f3e6de03e24e'
                    AND o.adjustment_id = '04069754-fba7-46e4-89d5-5f96fe4fd437'
                    AND o.amount_owed = 2.00 AND o.amount_paid = 2.00 AND o.settled_at IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                     WHERE a.id = '04069754-fba7-46e4-89d5-5f96fe4fd437' AND a.status = 'approved') THEN
    RAISE EXCEPTION 'closure pre-image: adjustment 04069754 is no longer approved with its obligation paid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournament_obligations o
                  WHERE o.tournament_id = 'f7412940-5644-4194-8d57-4a97c182bf04' AND o.place = 1
                    AND o.user_id = 'a2bd256e-014c-4504-97c7-6bc43242fef1'
                    AND o.adjustment_id = 'd8e908a3-036b-4f36-85bb-feab1028c5cb'
                    AND o.amount_owed = 13441.68 AND o.amount_paid = 13441.68)
     OR NOT EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                     WHERE a.id = '41b3c7a0-e161-4faf-a558-c18735121ef8' AND a.status = 'rejected') THEN
    RAISE EXCEPTION 'closure pre-image: MamaGia''s place 1 or adjustment 41b3c7a0 is no longer as read';
  END IF;

  UPDATE public.financial_alerts f
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = c.note || ' Migration ' || c_mig || '.'
    FROM p6_alert_closures c
   WHERE f.id = c.id AND f.resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 29 THEN RAISE EXCEPTION 'closure: resolved % alerts, expected 29', v_n; END IF;

  UPDATE public.ca_manual_adjustments
     SET status = 'settled'
   WHERE id = '04069754-fba7-46e4-89d5-5f96fe4fd437' AND status = 'approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'closure: adjustment 04069754 did not settle'; END IF;

  UPDATE public.ca_manual_adjustments
     SET decision_note = 'Already paid: MamaGia received the 180.00 on 2026-09-09 06:03:41 through adjustment d8e908a3 (tournament f7412940, place 1 owed 13,441.68, paid 13,441.68). Settling this proposal would pay the same shortfall twice. Note restated by migration ' || c_mig || '.'
   WHERE id = '41b3c7a0-e161-4faf-a558-c18735121ef8' AND status = 'rejected';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'closure: decision note of 41b3c7a0 was not restated'; END IF;
END
$mig$;

COMMIT;
