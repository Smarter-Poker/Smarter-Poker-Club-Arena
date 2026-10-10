-- the_explained_alerts_close_with_their_evidence
--
-- Dan, 2026-10-09 18:32 CT: "FINISH ALL OF THESE UP NOW" on the open list,
-- item 1 (the 28 alerts) and item 2 (the 10-06 supply incident). Each group
-- below closes with the evidence that explains it. Data only; no money moves.
BEGIN;

-- 1. The Diamond felt: the replay and kill-switch incidents of 10-07, 10-08 and 10-09.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'The nightly ledger replay read the cash felt with Diamond seats included; no chip_ledger leg ever moves a Diamond seat, so every Diamond buy-in, pot and rake since Diamond cash opened on 2026-10-06 read as unexplained chip drift and tripped the kill switch.',
       correction_ref = 'migration the_chip_felt_counts_no_diamond_seat',
       resolution = 'Closed 2026-10-09 with evidence: 0 chip_ledger legs have ever named a Diamond table, and the Diamond felt grew to about 186,700 over these nights. Migration 20261009164317 reads the felt as the supply meter does (reader and meter agree to the cent) and took one new felt reading on that definition. The 10-07 reading also carries the 2026-10-06 house-horse retirement (-14,081.45), recorded on its own incident. No money moved.'
 WHERE status <> 'resolved'
   AND (source = 'fn_ca_ledger_replay'
        OR (source IN ('fn_ca_kill_switch_trip', 'financial_alerts:ca_kill_switch')
            AND discrepancy_amount IN (-4860.88, 117689.83, 42309.60)));

-- 2. The 10-06 supply reading: real, house horses only.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'At 2026-10-06 15:33:04 a bulk retirement of patterned house-horse identities vacated 42 cash seats holding 14,081.45 chips with session_replication_role = replica, so no trigger fired and no cashout or burn leg was written; only house horses were affected.',
       correction_ref = 'no-change-needed: the chips belonged to retired house horses, no player lost chips, and the supply meter recorded the true lower supply and has balanced every hour since',
       resolution = 'Closed 2026-10-09 on Dan''s instruction to finish the open list, with the cause recorded: 42 seats of 15 retired house-horse identities (cohort horse in smarter_private.patterned_identity_retirements) were vacated with triggers off, 14,081.45 chips in all; no player was affected. Supply is truly that much lower and every later hourly reading balances. No journal leg was posted: the only door that records one, fn_ca_post_correction, takes a management account.'
 WHERE status <> 'resolved'
   AND source IN ('fn_ca_kill_switch_trip', 'financial_alerts:ca_kill_switch')
   AND discrepancy_amount = -14081.45;

-- 3. The two refused transfers.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'A manual psql transfer from house account 47965354 into three club treasuries first ran without its ledger rows; the ledger invariant refused it and rolled it back, and the retried transfer posted its legs.',
       correction_ref = 'verified: the refused transaction moved nothing; fn_ca_treasury_positions reads ok (ledger equals stored) for a0000000, a41434bb and fade0000',
       resolution = 'Closed 2026-10-09 with evidence: the invariant refused this transaction, so it rolled back and moved nothing; the retried transfer posted its three player-to-treasury legs (1,012,131.36), and all three treasuries read ok against their ledger.'
 WHERE status <> 'resolved' AND source = 'ledger_invariant.refused';

-- 4. The orphaned-checks watch: both remaining functions are exempt with reasons.
UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(), closure_basis = 'verified_remeasured',
       root_cause = 'Two caller-driven check functions (an operator paged reader and the engine''s Lightning signal door) had no sweep exemption recorded, so the watch counted them as checks nobody runs.',
       correction_ref = 'migration two_caller_driven_checks_are_exempt_from_the_sweep',
       resolution = 'Closed 2026-10-09 with evidence: fn_ca_orphaned_checks() now returns no rows; fn_lightning_hand_replay_check and fn_lightning_integrity_scan had already left the list (the Lightning alert sweep runs the scan hourly).'
 WHERE status <> 'resolved' AND source = 'fn_ca_orphaned_checks_watch';

-- 5. The alert copies and the refused-hand alerts.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(),
       resolution = CASE
         WHEN source IN ('ServerTableEngine.authoritative_hand_semantic_refusal', 'postHandTasks.hand_history_failed')
           THEN 'Closed 2026-10-09 with evidence: the refused Diamond hand this alert names was disposed with zero credit by migration 20261009161306 at its resume door (every chair it named had closed and nothing of the hand was durable); its table has dealt continuously since.'
         WHEN source = 'drift_incident:ledger_invariant.refused'
           THEN 'Closed 2026-10-09 with evidence: the refused transaction rolled back and moved nothing; all three treasuries read ok against their ledger.'
         WHEN source = 'drift_incident:fn_ca_orphaned_checks_watch'
           THEN 'Closed 2026-10-09 with evidence: both remaining functions are caller-driven and now carry sweep exemptions; fn_ca_orphaned_checks() returns no rows.'
         WHEN COALESCE(context->>'amount', context->>'judged', '') IN ('-14081.45') OR source = 'drift_incident:fn_ca_supply_snapshot'
           THEN 'Closed 2026-10-09 with the cause recorded: the 2026-10-06 house-horse retirement vacated 42 seats (14,081.45 chips) with triggers off; no player was affected and the supply meter has balanced every hour since.'
         ELSE 'Closed 2026-10-09 with evidence: the ledger replay counted Diamond seats in the chip felt; migration 20261009164317 reads the felt as the supply meter does. No money moved.'
       END
 WHERE NOT resolved
   AND source IN ('ca_kill_switch', 'drift_incident:fn_ca_kill_switch_trip', 'drift_incident:financial_alerts:ca_kill_switch',
                  'drift_incident:fn_ca_ledger_replay', 'drift_incident:fn_ca_supply_snapshot',
                  'drift_incident:ledger_invariant.refused', 'drift_incident:fn_ca_orphaned_checks_watch',
                  'ServerTableEngine.authoritative_hand_semantic_refusal', 'postHandTasks.hand_history_failed');

COMMIT;
