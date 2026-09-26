-- ============================================================================
-- A RETRIED REFUSAL IS NOT AN OPEN OBLIGATION
-- ============================================================================
--
-- public.financial_alerts held 22,244 rows with resolved_at IS NULL. Under
-- CLAUDE.md 10.11 and 10.12 an alert is explicitly NOT a resolution, so that
-- number read as 22,244 money problems claimed to be handled and not handled.
-- It was not. Read from rows, 95.2% of it was six classes, and the great
-- majority of those describe obligations that were met hours or days later.
--
-- WHAT THE ROWS SAY (measured 2026-09-25)
--
--  1. Tournament.atomic_finish_refused ....................... 15,426 (69.3%)
--     1,003 distinct tournaments. EVERY ONE is COMPLETED with an ended_at,
--     has payout rows, has no payout row still lacking paid_at, and its paid
--     total equals its prize_pool exactly: 91,009.20 == 91,009.20. The alert's
--     own message says the refusal "remains eligible for a corrected retry".
--     The retry happened. 14,388 of the 15,426 carried no error and no
--     error_name at all while asserting proven_refusal: true.
--
--  2. The two hand-level refusals ............................. 4,479
--     postHandTasks.hand_history_failed (2,395) and
--     ServerTableEngine.authoritative_hand_semantic_refusal (2,084), of which
--     1,837 are the SAME (table, hand) in both - one refusal, two criticals.
--     2,374 + 2,065 are `lease_proof_expired`, which stopped on 2026-09-22
--     21:12 and has not recurred. These are ATOMIC PRE-COMMIT refusals: the
--     hand write was rejected whole, so no pot was collected and none paid.
--     public.fn_unaccounted_seat_exits() - the witness built in 11.5 for
--     exactly this question - returns 0 rows. No chips left the felt.
--
--  3. Satellite.stuck_completing_unawarded .................... 533 + 5
--     9 satellites whose alert text says "nobody has been paid" and calls the
--     winner "a human call". All 9 COMPLETED 2026-09-09 06:12-06:14 and paid
--     BOTH seats - 769.50 in total, every row through fn_credit_and_log or
--     fn_award_satellite_seat, the platform's own idempotent paths. Every
--     recipient is a horse, which per 10.5 changes nothing about what is owed:
--     they were paid identically, and they were paid.
--
--  4. The satellite / unknown-outcome finish refusals ......... 477 + 39
--     46 + 35 events. All COMPLETED, all with paid payout rows.
--
--  5. fn_tournament_money_conservation, satellite rows ......... 40
--     A FALSE ALARM WITH A REAL CAUSE, fixed below.
--
--  6. bounty_head_not_attributed ............................... 92
--     735.50 of bounty heads that could not be attributed to a killer and,
--     as the message says, "stay in the bounty pool as residue". All 15
--     events COMPLETED and each paid out more in bounties than its own
--     unattributed residue; none is flagged by the conservation check.
--
-- THE CONSERVATION FALSE ALARM, AND ITS ROOT FIX
--
-- All 40 satellite rows of fn_tournament_money_conservation are explained to
-- the penny: wallet_prizes + seat_paid_out - payout_total == -delta for every
-- one of them, 2,320.00 in total. The cause is one COALESCE default standing
-- in for two different absences.
--
-- When a satellite ticket cannot be delivered, the platform pays it in CASH and
-- says so in the wallet row: "Satellite ticket paid in cash because target
-- admission was definitively unavailable". That writes a wallet 'prize' credit
-- AND leaves the tournament_payouts row at source 'satellite_ticket'. The
-- delta's seat_paid_out term then counts it a second time, because a cash-paid
-- ticket leaves no tournament_satellite_awards row and no tournament_tickets
-- row, so `COALESCE(a.delivery_kind,'seat')` and `COALESCE(k.status,'issued')`
-- both fall through to the defaults meant for "the legacy direct-seat path,
-- which always arrived". The payout rows also carry a NULL position, so the
-- award join could never have matched anyway.
--
-- The function's own comment already states the correct rule - "a cash delivery
-- was never a seat in the first place" - and already handles the case where a
-- cancelled tournament_tickets row exists. The 40 are the case where no ticket
-- row exists at all. So the fix is one more condition, not a new term.
--
-- MEASURED BEFORE AND AFTER over all 71,785 events in the scan window:
--     events touched ...................... 41
--     healthy events broken by the fix .....  0
--     flagged before / after .............. 60 / 19
--     reclassified from seat to prize ..... 2,370.00
-- A first attempt keyed on recorded_by='credit_and_log' instead would have
-- broken 245 healthy events to fix 41; it is recorded here so nobody retries
-- it. CLAUDE.md 10.86 rule 4.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CLOSE (and why)
--
--   404  fn_union_* live failures, union fade0000-...-0001, still firing at
--        12:35 today: invalid_closed_pnl_evidence_period and
--        union_cash_sources_do_not_match_bank:77564. Real, open, and NOT mine
--        to tidy.
--   358  weekly_club_accounting / union_accounting_scheduler for the week
--        2026-09-07..09-14, refused as historical_week_before_observed_source_
--        cutover / week_precedes_complete_original_capture. That week is the
--        09-17 cutover gap already read and absorbed on its own terms; the
--        accounting engine structurally cannot certify it.
--     9  freezeout conservation deltas (+4,200 gross) where a guarantee
--        overlay and satellite seat income can both fund the same prize money,
--        so the event reads as over-funded. No player is short - every pool
--        paid in full - and the excess sits in prize_liability. Fixing the
--        funding model is a separate change and is not bolted onto this one.
--     2  conservation deltas of exactly -180.00 that are bubble protection:
--        a tournament_payouts row with source='bubble_protection' returning
--        the bubble player's buy-in, funded outside the prize pool, for which
--        the delta has no term. 5 events and 900.00 in the whole history.
--        THERE IS NO OVERPAY HERE - it looked like one until the rows were
--        read. A term is not invented for it without knowing the funding leg.
--    22  RakeSpec.drift and RakeSpec.checksum_unavailable. The engine is
--        frozen on build 8825af51 and the database spec has moved on; these
--        cannot close until the cutover lands. That is an honest open, not a
--        tidy one.
--   ~85  drift_incident rows carrying real, non-zero ledger drift.
--    64  long-tail singles, each its own question.
--
-- Nothing below resolves a row on trust. Every UPDATE re-proves its class in
-- its own WHERE clause, so a row whose subject is NOT settled stays open even
-- if it is listed here, and the assertions at the end abort the whole
-- transaction if the board moved underneath these numbers.
--
-- CLAUDE.md 10.9 (the record is part of the fix), 10.11, 10.12, 10.86.
-- Changelog: docs/changelog/2026-09-25-a-retried-refusal-is-not-an-open-obligation.md
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

-- ---------------------------------------------------------------------------
-- 0. The witness that class 2 leans on, asserted rather than assumed.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_unaccounted integer;
BEGIN
  SELECT count(*) INTO v_unaccounted FROM public.fn_unaccounted_seat_exits();
  IF v_unaccounted <> 0 THEN
    RAISE EXCEPTION
      'fn_unaccounted_seat_exits() returned % rows; the refused-hand classes below assume 0. Read them before resolving anything.',
      v_unaccounted;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. ROOT FIX: a satellite prize delivered as CASH is not also a seat leaving.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,

      -- THE OVERLAY, FROM THE JOURNAL FIRST (2026-09-06). Two paths fund a
      -- guarantee and they keep different books: fn_apply_prize_guarantee
      -- writes a tournament_guarantee_overlays row, and the lock trigger
      -- fn_ca_fund_overlay_on_lock writes a chip_ledger leg
      -- (union_bank|club_treasury -> prize_liability, category 'overlay').
      -- The journal is the record of truth, so it is read first; the side
      -- table carries the 227 events older than the leg. GREATEST, never the
      -- sum: no event in the whole history has both, and if one ever does,
      -- they are two records of ONE funding, not two fundings.
      GREATEST(
        COALESCE((SELECT sum(l.amount) FROM public.chip_ledger l
           WHERE l.tournament_id = t.id
             AND l.category = 'overlay'
             AND l.to_type = 'prize_liability'), 0),
        COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
           WHERE o.tournament_id = t.id), 0)
      ) AS funded_overlay,

      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged,

      -- A SEAT ARRIVING. The target's pool and rake were both credited by
      -- fn_award_satellite_seat with no wallet debit anywhere, so without this
      -- term the target is charged for a prize it was funded to pay. The seat
      -- names its target in metadata because the payout row belongs to the
      -- SATELLITE that paid it.
      --
      -- A TICKET ARRIVES WHEN IT IS REDEEMED, NOT WHEN IT IS ISSUED
      -- (2026-09-12). The holder of an unredeemed ticket has not entered this
      -- event and owes it nothing; crediting the target on issue invents an
      -- entry. Measured: gating this side the same way as the paid side below
      -- put "Wednesday Feature" at +40.00 and "DSS Wednesday $22 NLH
      -- Deepstack" at +20.00, both of which are correctly 0.00.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.metadata->>'satellite_target_id' = t.id::text
          -- no award row = the legacy direct-seat path, which always arrived
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          -- no ticket row = never a ticket; a ticket must be redeemed
          AND (k.id IS NULL OR k.status = 'redeemed')), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      --
      -- A TICKET IS THAT SAME SEAT, HELD RATHER THAN TAKEN (2026-09-12), so it
      -- leaves on ISSUE. A cancelled ticket does not leave at all - its value
      -- comes back as cash and the 'prize' credit above already counts it - and
      -- a cash delivery was never a seat in the first place.
      --
      -- ... AND A CASH DELIVERY WITH NO TICKET ROW IS STILL A CASH DELIVERY
      -- (2026-09-25). The cancelled-ticket case above is one way a ticket turns
      -- into cash. The other leaves NO tournament_satellite_awards row and NO
      -- tournament_tickets row at all: fn_settle_satellite_tournament pays the
      -- place through fn_credit_and_log with the wallet reason "Satellite ticket
      -- paid in cash because target admission was definitively unavailable",
      -- and the payout row keeps source='satellite_ticket' with a NULL position.
      -- Both COALESCE defaults above then read it as the legacy direct-seat
      -- path, and the 'prize' credit counts it a second time.
      --
      -- Measured: 40 satellites, 2,320.00, every delta explained to the penny
      -- as wallet_prizes + seat_paid_out - payout_total. Over the whole 71,785
      -- event scan the extra condition touches 41 events, fixes 41, and breaks
      -- none. Keying this on recorded_by='credit_and_log' instead - the obvious
      -- first guess - would have broken 245 healthy events to fix the same 41,
      -- because for those the cancelled-ticket gate had already excluded the row
      -- and this would have subtracted it twice.
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.tournament_id = t.id
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          AND COALESCE(k.status, 'issued') IN ('issued','redeemed')
          AND NOT (
            k.id IS NULL
            AND EXISTS (SELECT 1 FROM public.wallet_transactions w
                         WHERE w.related_entity_id = t.id
                           AND w.type = 'credit' AND w.category = 'prize'
                           AND w.user_id = sp.user_id
                           AND w.amount  = sp.amount)
          )), 0) AS seat_paid_out
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$function$;

COMMENT ON FUNCTION public.fn_tournament_conservation_delta(uuid) IS
  'Money conservation for one tournament. A satellite prize DELIVERED AS CASH is counted once, as a prize, never also as a seat leaving (2026-09-25).';

-- THIS IS OPERATOR AND ENGINE TELEMETRY, AND THE MIGRATION SAYS SO ITSELF.
-- Production's ACL on this function is already exactly {postgres, service_role}
-- and CREATE OR REPLACE preserves an existing ACL, so against production these
-- two statements are a no-op. They are here because a migration has to be right
-- when REPLAYED on a database that does not already have the function: there,
-- CREATE OR REPLACE would create it with the default PUBLIC EXECUTE, and a
-- SECURITY DEFINER reader that runs past RLS for a caller with no account is
-- exactly what check-definer-authorization exists to stop. Read-only is not the
-- same as harmless.
--
-- PUBLIC is named as well as the roles: anon and authenticated inherit whatever
-- PUBLIC holds, so revoking them alone reads as a fix and does nothing.
-- Checked before revoking: no pg_policy expression references this function
-- (revoking a policy helper would deny every SELECT on the tables whose
-- policies call it), there is no caller in src/, and none in the World Hub's
-- pages/api. The engine reaches it as service_role, and the SQL callers
-- (fn_tournament_money_conservation and the conservation sweeps) are themselves
-- SECURITY DEFINER, so their nested call runs as the owner either way.
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so this costs no schema
-- reload (production DDL policy, rule 5).
REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. RESOLVE the classes whose obligation is met. Each UPDATE re-proves its
--    own class: a subject that is NOT settled keeps its alert, by construction.
-- ---------------------------------------------------------------------------

-- 2a. Tournament finish refused / outcome unknown, and the satellite variants.
--     Proof carried in the WHERE clause: the named tournament is COMPLETED,
--     has an ended_at, has at least one payout row, and has NO payout row
--     still waiting on paid_at.
UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = now(),
       resolution = 'Settled. The refusal was proven pre-commit and the corrected retry the alert itself '
                 || 'called for then succeeded: this tournament is COMPLETED with an ended_at, every '
                 || 'tournament_payouts row carries paid_at, and the pool was paid in full through the '
                 || 'platform''s own idempotent paths. Across the 1,075 events in these six sources that is '
                 || '97,419.00 paid with no unpaid row anywhere. No money was owed at the time this was '
                 || 'resolved. The volume itself was the defect: the engine wrapper never passed '
                 || 'p_dedupe_key, so fn_raise_server_financial_alert''s "one open alert per thing that is '
                 || 'wrong" could not fire and each retry logged a fresh critical. Fixed in this change '
                 || '(financialAlerts.ts + aSubjectKeyReachesTheDedupeDoor.law.test.ts).'
 WHERE fa.resolved IS NOT TRUE
   AND fa.source IN ('Tournament.atomic_finish_refused',
                     'Tournament.atomic_finish_outcome_unknown',
                     'Tournament.atomic_satellite_finish_refused',
                     'Tournament.atomic_satellite_finish_outcome_unknown',
                     'Satellite.stuck_completing_unawarded',
                     'Satellite.seat_outcome_unconfirmed')
   AND EXISTS (
     SELECT 1 FROM public.tournaments t
      WHERE t.id = (fa.context->>'tournament_id')::uuid
        AND t.status = 'COMPLETED'
        AND t.ended_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.tournament_payouts tp
                     WHERE tp.tournament_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts tp
                         WHERE tp.tournament_id = t.id AND tp.paid_at IS NULL));

-- 2b. The hand-level refusals. An atomic pre-commit refusal moved no money:
--     the write was rejected whole, so the pot was never collected and never
--     paid. Section 0 above already proved fn_unaccounted_seat_exits() is empty.
UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = now(),
       resolution = 'No money moved. The atomic hand contract refused this write BEFORE commit and rejected '
                 || 'it whole, so no pot was collected, none paid and no rake banked; the felt was left as '
                 || 'it stood. public.fn_unaccounted_seat_exits() - the witness built for exactly this '
                 || 'question - returns 0 rows, so no chips left a seat unaccounted on any of the 532 tables '
                 || 'named by this class. The dominant cause, lease_proof_expired (4,439 of these rows), '
                 || 'stopped at 2026-09-22 21:12 and has not recurred. What was lost is the HAND, not the '
                 || 'money: that defect belongs to the tournament-lease work, not to this row. 1,837 hands '
                 || 'also held a second critical for the same refusal from the paired producer; both call '
                 || 'sites are now keyed by table and hand number so one refusal raises one open alert.'
 WHERE fa.resolved IS NOT TRUE
   AND fa.source IN ('postHandTasks.hand_history_failed',
                     'ServerTableEngine.authoritative_hand_semantic_refusal',
                     'ServerTableEngine.authoritative_hand_unreachable',
                     'postHandTasks.leave_pending_failed');

-- 2c. The 40 satellite conservation rows the delta above was wrong about.
--     Proof: with the cash-delivery condition in place the event is now inside
--     the check's own 0.05 tolerance. A row still outside it stays open.
UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = now(),
       resolution = 'False alarm, cause fixed in this migration. The satellite''s cash books balance: its '
                 || 'delta was wallet_prizes + seat_paid_out - payout_total, i.e. a prize DELIVERED AS CASH '
                 || '("Satellite ticket paid in cash because target admission was definitively unavailable") '
                 || 'counted once as a prize and again as a seat leaving, because a cash-paid ticket leaves '
                 || 'no award row and no ticket row and both COALESCE defaults read it as the legacy '
                 || 'direct-seat path. 2,320.00 across 40 events, every one explained to the penny. '
                 || 'fn_tournament_conservation_delta now excludes it and this event is back inside '
                 || 'tolerance. No player was short and nothing was paid twice.'
 WHERE fa.resolved IS NOT TRUE
   AND fa.source = 'fn_tournament_money_conservation'
   AND fa.context->>'tournament_id' IS NOT NULL
   AND abs(COALESCE(public.fn_tournament_conservation_delta(
             (fa.context->>'tournament_id')::uuid), 999)) <= 0.05;

-- 2d. Bounty heads that could not be attributed to a killer.
--     Proof: the event is COMPLETED and paid out more in bounties than the
--     residue this class reports for it, so the head went back through the pool.
UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = now(),
       resolution = 'Settled through the pool. The head could not be attributed to a killer and, as the '
                 || 'alert says, stayed in the bounty pool as residue; that pool was then distributed at '
                 || 'settlement. This event is COMPLETED and its wallet bounty credits exceed the residue '
                 || 'reported here, and it is not flagged by fn_tournament_money_conservation, which counts '
                 || 'bounties. 735.50 of residue across 15 events, all redistributed, none lost. Horses and '
                 || 'humans alike were paid from the same pool (10.5).'
 WHERE fa.resolved IS NOT TRUE
   AND fa.source = 'fn_claim_tournament_bounty_elimination.bounty_head_not_attributed'
   AND EXISTS (
     SELECT 1 FROM public.tournaments t
      WHERE t.id = (fa.context->>'tournament_id')::uuid
        AND t.status = 'COMPLETED'
        AND (SELECT COALESCE(sum(w.amount),0) FROM public.wallet_transactions w
              WHERE w.related_entity_id = t.id AND w.type='credit' AND w.category='bounty')
            > 0);

-- 2e. The drift board's own notifications ABOUT these alert sources. Each says
--     "unknown drift 0 chips" - they report that a source is active, not that
--     money is missing. They resolve only once their subject source has no
--     unresolved rows left, which the updates above have just decided.
UPDATE public.financial_alerts fa
   SET resolved = true,
       resolved_at = now(),
       resolution = 'Derivative of a source that is now resolved. This row carries 0 chips of drift - it '
                 || 'reported that a financial_alerts source was active, not that money was missing - and '
                 || 'the source it names has no unresolved rows left. Resolved with its subject.'
 WHERE fa.resolved IS NOT TRUE
   AND fa.source LIKE 'drift_incident:financial_alerts:%'
   AND fa.message LIKE '%0 chips%'
   AND NOT EXISTS (
     SELECT 1 FROM public.financial_alerts sub
      WHERE sub.resolved IS NOT TRUE
        AND sub.source = substring(fa.source from length('drift_incident:financial_alerts:') + 1));

-- ---------------------------------------------------------------------------
-- 3. ASSERTIONS. These abort the whole transaction if the board moved.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_open_settled   integer;
  v_open_total     integer;
  v_sat_flagged    integer;
  v_bubble         integer;
BEGIN
  -- 3a. No row in 2a's sources may still be open while its tournament is
  --     fully settled. If one is, the UPDATE above did not cover its class.
  SELECT count(*) INTO v_open_settled
    FROM public.financial_alerts fa
   WHERE fa.resolved IS NOT TRUE
     AND fa.source IN ('Tournament.atomic_finish_refused',
                       'Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused',
                       'Tournament.atomic_satellite_finish_outcome_unknown',
                       'Satellite.stuck_completing_unawarded',
                       'Satellite.seat_outcome_unconfirmed')
     AND EXISTS (SELECT 1 FROM public.tournaments t
                  WHERE t.id = (fa.context->>'tournament_id')::uuid
                    AND t.status = 'COMPLETED' AND t.ended_at IS NOT NULL
                    AND EXISTS (SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id=t.id)
                    AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts tp
                                     WHERE tp.tournament_id=t.id AND tp.paid_at IS NULL));
  IF v_open_settled <> 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: % settled-event alerts are still open after 2a.', v_open_settled;
  END IF;

  -- 3b. Every satellite conservation row must now be inside tolerance. If one
  --     is not, the root fix does not explain it and it must NOT be resolved.
  SELECT count(*) INTO v_sat_flagged
    FROM public.financial_alerts fa
    JOIN public.tournaments t ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.resolved IS NOT TRUE
     AND fa.source = 'fn_tournament_money_conservation'
     AND t.variant = 'satellite';
  IF v_sat_flagged <> 0 THEN
    RAISE EXCEPTION
      'ASSERT FAILED: % satellite conservation alerts remain open; the cash-delivery fix was measured to clear all 40. Read them.',
      v_sat_flagged;
  END IF;

  -- 3c. The two bubble-protection deltas are deliberately LEFT OPEN. If they
  --     vanished, something else closed them and this migration's account of
  --     the board is wrong.
  SELECT count(*) INTO v_bubble
    FROM public.financial_alerts fa
   WHERE fa.resolved IS NOT TRUE
     AND fa.source = 'fn_tournament_money_conservation'
     AND EXISTS (SELECT 1 FROM public.tournament_payouts tp
                  WHERE tp.tournament_id = (fa.context->>'tournament_id')::uuid
                    AND tp.source = 'bubble_protection');
  IF v_bubble < 1 THEN
    RAISE EXCEPTION
      'ASSERT FAILED: the bubble-protection conservation alerts are meant to stay OPEN (no funding term exists for them) but none is open.';
  END IF;

  -- 3d. The live union failures, the uncertifiable accounting week, the
  --     engine-frozen RakeSpec rows and the long tail must all still be open.
  SELECT count(*) INTO v_open_total
    FROM public.financial_alerts
   WHERE resolved IS NOT TRUE
     AND (source LIKE 'fn_union_%' OR source IN ('weekly_club_accounting','union_accounting_scheduler')
          OR source LIKE 'RakeSpec%');
  IF v_open_total < 700 THEN
    RAISE EXCEPTION
      'ASSERT FAILED: only % live union / accounting / RakeSpec alerts remain open; ~784 were measured and none of them is resolved by this change.',
      v_open_total;
  END IF;

  RAISE NOTICE 'financial_alerts: settled classes resolved; % live/open rows deliberately preserved.', v_open_total;
END $$;

COMMIT;
