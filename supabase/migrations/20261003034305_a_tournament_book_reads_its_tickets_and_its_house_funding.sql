-- 20261003034305_a_tournament_book_reads_its_tickets_and_its_house_funding.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A TOURNAMENT BOOK READS ITS TICKETS AND ITS HOUSE FUNDING (phase 4 of 9,
-- part two of the books close). Full account:
-- docs/changelog/2026-10-03-a-tournament-book-reads-its-tickets.md.
--
-- fn_tournament_money_conservation held 22 open alerts on 2026-10-03, and
-- every one was fn_tournament_conservation_delta, not the money:
--
--   * 20 "retained money it never paid out". fn_settle_satellite_tournament
--     records a seat delivered as a TICKET with the ticket on the payout row
--     (metadata.ticket_id) and no tournament_satellite_awards row. The delta
--     found tickets only through the award row, so every such row read as a
--     seat that arrived, redeemed or not: Sunday Funday Main Event seated 15
--     qualifiers and was credited with 40 arrivals (+2,500.00). The ticket now
--     resolves from the award row or, failing that, from the payout row.
--   * 2 "paid out money it never collected" (-180.00). Both Sunday $200 Deep
--     Stack events paid a bubble-protection place from a house leg into
--     prize_liability labelled 'correction'. Such a leg now funds the pool, as
--     its own term beside the overlay; a player's or suspense leg never does.
--
-- fn_pay_backed_payout_shortfalls carries the same arithmetic inline and reads
-- its delta as "what the pool holds"; it reads tickets and house corrections
-- the same way, so batch and scalar stay one accounting question. Qualified on
-- native PG17 by scripts/ci/fixtures/backed-payout-scan/ticket-funding-native.py
-- (original formula red reproduced, independent oracle, whole-caller parity,
-- authority, rollback). Production read (one rolled-back call): 22 corrected,
-- 0 moved the wrong way. No chip moves, nothing is backfilled (CLAUDE.md 10.12).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = 'bfbb3e617d7c8290ac8916e21bf0c2a4' AND md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = '10c5a2d39477380157d133a7b5bc113d')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) IS DISTINCT FROM '46647067aa049dcb9bda93fa0a1a35b3'
     OR md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) IS DISTINCT FROM '9078403312e51a873e6e7462555dcf7e' THEN
    RAISE EXCEPTION 'TICKET_FUNDING_PREIMAGE_CHANGED';
  END IF;
  IF has_function_privilege('anon', 'public.fn_pay_backed_payout_shortfalls(boolean,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_pay_backed_payout_shortfalls(boolean,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TICKET_FUNDING_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

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
      )
      -- A REVIEWED VOID RETURNS ITS OVERLAY (2026-09-27): one 'reversal' leg
      -- out of prize_liability back to the funder. The event kept none of it.
      - COALESCE((SELECT sum(r.amount) FROM public.chip_ledger r
           WHERE r.tournament_id = t.id AND r.category = 'reversal'
             AND r.from_type = 'prize_liability' AND r.from_entity_id = t.id
             AND r.metadata->>'kind' = 'reviewed_void_overlay_return'), 0)
      AS funded_overlay,

      -- A HOUSE CORRECTION FUNDS THE POOL TOO (2026-10-03). A bubble-protection
      -- place was funded club_treasury|union_bank -> prize_liability as a
      -- 'correction' leg. It is its own funding, beside any overlay, so it is
      -- added rather than folded into the GREATEST above. A player's leg or a
      -- suspense leg is never house funding.
      COALESCE((SELECT sum(c.amount) FROM public.chip_ledger c
         WHERE c.tournament_id = t.id
           AND c.category = 'correction'
           AND c.to_type = 'prize_liability'
           AND c.from_type IN ('union_bank','club_treasury')), 0) AS house_correction,

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
         LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END) -- no award row: the payout carries its ticket (2026-10-03)
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
         LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>'ticket_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (sp.metadata->>'ticket_id')::uuid END) -- no award row: the payout carries its ticket (2026-10-03)
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
    + m.house_correction
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$function$;

DO $batch$
DECLARE
  v_src text;
  v_new text;
  c_old1 CONSTANT text := 'LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id';
  c_new1 CONSTANT text := 'LEFT JOIN public.tournament_tickets k ON k.id = COALESCE(a.ticket_id, CASE WHEN sp.metadata->>''ticket_id'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' THEN (sp.metadata->>''ticket_id'')::uuid END) -- no award row: the payout carries its ticket (2026-10-03)';
  c_old2 CONSTANT text := '    ), seat_income AS MATERIALIZED (';
  c_new2 CONSTANT text := '    ), house_corrections AS MATERIALIZED (
      SELECT l.tournament_id AS id, sum(l.amount) AS amount
      FROM public.chip_ledger l JOIN eligible e ON e.id = l.tournament_id
      WHERE l.category = ''correction'' AND l.to_type = ''prize_liability''
        AND l.from_type IN (''union_bank'',''club_treasury'')
      GROUP BY l.tournament_id
    ), seat_income AS MATERIALIZED (';
  c_old3 CONSTANT text := '          + GREATEST(COALESCE(l.overlay, 0), COALESCE(o.amount, 0)) - COALESCE(ro.returned, 0)
';
  c_new3 CONSTANT text := '          + GREATEST(COALESCE(l.overlay, 0), COALESCE(o.amount, 0)) - COALESCE(ro.returned, 0)
          + COALESCE(hc.amount, 0)
';
  c_old4 CONSTANT text := '      LEFT JOIN returned_overlays ro ON ro.id = e.id
';
  c_new4 CONSTANT text := '      LEFT JOIN returned_overlays ro ON ro.id = e.id
      LEFT JOIN house_corrections hc ON hc.id = e.id
';
BEGIN
  v_src := pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);
  IF (length(v_src) - length(replace(v_src, c_old1, ''))) / length(c_old1) <> 2
     OR (length(v_src) - length(replace(v_src, c_old2, ''))) / length(c_old2) <> 1
     OR (length(v_src) - length(replace(v_src, c_old3, ''))) / length(c_old3) <> 1
     OR (length(v_src) - length(replace(v_src, c_old4, ''))) / length(c_old4) <> 1 THEN
    RAISE EXCEPTION 'TICKET_FUNDING_BATCH_CHANGED';
  END IF;
  v_new := replace(replace(replace(replace(v_src, c_old1, c_new1), c_old2, c_new2), c_old3, c_new3), c_old4, c_new4);
  IF md5(v_new) IS DISTINCT FROM '10c5a2d39477380157d133a7b5bc113d' THEN
    RAISE EXCEPTION 'TICKET_FUNDING_BATCH_CHANGED';
  END IF;
  EXECUTE v_new;
END
$batch$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) IS DISTINCT FROM 'bfbb3e617d7c8290ac8916e21bf0c2a4'
     OR md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) IS DISTINCT FROM '10c5a2d39477380157d133a7b5bc113d' THEN
    RAISE EXCEPTION 'TICKET_FUNDING_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
