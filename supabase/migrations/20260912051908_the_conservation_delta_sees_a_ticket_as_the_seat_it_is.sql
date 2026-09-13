-- 20260912051908_the_conservation_delta_sees_a_ticket_as_the_seat_it_is.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- A SEAT PAID AS A TICKET IS STILL A SEAT LEAVING THE SATELLITE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG
--
-- 120 open financial_alerts from fn_tournament_money_conservation, 117 of them
-- "Tournament retained money it never paid out", summing to exactly 9,100.00.
-- No money was missing. Every chip was in an issued, backed tournament ticket
-- held by the player who won it.
--
-- On 2026-09-09 satellite seat delivery gained a second path: a ticket
-- (tournament_tickets, payout source 'satellite_ticket'). Its twin detector,
-- fn_satellite_conservation_audit, was taught about it the same day
-- (20260909235715, 20260909235935) and again on 2026-09-10 (20260910064305).
-- fn_tournament_conservation_delta - last changed 2026-09-06 - was not. Both of
-- its seat terms read `sp.source = 'satellite_seat'` and nothing else, so a seat
-- paid as a ticket was invisible on BOTH the leaving and the arriving side, and
-- the satellite looked as though it had kept the seat's value.
--
-- That the two totals match to the penny is the proof: the 9,100.00 of open
-- "retained" alerts is exactly the value of the 118 ticket-delivered seats.
--
-- WHY THIS IS NOT JUST "ADD THE SOURCE STRING" - TWO TRAPS, BOTH MEASURED
--
-- TRAP 1 - A CASH DELIVERY IS NOT A SEAT. 48 satellite_ticket payouts totalling
-- 4,095.00 are delivery_kind='cash': a capped winner paid in chips, who writes
-- the same payout row as a held ticket. All 48 already hold a matching wallet
-- 'prize' credit (verified: 48 of 48), so counting them as seats would
-- double-subtract and manufacture 48 NEW false alerts pointing the other way.
-- The award row says which delivery happened, and this is the repo's own
-- existing rule - "A CASH DELIVERY IS NOT A SEAT (2026-09-10)" in
-- fn_satellite_conservation_audit.
--
-- TRAP 2 - THE TWO SIDES ARE NOT SYMMETRIC, AND COPYING ONE ONTO THE OTHER
-- BREAKS IT. A ticket leaves the satellite the moment it is ISSUED; it arrives
-- in the target only when it is REDEEMED. Gating both sides identically on
-- delivery_kind alone credits a target for an entry that has not happened:
-- measured on this database, that moved "Wednesday Feature" from a clean 0.00
-- to +40.00 and "DSS Wednesday $22 NLH Deepstack" from 0.00 to +20.00 - two
-- fresh false alerts created by the fix for the false alerts. So:
--
--   seat_paid_out (the satellite) counts an issued OR redeemed ticket;
--   seat_income   (the target)    counts a REDEEMED ticket only.
--
-- A cancelled ticket is neither: its value returns as cash and the wallet
-- 'prize' credit already accounts for it. That too is the audit's own rule.
--
-- WHY THE LEGACY ROWS FORCE A LEFT JOIN, NOT AN INNER ONE
--
-- 1,319 of 1,511 'satellite_seat' payouts predate tournament_satellite_awards
-- and have NO award row at all. An inner JOIN onto the award table - the shape
-- fn_satellite_conservation_audit can safely use, because there it is one
-- branch of a UNION with two other branches to catch them - would silently drop
-- all 1,319 here, where these terms are the only ones there are. Hence LEFT
-- JOIN with COALESCE defaults: absent award row means the legacy direct-seat
-- path, absent ticket row means it was never a ticket. Both LEFT JOINs are on
-- unique keys (tournament_satellite_awards PK (tournament_id, place); tickets
-- by id), so neither can fan out a sum().
--
-- WHAT THIS FIXES, MEASURED BEFORE IT WAS WRITTEN
--
--   118 tournaments return to a delta of 0.00 (117 satellites + the target
--       "DSS Thursday $22 NLH Deepstack", which was -20.00 because a redeemed
--       ticket arrived that nothing credited);
--     0 tournaments that were inside tolerance move outside it;
--     2 remain outside tolerance and are REGISTERING, so no scan sees them -
--       in-flight targets holding buy-ins they have not paid out yet.
--
-- Nothing is paid, moved, refunded or clawed back. This is a DETECTOR fix: the
-- money was always correct and only the arithmetic that watched it was wrong.
-- The 118 open alerts close themselves on the next hourly sweep - Pass 1 of
-- fn_tournament_money_conservation recomputes this delta for every open alert
-- and resolves the ones inside tolerance (cron tourney_money_conservation_hourly,
-- jobid 144, '12 * * * *', tolerance 1.0).
--
-- NOT FIXED, DELIBERATELY: alerts a449e853 and f7412940, both "Sunday $200 Deep
-- Stack", ended 2026-09-06 (before tickets existed), each -180.00. No satellite
-- seat or ticket payout changes their arithmetic by a single chip - asserted
-- below - and they stay open for whoever picks up their actual cause.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Capture what the CURRENT function says, so the assertions below compare
-- before against after rather than against a number typed by hand. A literal
-- would go stale between writing this and the pipeline applying it; a
-- comparison cannot.
--
-- Scope: every tournament with an open conservation alert, plus every
-- satellite holding a cash-delivery award. Those are the outcomes this
-- migration claims. No other tournament's delta can move - the only terms
-- that change are the two seat terms, and they are zero for a tournament with
-- no satellite seat or ticket payout on either side.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE zz_delta_before ON COMMIT DROP AS
  SELECT id, public.fn_tournament_conservation_delta(id) AS delta
    FROM (
      SELECT DISTINCT (fa.context->>'tournament_id')::uuid AS id
        FROM public.financial_alerts fa
       WHERE fa.source = 'fn_tournament_money_conservation'
         AND fa.resolved IS NOT TRUE
         AND fa.context->>'tournament_id' IS NOT NULL
      UNION
      SELECT DISTINCT sp.tournament_id
        FROM public.tournament_payouts sp
        JOIN public.tournament_satellite_awards a
          ON a.tournament_id = sp.tournament_id AND a.place = sp.position
       WHERE a.delivery_kind = 'cash'
      UNION
      SELECT unnest(ARRAY['a449e853-4ee1-4e36-bd38-8fe904664d7c',
                          'f7412940-5644-4194-8d57-4a97c182bf04']::uuid[])
    ) s
   WHERE s.id IS NOT NULL;

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
      COALESCE((SELECT sum(sp.amount)
         FROM public.tournament_payouts sp
         LEFT JOIN public.tournament_satellite_awards a
                ON a.tournament_id = sp.tournament_id AND a.place = sp.position
         LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
        WHERE sp.source IN ('satellite_seat','satellite_ticket')
          AND sp.tournament_id = t.id
          AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
          AND COALESCE(k.status, 'issued') IN ('issued','redeemed')), 0) AS seat_paid_out
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
  'Conservation delta for one tournament. A satellite seat delivered as a ticket '
  'counts as paid out when the ticket is ISSUED and as income to the target only '
  'when it is REDEEMED; a cash delivery and a cancelled ticket are not seats - '
  'the wallet prize credit already carries them. Must agree with '
  'fn_satellite_conservation_audit on which payout sources are a delivered seat '
  '(tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts).';

-- THE ACCESS POSTURE IS RESTATED, NOT ASSUMED (2026-09-12).
--
-- CREATE OR REPLACE FUNCTION keeps the privileges the function already has, so
-- this replacement does not reopen anything: production already holds exactly
-- `postgres=X/postgres | service_role=X/postgres`, closed by
-- 20260906024945_the_conservation_delta_is_telemetry_and_answers_no_stranger.
-- But a migration that redefines a SECURITY DEFINER function and says nothing
-- about who may call it leaves the next reader to go and look, and
-- scripts/ci/check-definer-authorization.mjs is right to refuse it. This is
-- operator telemetry - remedy 1 - so it says so in its own text.
--
-- PUBLIC is named alongside anon and authenticated because anon inherits
-- whatever PUBLIC holds, so revoking anon alone reads as a fix and changes
-- nothing. Verified against pg_policy before revoking: no RLS policy
-- expression anywhere references this function, so nothing evaluates it as the
-- querying role and no SELECT is denied by closing it.
--
-- GRANT/REVOKE are not in pgrst_ddl_watch's list, so these two statements cost
-- no schema-cache reload (CLAUDE.md section 2, rule 5).
REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid)
  TO service_role;

DO $assert$
DECLARE
  v_regressed   integer;
  v_changed     integer;
  v_mismatched  integer;
  v_tickets_counted integer;
  v_healed      integer;
  v_tol         numeric := 1.0;   -- the tolerance the hourly cron actually uses
BEGIN
  -- 1. NOTHING THAT WAS INSIDE TOLERANCE FALLS OUTSIDE IT. This is the whole
  --    risk of the change: a fix for false alerts that mints different ones.
  SELECT count(*) INTO v_regressed
    FROM zz_delta_before b
   WHERE abs(b.delta) <= v_tol
     AND abs(public.fn_tournament_conservation_delta(b.id)) > v_tol;
  IF v_regressed <> 0 THEN
    RAISE EXCEPTION 'post-condition: % tournament(s) inside tolerance before are outside it now', v_regressed;
  END IF;

  -- 2. THE TWO PRE-TICKET-ERA ALERTS ARE NOT TOUCHED. Compared before/after,
  --    never against a literal, so this cannot go stale or quietly pass.
  SELECT count(*) INTO v_changed
    FROM zz_delta_before b
   WHERE b.id IN ('a449e853-4ee1-4e36-bd38-8fe904664d7c',
                  'f7412940-5644-4194-8d57-4a97c182bf04')
     AND b.delta IS DISTINCT FROM public.fn_tournament_conservation_delta(b.id);
  IF v_changed <> 0 THEN
    RAISE EXCEPTION 'post-condition: this migration moved % Sunday $200 Deep Stack delta(s); it must move neither', v_changed;
  END IF;

  -- 3. THE DELTA MOVED BY EXACTLY WHAT THE SMALL TABLES SAY IT SHOULD.
  --    The expected move is computed here from tournament_payouts /
  --    tournament_satellite_awards / tournament_tickets alone; the actual move
  --    comes from the rewritten function. If a cash delivery or a cancelled
  --    ticket were still being counted as a seat, or a legacy award-less seat
  --    had been dropped, the two would disagree for that tournament.
  SELECT count(*) INTO v_mismatched
    FROM zz_delta_before b
    LEFT JOIN (
      WITH f AS (
        SELECT sp.tournament_id,
               (sp.metadata->>'satellite_target_id')::uuid AS target_id,
               sp.amount,
               (sp.source = 'satellite_seat') AS counted_before,
               (COALESCE(a.delivery_kind,'seat') IN ('seat','ticket')
                AND COALESCE(k.status,'issued') IN ('issued','redeemed')) AS paid_after,
               (COALESCE(a.delivery_kind,'seat') IN ('seat','ticket')
                AND (k.id IS NULL OR k.status = 'redeemed')) AS income_after
          FROM public.tournament_payouts sp
          LEFT JOIN public.tournament_satellite_awards a
                 ON a.tournament_id = sp.tournament_id AND a.place = sp.position
          LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
         WHERE sp.source IN ('satellite_seat','satellite_ticket')
      ),
      paid AS (
        SELECT tournament_id AS id,
               COALESCE(sum(amount) FILTER (WHERE paid_after), 0)
             - COALESCE(sum(amount) FILTER (WHERE counted_before), 0) AS d
          FROM f GROUP BY 1
      ),
      inc AS (
        SELECT target_id AS id,
               COALESCE(sum(amount) FILTER (WHERE income_after), 0)
             - COALESCE(sum(amount) FILTER (WHERE counted_before), 0) AS d
          FROM f WHERE target_id IS NOT NULL GROUP BY 1
      )
      SELECT COALESCE(paid.id, inc.id) AS id,
             round(COALESCE(inc.d, 0) - COALESCE(paid.d, 0), 2) AS expected
        FROM paid FULL OUTER JOIN inc ON inc.id = paid.id
    ) e ON e.id = b.id
   WHERE round(public.fn_tournament_conservation_delta(b.id) - b.delta, 2)
         IS DISTINCT FROM COALESCE(e.expected, 0);
  IF v_mismatched <> 0 THEN
    RAISE EXCEPTION 'post-condition: % tournament(s) moved by an amount the payout tables do not account for', v_mismatched;
  END IF;

  -- 4. AND THE FIX ACTUALLY DOES SOMETHING. A predicate that excludes
  --    everything would satisfy 1-3 perfectly.
  SELECT count(*) INTO v_tickets_counted
    FROM public.tournament_payouts sp
    JOIN public.tournament_satellite_awards a
      ON a.tournament_id = sp.tournament_id AND a.place = sp.position
    LEFT JOIN public.tournament_tickets k ON k.id = a.ticket_id
   WHERE sp.source = 'satellite_ticket'
     AND COALESCE(a.delivery_kind, 'seat') IN ('seat','ticket')
     AND COALESCE(k.status, 'issued') IN ('issued','redeemed');
  IF v_tickets_counted = 0 THEN
    RAISE EXCEPTION 'post-condition: no ticket-delivered seat is counted; the fix is inert';
  END IF;

  SELECT count(*) INTO v_healed
    FROM zz_delta_before b
   WHERE abs(b.delta) > v_tol
     AND abs(public.fn_tournament_conservation_delta(b.id)) <= v_tol;

  RAISE NOTICE 'conservation delta: % ticket seat(s) now visible; % flagged tournament(s) back inside tolerance; 0 regressions',
    v_tickets_counted, v_healed;
END
$assert$;

COMMIT;
